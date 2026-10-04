import path from 'node:path';
import { fs } from 'zx';
import fg from 'fast-glob';
import type { PackageJson } from 'type-fest';
import { PlatformPackager } from './platform.js';
import {
  LOCK_FILES,
  createIgnorePatterns,
  logStep,
  normalizeArch,
  normalizePlatform,
  toPosixPath,
  toWindowsPath,
  type TargetPlatform
} from './utility.js';
import { ProgressRenderer } from './progress.js';
import { WorkspaceStager } from './workspace.js';
import {
  DependencyCopier,
  type ProjectFilesCopyInput
} from './dependencies.js';

interface PackProjectInput {
  projectFolder?: string;
  targetPlatform?: string;
  arch?: string;
  nodeVersion?: string;
  outputName?: string;
  compressionLevel?: number;
}

interface ProjectPackagerContext {
  sourceFolder: string;
  sourcePackage: PackageJson;
  packageName: string;
  packageBaseName: string;
  platform: TargetPlatform;
  runtimeArch: string;
  nodeVersion?: string;
  nodePath?: string;
  outputName?: string;
  compressionLevel: number;
  tempRoot: string;
  appFolder: string;
  runtimeFolder: string;
  outputFolder: string;
}

class ProjectPackager {
  private readonly dependencyCopier = new DependencyCopier(input =>
    this.copyProjectFiles(input)
  );
  private readonly workspaceStager = new WorkspaceStager(
    input => this.copyProjectFiles(input),
    appFolder => this.platformPackager.installProductionDependencies(appFolder),
    this.dependencyCopier
  );

  constructor(
    private readonly context: ProjectPackagerContext,
    private readonly platformPackager = new PlatformPackager()
  ) {}

  async pack() {
    const { tempRoot, appFolder, outputFolder, packageName } = this.context;

    await fs.remove(tempRoot);
    await fs.ensureDir(appFolder);
    await fs.ensureDir(outputFolder);

    await this.stageApplication();

    const runtimeVersion = await this.installRuntime();

    await this.createLaunchers();

    const outputFile = await this.packageBundle();

    return { outputFile, packageName, tempRoot, runtimeVersion };
  }

  @logStep('stage application files')
  async stageApplication() {
    const { sourceFolder, sourcePackage, appFolder, tempRoot } = this.context;

    const stagedWorkspacePackage = await this.workspaceStager.stagePackage({
      sourceFolder,
      sourcePackage,
      appFolder
    });

    if (!stagedWorkspacePackage) {
      const stagedPackageFolder = path.join(tempRoot, 'project');

      try {
        await this.copyProjectFiles({
          sourceFolder,
          appFolder: stagedPackageFolder,
          sourcePackage
        });
        await this.platformPackager.installProductionDependencies(
          stagedPackageFolder
        );
        await this.dependencyCopier.copyPackage({
          sourceFolder: stagedPackageFolder,
          appFolder,
          sourcePackage
        });
        await this.copyProjectFiles({ sourceFolder, appFolder, sourcePackage });
      } finally {
        await fs.remove(stagedPackageFolder);
      }
    }
  }

  @logStep('install Node.js runtime')
  async installRuntime() {
    const { sourcePackage, nodeVersion, runtimeFolder, platform, runtimeArch } =
      this.context;
    const version = await this.platformPackager.resolveNodeVersion({
      sourcePackage,
      overrideVersion: nodeVersion
    });

    this.context.nodePath = await this.platformPackager.installNodeRuntime({
      version,
      runtimeFolder,
      platform,
      arch: runtimeArch
    });

    return version;
  }

  @logStep('create launchers')
  async createLaunchers() {
    const { tempRoot, sourcePackage, nodePath, platform, packageName } =
      this.context;

    if (!nodePath)
      throw new Error(
        'Node runtime must be installed before creating launchers'
      );
    if (!sourcePackage.bin) throw new Error('package.json bin is required');

    const entries =
      typeof sourcePackage.bin === 'string'
        ? [[packageName || 'app', sourcePackage.bin]]
        : Object.entries(sourcePackage.bin);
    const archiveRoot = path.join(tempRoot, '../..');
    const nodeRelativePath = path.relative(archiveRoot, nodePath);
    const nodeModulesRelativePath = path.relative(
      archiveRoot,
      path.join(tempRoot, 'app/node_modules')
    );
    const runtimeBinRelativePath = path.relative(
      archiveRoot,
      path.dirname(nodePath)
    );

    for (const [name, target] of entries) {
      const targetRelativePath = path.relative(
        archiveRoot,
        path.join(tempRoot, 'app', target!)
      );

      if (platform === 'win')
        await fs.outputFile(
          path.join(archiveRoot, `${name}.cmd`),
          `@echo off
set "PATH=%~dp0${toWindowsPath(runtimeBinRelativePath)};%PATH%"
set "NODE_PATH=%~dp0${toWindowsPath(nodeModulesRelativePath)};%NODE_PATH%"
"%~dp0${toWindowsPath(nodeRelativePath)}" "%~dp0${toWindowsPath(targetRelativePath)}" %*
`.replace(/\n/g, '\r\n')
        );

      const nodeModulesPath = `$ROOT_DIR/${toPosixPath(nodeModulesRelativePath)}`;
      const nodePathValue =
        platform === 'win'
          ? `$(cygpath -w "${nodeModulesPath}")\${NODE_PATH:+;$NODE_PATH}`
          : `${nodeModulesPath}\${NODE_PATH:+:$NODE_PATH}`;
      const scriptPath = path.join(archiveRoot, name);

      await fs.outputFile(
        scriptPath,
        `#!/bin/sh
ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export PATH="$ROOT_DIR/${toPosixPath(runtimeBinRelativePath)}:$PATH"
export NODE_PATH="${nodePathValue}"
exec "$ROOT_DIR/${toPosixPath(nodeRelativePath)}" "$ROOT_DIR/${toPosixPath(targetRelativePath)}" "$@"
`
      );
      await fs.chmod(scriptPath, 0o755);
    }

    await this.createInstallScript();
  }

  @logStep('package bundle')
  async packageBundle() {
    const {
      outputName,
      packageBaseName,
      outputFolder,
      platform,
      tempRoot,
      appFolder,
      compressionLevel
    } = this.context;
    const outputBaseName = outputName || packageBaseName;
    const outputFile = path.join(
      outputFolder,
      platform === 'win' ? `${outputBaseName}.exe` : outputBaseName
    );
    const archiveRoot = path.resolve(tempRoot, '../..');

    const installScriptPath = path.join(
      path.dirname(appFolder),
      `install.${platform === 'win' ? 'cmd' : 'sh'}`
    );

    if (platform === 'win')
      await this.platformPackager.packageWith7Zip({
        tempRoot: archiveRoot,
        outputFile,
        installScript: toWindowsPath(
          path.relative(archiveRoot, installScriptPath)
        ),
        compressionLevel
      });
    else {
      const installScript = `./${toPosixPath(
        path.relative(archiveRoot, installScriptPath)
      )}`;

      await this.platformPackager.packageWithMakeself({
        tempRoot: archiveRoot,
        outputFile,
        installScript,
        compressionLevel
      });
    }

    return outputFile;
  }

  @logStep(
    (
      _that: ProjectPackager,
      { sourceFolder, appFolder }: ProjectFilesCopyInput
    ) =>
      `copy project files: ${path.basename(sourceFolder)} -> ${path.basename(appFolder)}`
  )
  private async copyProjectFiles({
    sourceFolder,
    appFolder,
    sourcePackage
  }: ProjectFilesCopyInput) {
    const entries = new Set(['package.json', '.npmrc', 'pnpm-workspace.yaml']);
    const patterns =
      Array.isArray(sourcePackage.files) && sourcePackage.files.length > 0
        ? sourcePackage.files
        : ['**/*'];
    const ignorePatterns = await createIgnorePatterns(sourceFolder);

    for (const lockFile of LOCK_FILES)
      if (await fs.pathExists(path.join(sourceFolder, lockFile)))
        entries.add(lockFile);

    for (const pattern of patterns)
      if (await fs.pathExists(path.join(sourceFolder, pattern)))
        entries.add(pattern);

    for (const item of await fg(patterns, {
      cwd: sourceFolder,
      dot: true,
      onlyFiles: false,
      ignore: ignorePatterns
    }))
      entries.add(item);

    const progressRenderer = new ProgressRenderer(
      'Copying project files',
      'items'
    );
    let copied = 0;

    try {
      for (const relativePath of entries) {
        const sourcePath = path.join(sourceFolder, relativePath);

        if (await fs.pathExists(sourcePath)) {
          await fs.copy(sourcePath, path.join(appFolder, relativePath));

          progressRenderer.update(++copied, entries.size);
        }
      }
    } finally {
      progressRenderer.close();
    }
  }

  private async createInstallScript() {
    const { appFolder, nodePath, platform, tempRoot } = this.context;
    if (!nodePath)
      throw new Error(
        'Node runtime must be installed before creating the install script'
      );

    const scriptRoot = path.dirname(appFolder);
    const extension = platform === 'win' ? 'cmd' : 'sh';
    const scriptPath = path.join(scriptRoot, `install.${extension}`);
    const archiveRoot = path.resolve(tempRoot, '../..');

    if (platform === 'win') {
      const archiveRelativePath = toWindowsPath(
        path.relative(scriptRoot, archiveRoot)
      );
      const appRelativePath = toWindowsPath(
        path.relative(archiveRoot, appFolder)
      );
      const runtimeRelativePath = toWindowsPath(
        path.relative(archiveRoot, path.dirname(nodePath))
      );

      await fs.outputFile(
        scriptPath,
        `@echo off
robocopy "%~dp0${archiveRelativePath}" "%USERPROFILE%" /E /XF install.cmd /NFL /NDL /NJH /NJS
if %ERRORLEVEL% GEQ 8 exit /b %ERRORLEVEL%
echo Package extracted to %USERPROFILE%
set "PATH=%USERPROFILE%\\${runtimeRelativePath};%PATH%"
cd /d "%USERPROFILE%\\${appRelativePath}"
call npm run install --if-present
if errorlevel 1 exit /b %ERRORLEVEL%
exit /b 0
`.replace(/\n/g, '\r\n')
      );
      return;
    }

    const runtimeBin = toPosixPath(
      path.relative(scriptRoot, path.dirname(nodePath))
    );

    await fs.outputFile(
      scriptPath,
      `#!/bin/sh
set -e
printf "Package extracted to %s\\n" "$(pwd)"
ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export PATH="$ROOT_DIR/${runtimeBin}:$PATH"
cd "$ROOT_DIR/app"
npm run install --if-present
`
    );
    await fs.chmod(scriptPath, 0o755);
  }
}

export async function packProject({
  projectFolder = process.cwd(),
  targetPlatform = process.platform,
  arch = process.arch,
  nodeVersion,
  outputName,
  compressionLevel = 0
}: PackProjectInput = {}) {
  if (
    !Number.isInteger(compressionLevel) ||
    compressionLevel < 0 ||
    compressionLevel > 9
  )
    throw new Error('Compression level must be an integer from 0 to 9');

  const sourceFolder = path.resolve(projectFolder);
  const sourcePackage = (await fs.readJSON(
    path.join(sourceFolder, 'package.json')
  )) as PackageJson;
  const packageName = sourcePackage.name?.trim();

  if (!packageName) throw new Error('package.json name is required');

  const packageBaseName = packageName.replace(/[@/]+/g, '-');
  const platform = normalizePlatform(targetPlatform);
  const runtimeArch = normalizeArch(arch, platform);
  const tempRoot = path.join(
    sourceFolder,
    '.temp/npm2exe-apps',
    packageBaseName
  );
  const context: ProjectPackagerContext = {
    sourceFolder,
    sourcePackage,
    packageName,
    packageBaseName,
    platform,
    runtimeArch,
    nodeVersion,
    outputName,
    compressionLevel,
    tempRoot,
    appFolder: path.join(tempRoot, 'app'),
    runtimeFolder: path.join(tempRoot, 'runtime'),
    outputFolder: path.join(sourceFolder, 'out')
  };
  return new ProjectPackager(context).pack();
}

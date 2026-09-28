import path from 'node:path';
import { fs } from 'zx';
import fg from 'fast-glob';
import semver from 'semver';
import type { PackageJson } from 'type-fest';
import {
  normalizeArch,
  normalizePlatform,
  PlatformPackager,
  type TargetPlatform
} from './platform.js';
import {
  LOCK_FILES,
  logStep,
  normalizeVersion,
  toPosixPath,
  toWindowsPath
} from './utility.js';
import { WorkspaceStager, type ProjectFilesCopyInput } from './workspace.js';

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
  private readonly workspaceStager = new WorkspaceStager(
    input => this.copyProjectFiles(input),
    appFolder => this.platformPackager.installProductionDependencies(appFolder)
  );

  constructor(
    private readonly context: ProjectPackagerContext,
    private readonly platformPackager = new PlatformPackager()
  ) {}

  async pack() {
    await fs.remove(this.context.tempRoot);
    await fs.ensureDir(this.context.appFolder);
    await fs.ensureDir(this.context.outputFolder);

    await this.stageApplication();

    const runtimeVersion = await this.installRuntime();

    await this.createLaunchers();

    const outputFile = await this.packageBundle();

    return {
      outputFile,
      packageName: this.context.packageName,
      tempRoot: this.context.tempRoot,
      runtimeVersion
    };
  }

  @logStep('stage application files')
  async stageApplication() {
    const stagedWorkspacePackage = await this.workspaceStager.stagePackage({
      sourceFolder: this.context.sourceFolder,
      sourcePackage: this.context.sourcePackage,
      appFolder: this.context.appFolder
    });

    if (!stagedWorkspacePackage) {
      await this.copyProjectFiles({
        sourceFolder: this.context.sourceFolder,
        appFolder: this.context.appFolder,
        sourcePackage: this.context.sourcePackage
      });
      await this.platformPackager.installProductionDependencies(
        this.context.appFolder
      );
    }
  }

  @logStep('install node runtime')
  async installRuntime() {
    const version = await resolveNodeVersion({
      sourcePackage: this.context.sourcePackage,
      overrideVersion: this.context.nodeVersion
    });

    this.context.nodePath = await this.platformPackager.installNodeRuntime({
      version,
      runtimeFolder: this.context.runtimeFolder,
      platform: this.context.platform,
      arch: this.context.runtimeArch
    });

    return version;
  }

  @logStep('create launchers')
  async createLaunchers() {
    if (!this.context.nodePath)
      throw new Error(
        'Node runtime must be installed before creating launchers'
      );

    const { tempRoot, sourcePackage, nodePath, platform } = this.context;

    if (!sourcePackage.bin) return;

    const entries =
      typeof sourcePackage.bin === 'string'
        ? [[sourcePackage.name || 'app', sourcePackage.bin]]
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

      if (platform === 'win') {
        await fs.outputFile(
          path.join(archiveRoot, `${name}.cmd`),
          `@echo off
set "PATH=%~dp0${toWindowsPath(runtimeBinRelativePath)};%PATH%"
set "NODE_PATH=%~dp0${toWindowsPath(nodeModulesRelativePath)};%NODE_PATH%"
"%~dp0${toWindowsPath(nodeRelativePath)}" "%~dp0${toWindowsPath(targetRelativePath)}" %*
`.replace(/\n/g, '\r\n')
        );
      }

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

    if (platform !== 'win') await this.createInstallScript();
  }

  @logStep('package bundle')
  async packageBundle() {
    const outputBaseName =
      this.context.outputName || this.context.packageBaseName;
    const outputFile = path.join(
      this.context.outputFolder,
      this.context.platform === 'win' ? `${outputBaseName}.exe` : outputBaseName
    );

    if (this.context.platform === 'win') {
      await this.platformPackager.packageWith7Zip({
        tempRoot: path.join(this.context.sourceFolder, '.temp'),
        outputFile,
        compressionLevel: this.context.compressionLevel
      });
    } else {
      const archiveRoot = path.join(this.context.sourceFolder, '.temp');
      const installScript = `./${toPosixPath(
        path.relative(
          archiveRoot,
          path.join(this.context.tempRoot, 'install.sh')
        )
      )}`;

      await this.platformPackager.packageWithMakeself({
        tempRoot: archiveRoot,
        outputFile,
        installScript,
        compressionLevel: this.context.compressionLevel
      });
    }

    return outputFile;
  }

  private async copyProjectFiles({
    sourceFolder,
    appFolder,
    sourcePackage
  }: ProjectFilesCopyInput) {
    const entries = new Set(['package.json', '.npmrc', 'pnpm-workspace.yaml']);

    for (const lockFile of LOCK_FILES)
      if (await fs.pathExists(path.join(sourceFolder, lockFile)))
        entries.add(lockFile);

    const patterns =
      Array.isArray(sourcePackage.files) && sourcePackage.files.length > 0
        ? sourcePackage.files
        : ['**/*'];

    for (const item of await fg(patterns, {
      cwd: sourceFolder,
      dot: true,
      onlyFiles: false,
      ignore: ['.git/**', '.temp/**', 'out/**', 'node_modules/**']
    }))
      entries.add(item);

    for (const relativePath of entries) {
      const sourcePath = path.join(sourceFolder, relativePath);

      if (await fs.pathExists(sourcePath))
        await fs.copy(sourcePath, path.join(appFolder, relativePath));
    }
  }

  private async createInstallScript() {
    const scriptPath = path.join(this.context.tempRoot, 'install.sh');

    await fs.outputFile(
      scriptPath,
      `#!/bin/sh
set -e
printf "Package extracted to %s\\n" "$(pwd)"
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

  const packageBaseName = packageName.replace(/\//g, '__');
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
  const packager = new ProjectPackager(context);

  return packager.pack();
}

export async function resolveNodeVersion({
  sourcePackage = {},
  overrideVersion
}: {
  sourcePackage?: PackageJson;
  overrideVersion?: string;
}) {
  if (overrideVersion) return normalizeVersion(overrideVersion);

  const response = await fetch('https://nodejs.org/dist/index.json');

  if (!response.ok)
    throw new Error(`Failed to fetch node versions: ${response.status}`);

  const index = (await response.json()) as { version: string }[];
  const range = sourcePackage.engines?.node;

  if (range) {
    const matched = semver.maxSatisfying(
      index.map(({ version }) => version),
      range
    );

    if (matched) return matched;
  }

  const latest = index[0]?.version;

  if (latest) return latest;

  throw new Error('No node versions available from nodejs.org index');
}

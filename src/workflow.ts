import os from 'node:os';
import path from 'node:path';
import { $, fs, usePowerShell } from 'zx';
import fg from 'fast-glob';
import semver from 'semver';
import type { PackageJson } from 'type-fest';
import {
  LOCK_FILES,
  TargetPlatform,
  findLatestReleaseAsset,
  getExtractionCommand,
  normalizeArch,
  normalizePlatform,
  normalizeVersion,
  toPosixPath,
  toWindowsPath
} from './utility.js';
import { stageWorkspacePackage } from './workspace.js';
import type { ProjectFilesCopyInput } from './workspace.js';

if (process.platform === 'win32')
  if (typeof $.shell === 'string')
    // zx only sets `$.shell` to a path when it finds bash on PATH
    // zx's default `$'...'` quoting loses backslashes of Windows paths when passed to MSYS bash
    $.quote = arg => `'${arg.replace(/'/g, `'\\''`)}'`;
  else {
    usePowerShell();
    // PowerShell can't invoke a quoted executable path without the call operator
    $.prefix = '& ';
  }

const INSTALLERS = [
  {
    name: 'pnpm',
    attempts: [
      [
        'install',
        '--prod',
        '--frozen-lockfile',
        '--package-import-method=copy',
        '--node-linker=hoisted'
      ],
      [
        'install',
        '--prod',
        '--package-import-method=copy',
        '--node-linker=hoisted'
      ]
    ]
  },
  {
    name: 'yarn',
    attempts: [
      ['install', '--production', '--frozen-lockfile'],
      ['install', '--production']
    ]
  },
  { name: 'npm', attempts: [['install', '--omit=dev']] }
] as const;

interface PackProjectInput {
  projectFolder?: string;
  targetPlatform?: string;
  arch?: string;
  nodeVersion?: string;
  outputName?: string;
}

export async function packProject({
  projectFolder = process.cwd(),
  targetPlatform = process.platform,
  arch = process.arch,
  nodeVersion,
  outputName
}: PackProjectInput = {}) {
  const sourceFolder = path.resolve(projectFolder);
  const sourcePackage = (await fs.readJSON(
    path.join(sourceFolder, 'package.json')
  )) as PackageJson;
  const packageName = sourcePackage.name?.trim();

  if (!packageName) throw new Error('package.json name is required');

  const platform = normalizePlatform(targetPlatform);
  const runtimeArch = normalizeArch(arch, platform);
  const tempRoot = path.join(sourceFolder, '.temp/npm2exe-apps', packageName);
  const appFolder = path.join(tempRoot, 'app');
  const runtimeFolder = path.join(tempRoot, 'runtime');
  const outputFolder = path.join(sourceFolder, 'out');

  await fs.remove(tempRoot);
  await fs.ensureDir(appFolder);
  await fs.ensureDir(outputFolder);

  const stagedWorkspacePackage = await stageWorkspacePackage({
    sourceFolder,
    sourcePackage,
    appFolder,
    copyProjectFiles,
    installProductionDependencies
  });

  if (!stagedWorkspacePackage) {
    await copyProjectFiles({ sourceFolder, appFolder, sourcePackage });
    await installProductionDependencies(appFolder);
  }

  const version = await resolveNodeVersion({
    sourcePackage,
    overrideVersion: nodeVersion
  });
  const nodePath = await installNodeRuntime({
    version,
    runtimeFolder,
    platform,
    arch: runtimeArch
  });

  await createLaunchers({
    tempRoot,
    sourcePackage,
    nodePath,
    platform
  });
  if (platform !== 'win') await createInstallScript(tempRoot);

  const outputBaseName = outputName || packageName;
  const outputFile = path.join(
    outputFolder,
    platform === 'win' ? `${outputBaseName}.exe` : outputBaseName
  );

  if (platform === 'win') {
    await packageWith7Zip(path.join(sourceFolder, '.temp'), outputFile);
  } else {
    const archiveRoot = path.join(sourceFolder, '.temp');
    const installScript = `./${toPosixPath(path.relative(archiveRoot, path.join(tempRoot, 'install.sh')))}`;

    await packageWithMakeself(archiveRoot, outputFile, installScript);
  }
  return { outputFile, packageName, tempRoot, runtimeVersion: version };
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

async function copyProjectFiles({
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
    const from = path.join(sourceFolder, relativePath);

    if (await fs.pathExists(from))
      await fs.copy(from, path.join(appFolder, relativePath));
  }
}

export async function installProductionDependencies(appFolder: string) {
  const installers = await resolveInstallersByLockFile(appFolder);

  for (const installer of installers) {
    const runner = await resolveRunner(installer.name);
    if (!runner) {
      if (installers.length === 1)
        throw new Error(
          `${installer.name} is required for the detected lock file`
        );
      continue;
    }
    for (const args of installer.attempts)
      try {
        await runCommand(runner, args, appFolder);
        return;
      } catch {
        // fallback next attempt
      }
  }
  throw new Error(
    'No package manager succeeded for production dependency installation'
  );
}

async function resolveInstallersByLockFile(appFolder: string) {
  if (await fs.pathExists(path.join(appFolder, 'pnpm-lock.yaml')))
    return [INSTALLERS[0]];

  if (await fs.pathExists(path.join(appFolder, 'yarn.lock')))
    return [INSTALLERS[1]];
  if (
    (await fs.pathExists(path.join(appFolder, 'package-lock.json'))) ||
    (await fs.pathExists(path.join(appFolder, 'npm-shrinkwrap.json')))
  )
    return [INSTALLERS[2]];

  return INSTALLERS;
}

async function commandExists(command: string): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      await $`where.exe ${command}`;
    } else {
      await $`which ${command}`;
    }
    return true;
  } catch {
    return false;
  }
}

async function resolveRunner(name: string) {
  if (await commandExists(name)) return { command: name, args: [] as string[] };

  if ((name === 'pnpm' || name === 'yarn') && (await commandExists('corepack')))
    return { command: 'corepack', args: [name] };

  return null;
}

const runCommand = async (
  runner: { command: string; args: string[] },
  args: readonly string[],
  cwd: string
) =>
  $({
    cwd,
    stdio: 'inherit'
  })`${runner.command} ${[...runner.args, ...args]}`;

async function installNodeRuntime({
  version,
  runtimeFolder,
  platform,
  arch
}: {
  version: string;
  runtimeFolder: string;
  platform: TargetPlatform;
  arch: string;
}) {
  const extension =
    platform === 'win' ? 'zip' : platform === 'darwin' ? 'tar.gz' : 'tar.xz';
  const fileName = `node-${version}-${platform}-${arch}.${extension}`;
  const archiveUrl = `https://nodejs.org/dist/${version}/${fileName}`;
  const archivePath = path.join(os.tmpdir(), fileName);

  await downloadFile(archiveUrl, archivePath);
  await fs.remove(runtimeFolder);
  await fs.ensureDir(runtimeFolder);
  await extractArchive({ extension, archivePath, runtimeFolder, platform });

  const binaryName = platform === 'win' ? 'node.exe' : 'node';
  const distFolder = path.join(
    runtimeFolder,
    `node-${version}-${platform}-${arch}`
  );
  const preferred =
    platform === 'win'
      ? path.join(distFolder, binaryName)
      : path.join(distFolder, 'bin', binaryName);

  if (await fs.pathExists(preferred)) return preferred;

  const matches = await fg(`**/${binaryName}`, {
    cwd: runtimeFolder,
    absolute: true,
    onlyFiles: true
  });
  if (!matches.length)
    throw new Error('Node runtime binary not found after extraction');

  matches.sort();

  return matches[0];
}

async function downloadFile(url: string, target: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${url}`);

  const content = Buffer.from(await response.arrayBuffer());
  await fs.outputFile(target, content);
}

async function extractArchive({
  extension,
  archivePath,
  runtimeFolder,
  platform
}: {
  extension: string;
  archivePath: string;
  runtimeFolder: string;
  platform: TargetPlatform;
}) {
  if (getExtractionCommand(extension) === 'tar')
    return $`tar -xf ${archivePath} -C ${runtimeFolder}`;

  if (platform === 'win' && (await commandExists('powershell')))
    return $`powershell -NoProfile -Command Expand-Archive -Path ${archivePath} -DestinationPath ${runtimeFolder} -Force`;

  if (await commandExists('python'))
    return $`python -m zipfile -e ${archivePath} ${runtimeFolder}`;

  await $`unzip -q -o ${archivePath} -d ${runtimeFolder}`;
}

async function createLaunchers({
  tempRoot,
  sourcePackage,
  nodePath,
  platform
}: {
  tempRoot: string;
  sourcePackage: PackageJson;
  nodePath: string;
  platform: TargetPlatform;
}) {
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
      path.join(tempRoot, 'app', target)
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
    // Windows node.exe expects native paths joined by `;` in NODE_PATH
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
}

async function createInstallScript(tempRoot: string) {
  const scriptPath = path.join(tempRoot, 'install.sh');
  await fs.outputFile(
    scriptPath,
    `#!/bin/sh
set -e
printf "Package extracted to %s\\n" "$(pwd)"
`
  );
  await fs.chmod(scriptPath, 0o755);
}

async function installMakeself() {
  const makeselfFolder = path.join(os.tmpdir(), 'npm2exe-makeself');
  const makeselfPath = path.join(makeselfFolder, 'makeself.sh');

  await fs.ensureDir(makeselfFolder);

  const asset = await findLatestReleaseAsset(
    'megastep/makeself',
    /^makeself-.+\.run$/
  );
  const archivePath = path.join(os.tmpdir(), asset.name);

  await downloadFile(asset.browser_download_url, archivePath);
  await fs.chmod(archivePath, 0o755);
  await $`${archivePath} --noexec --target ${makeselfFolder}`;

  return makeselfPath;
}

async function packageWithMakeself(
  tempRoot: string,
  outputFile: string,
  installScript: string
) {
  const makeselfFolder = path.join(os.tmpdir(), 'npm2exe-makeself');
  const makeselfPath = path.join(makeselfFolder, 'makeself.sh');
  const headerPath = path.join(makeselfFolder, 'makeself-header.sh');

  if (
    !(await fs.pathExists(makeselfPath)) ||
    !(await fs.pathExists(headerPath))
  )
    await installMakeself();

  await $`${makeselfPath} --nocomp --target '$HOME' ${tempRoot} ${outputFile} "npm2exe bundle" ${installScript}`;
}

async function installSFXModule() {
  const { path7z } = await import('7zip-bin-full');
  const sfxFolder = path.join(os.tmpdir(), 'npm2exe-7zip');
  const sfxPath = path.join(sfxFolder, '7zSD.sfx');

  if (await fs.pathExists(sfxPath)) return sfxPath;

  // SFX modules for installers ship in the LZMA SDK
  const asset = await findLatestReleaseAsset('ip7z/7zip', /^lzma\d+\.7z$/);
  const archivePath = path.join(os.tmpdir(), asset.name);

  await downloadFile(asset.browser_download_url, archivePath);
  await $`${path7z} e ${archivePath} ${`-o${sfxFolder}`} bin/7zSD.sfx -y`;

  return sfxPath;
}

async function packageWith7Zip(tempRoot: string, outputFile: string) {
  const { path7z } = await import('7zip-bin-full');
  const sfxPath = await installSFXModule();
  const archivePath = path.join(os.tmpdir(), 'npm2exe-archive.7z');

  // 7zSD.sfx extracts to a temporary folder, runs this script there, then removes the folder
  await fs.outputFile(
    path.join(tempRoot, 'install.cmd'),
    `@echo off
robocopy "%~dp0." "%USERPROFILE%" /E /XF install.cmd /NFL /NDL /NJH /NJS
if %ERRORLEVEL% GEQ 8 exit /b %ERRORLEVEL%
echo Package extracted to %USERPROFILE%
exit /b 0
`.replace(/\n/g, '\r\n')
  );
  await fs.remove(archivePath);
  await $({
    cwd: tempRoot
  })`${path7z} a -t7z -mx=9 ${archivePath} .`;

  const config = `;!@Install@!UTF-8!
Title="${path.basename(outputFile, '.exe')}"
Directory=""
RunProgram="cmd.exe /c install.cmd"
;!@InstallEnd@!
`;
  return fs.outputFile(
    outputFile,
    Buffer.concat([
      await fs.readFile(sfxPath),
      Buffer.from(config),
      await fs.readFile(archivePath)
    ])
  );
}

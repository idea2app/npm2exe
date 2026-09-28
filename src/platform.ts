import os from 'node:os';
import path from 'node:path';
import { $, fs, usePowerShell } from 'zx';
import fg from 'fast-glob';
import { DownloadService } from './download.js';
import { getExtractionCommand } from './utility.js';

export type TargetPlatform = 'linux' | 'darwin' | 'win';

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

const configureShell = () => {
  if (process.platform !== 'win32') return;

  if (typeof $.shell === 'string')
    $.quote = arg => `'${arg.replace(/'/g, `'\\''`)}'`;
  else {
    usePowerShell();
    $.prefix = '& ';
  }
};

configureShell();

export const normalizePlatform = (platform: string): TargetPlatform => {
  if (platform === 'win32' || platform === 'win') return 'win';
  if (platform === 'darwin') return 'darwin';
  if (platform === 'linux') return 'linux';

  throw new Error(`Unsupported platform: ${platform}`);
};

export const normalizeArch = (
  arch: string,
  platform: TargetPlatform
): string => {
  if (arch === 'x64' || arch === 'arm64') return arch;
  if (arch === 'arm') return 'armv7l';
  if (arch === 'ia32' || arch === 'x86') {
    if (platform !== 'win')
      throw new Error(`${arch} is only supported for Windows targets`);

    return 'x86';
  }

  throw new Error(`Unsupported architecture: ${arch}`);
};

export class PlatformPackager {
  constructor(private readonly downloadService = new DownloadService()) {}

  async installProductionDependencies(appFolder: string) {
    const installers = await this.resolveInstallersByLockFile(appFolder);

    for (const installer of installers) {
      const runner = await this.resolveRunner(installer.name);

      if (!runner) {
        if (installers.length === 1)
          throw new Error(
            `${installer.name} is required for the detected lock file`
          );

        continue;
      }

      for (const args of installer.attempts)
        try {
          await this.runCommand(runner, args, appFolder);
          return;
        } catch {
          // fallback next attempt
        }
    }

    throw new Error(
      'No package manager succeeded for production dependency installation'
    );
  }

  async installNodeRuntime({
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

    await this.downloadService.downloadFile(
      archiveUrl,
      archivePath,
      `Downloading ${fileName}`
    );
    await fs.remove(runtimeFolder);
    await fs.ensureDir(runtimeFolder);
    await this.extractArchive({
      extension,
      archivePath,
      runtimeFolder,
      platform
    });

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

  async packageWithMakeself({
    tempRoot,
    outputFile,
    installScript,
    compressionLevel = 0
  }: {
    tempRoot: string;
    outputFile: string;
    installScript: string;
    compressionLevel?: number;
  }) {
    const makeselfFolder = path.join(os.tmpdir(), 'npm2exe-makeself');
    const makeselfPath = path.join(makeselfFolder, 'makeself.sh');
    const headerPath = path.join(makeselfFolder, 'makeself-header.sh');

    if (
      !(await fs.pathExists(makeselfPath)) ||
      !(await fs.pathExists(headerPath))
    )
      await this.installMakeself();

    const compressArgs = compressionLevel
      ? ['--gzip', '--complevel', String(compressionLevel)]
      : ['--nocomp'];
    const targetDirectory = '$HOME';

    return $`${makeselfPath} ${compressArgs} --target ${targetDirectory} ${tempRoot} ${outputFile} "npm2exe bundle" ${installScript}`;
  }

  async packageWith7Zip({
    tempRoot,
    outputFile,
    compressionLevel = 0
  }: {
    tempRoot: string;
    outputFile: string;
    compressionLevel?: number;
  }) {
    const { path7z } = await import('7zip-bin-full');
    const sfxPath = await this.installSFXModule();
    const archivePath = path.join(os.tmpdir(), 'npm2exe-archive.7z');

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
    })`${path7z} a -t7z -mx=${compressionLevel} ${archivePath} .`;

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

  private async resolveInstallersByLockFile(appFolder: string) {
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

  private async commandExists(command: string): Promise<boolean> {
    try {
      if (process.platform === 'win32') await $`where.exe ${command}`;
      else await $`which ${command}`;

      return true;
    } catch {
      return false;
    }
  }

  private async resolveRunner(name: string) {
    if (await this.commandExists(name))
      return { command: name, args: [] as string[] };

    if (
      (name === 'pnpm' || name === 'yarn') &&
      (await this.commandExists('corepack'))
    )
      return { command: 'corepack', args: [name] };

    return null;
  }

  private runCommand(
    runner: { command: string; args: string[] },
    args: readonly string[],
    cwd: string
  ) {
    return $({
      cwd,
      stdio: 'inherit'
    })`${runner.command} ${[...runner.args, ...args]}`;
  }

  private async extractArchive({
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

    if (platform === 'win' && (await this.commandExists('powershell')))
      return $`powershell -NoProfile -Command Expand-Archive -Path ${archivePath} -DestinationPath ${runtimeFolder} -Force`;

    if (await this.commandExists('python'))
      return $`python -m zipfile -e ${archivePath} ${runtimeFolder}`;

    return $`unzip -q -o ${archivePath} -d ${runtimeFolder}`;
  }

  private async installMakeself() {
    const makeselfFolder = path.join(os.tmpdir(), 'npm2exe-makeself');
    const makeselfPath = path.join(makeselfFolder, 'makeself.sh');

    await fs.ensureDir(makeselfFolder);

    const asset = await this.findLatestReleaseAsset(
      'megastep/makeself',
      /^makeself-.+\.run$/
    );
    const archivePath = path.join(os.tmpdir(), asset.name);

    await this.downloadService.downloadFile(
      asset.browser_download_url,
      archivePath,
      `Downloading ${asset.name}`
    );
    await fs.chmod(archivePath, 0o755);
    await $`${archivePath} --noexec --target ${makeselfFolder}`;

    return makeselfPath;
  }

  private async installSFXModule() {
    const { path7z } = await import('7zip-bin-full');
    const sfxFolder = path.join(os.tmpdir(), 'npm2exe-7zip');
    const sfxPath = path.join(sfxFolder, '7zSD.sfx');

    if (await fs.pathExists(sfxPath)) return sfxPath;

    const asset = await this.findLatestReleaseAsset(
      'ip7z/7zip',
      /^lzma\d+\.7z$/
    );
    const archivePath = path.join(os.tmpdir(), asset.name);

    await this.downloadService.downloadFile(
      asset.browser_download_url,
      archivePath,
      `Downloading ${asset.name}`
    );
    await $`${path7z} e ${archivePath} ${`-o${sfxFolder}`} bin/7zSD.sfx -y`;

    return sfxPath;
  }

  private async findLatestReleaseAsset(repository: string, pattern: RegExp) {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/releases/latest`,
      { headers: { Accept: 'application/vnd.github+json' } }
    );

    if (!response.ok)
      throw new Error(
        `Failed to fetch ${repository} release: ${response.status}`
      );

    const release = (await response.json()) as {
      assets?: Record<'name' | 'browser_download_url', string>[];
    };
    const asset = release.assets?.find(({ name }) => pattern.test(name));

    if (!asset)
      throw new Error(`No asset matching ${pattern} in ${repository} release`);

    return asset;
  }
}

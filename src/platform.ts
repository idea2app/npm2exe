import os from 'node:os';
import path from 'node:path';
import { HTTPClient } from 'koajax';
import semver from 'semver';
import type { PackageJson } from 'type-fest';
import { $, fs } from 'zx';
import fg from 'fast-glob';

import { downloadFile } from './download.js';
import {
  commandExists,
  extractArchive,
  INSTALLERS,
  normalizeVersion,
  TargetPlatform
} from './utility.js';

interface GitHubRelease {
  assets?: Record<'name' | 'browser_download_url', string>[];
}

const jsonClient = new HTTPClient({ responseType: 'json' });

export class PlatformPackager {
  static resolveRunner = async (name: string) =>
    (await commandExists(name))
      ? { command: name, args: [] as string[] }
      : (name === 'pnpm' || name === 'yarn') &&
          (await commandExists('corepack'))
        ? { command: 'corepack', args: [name] }
        : null;

  async installProductionDependencies(appFolder: string) {
    const installers =
      await PlatformPackager.resolveInstallersByLockFile(appFolder);

    for (const installer of installers) {
      const runner = await PlatformPackager.resolveRunner(installer.name);

      if (!runner) {
        if (installers.length === 1)
          throw new Error(
            `${installer.name} is required for the detected lock file`
          );

        continue;
      }

      for (const args of installer.attempts)
        try {
          return await $({
            cwd: appFolder,
            stdio: 'inherit'
          })`${runner.command} ${[...runner.args, ...args]}`;
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

    await downloadFile(archiveUrl, archivePath, `Downloading ${fileName}`);
    await fs.remove(runtimeFolder);
    await fs.ensureDir(runtimeFolder);
    await extractArchive({
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
    const preferred = path.join(
      distFolder,
      platform === 'win' ? '.' : 'bin',
      binaryName
    );

    if (await fs.pathExists(preferred)) return preferred;

    const matches = await fg(`**/${binaryName}`, {
      cwd: runtimeFolder,
      absolute: true,
      onlyFiles: true
    });

    if (!matches.length)
      throw new Error('Node runtime binary not found after extraction');

    return matches.sort()[0];
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

    const targetDirectory = '$HOME';
    const compressionOption = compressionLevel ? '--gzip' : '--nocomp';

    if (compressionLevel)
      return $`${makeselfPath} ${compressionOption} --complevel ${String(compressionLevel)} --target ${targetDirectory} ${tempRoot} ${outputFile} "npm2exe bundle" ${installScript}`;

    return $`${makeselfPath} ${compressionOption} --target ${targetDirectory} ${tempRoot} ${outputFile} "npm2exe bundle" ${installScript}`;
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

  static resolveInstallersByLockFile = async (appFolder: string) =>
    (await fs.pathExists(path.join(appFolder, 'pnpm-lock.yaml')))
      ? [INSTALLERS[0]]
      : (await fs.pathExists(path.join(appFolder, 'yarn.lock')))
        ? [INSTALLERS[1]]
        : (await fs.pathExists(path.join(appFolder, 'package-lock.json'))) ||
            (await fs.pathExists(path.join(appFolder, 'npm-shrinkwrap.json')))
          ? [INSTALLERS[2]]
          : INSTALLERS;

  private async installMakeself() {
    const makeselfFolder = path.join(os.tmpdir(), 'npm2exe-makeself');
    const makeselfPath = path.join(makeselfFolder, 'makeself.sh');

    await fs.ensureDir(makeselfFolder);

    const asset = await this.findLatestReleaseAsset(
      'megastep/makeself',
      /^makeself-.+\.run$/
    );
    const archivePath = path.join(os.tmpdir(), asset.name);

    await downloadFile(
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

    await downloadFile(
      asset.browser_download_url,
      archivePath,
      `Downloading ${asset.name}`
    );
    await $`${path7z} e ${archivePath} ${`-o${sfxFolder}`} bin/7zSD.sfx -y`;

    return sfxPath;
  }

  private async findLatestReleaseAsset(repository: string, pattern: RegExp) {
    const { body: release } = await jsonClient.get<GitHubRelease>(
      `https://api.github.com/repos/${repository}/releases/latest`,
      { Accept: 'application/vnd.github+json' }
    );
    const asset = release?.assets?.find(({ name }) => pattern.test(name));

    if (!asset)
      throw new Error(`No asset matching ${pattern} in ${repository} release`);

    return asset;
  }

  async resolveNodeVersion({
    sourcePackage = {},
    overrideVersion
  }: {
    sourcePackage?: PackageJson;
    overrideVersion?: string;
  }) {
    if (overrideVersion) return normalizeVersion(overrideVersion);

    const { body: index = [] } = await jsonClient.get<{ version: string }[]>(
      'https://nodejs.org/dist/index.json'
    );
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
}

import gitignoreToGlob from 'gitignore-to-glob';
import { HTTPClient } from 'koajax';
import path from 'node:path';
import { ByteSize } from 'web-utility';
import { $, fs } from 'zx';

export const LOCK_FILES = [
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'npm-shrinkwrap.json'
];

export const INSTALLERS = [
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

export const normalizeVersion = (version: string): string =>
  version.startsWith('v') ? version : `v${version}`;

export function normalizeArch(arch: string, platform: TargetPlatform) {
  if (arch === 'x64' || arch === 'arm64') return arch;
  if (arch === 'arm') return 'armv7l';
  if (arch === 'ia32' || arch === 'x86') {
    if (platform !== 'win')
      throw new Error(`${arch} is only supported for Windows targets`);

    return 'x86';
  }

  throw new Error(`Unsupported architecture: ${arch}`);
}

export function normalizePlatform(platform: string): TargetPlatform {
  if (platform === 'win32' || platform === 'win') return 'win';
  if (platform === 'darwin') return 'darwin';
  if (platform === 'linux') return 'linux';

  throw new Error(`Unsupported platform: ${platform}`);
}

export const toPosixPath = (filePath: string): string =>
  filePath.split(path.sep).join('/');

export const toWindowsPath = (filePath: string): string =>
  filePath.replaceAll('/', '\\');

export const getExtractionCommand = (extension: string): 'zip' | 'tar' =>
  extension === 'zip' ? 'zip' : 'tar';

export const formatBytes = (size: number): string =>
  !Number.isFinite(size) || size <= 0
    ? '0 B'
    : new ByteSize(size).toShortString(size < 1024 ? 0 : 1);

type AsyncMethod<This, Args extends unknown[], Return> = (
  this: This,
  ...args: Args
) => Promise<Return>;

type AsyncMethodDecorator = <This, Args extends unknown[], Return>(
  method: AsyncMethod<This, Args, Return>,
  context: ClassMethodDecoratorContext<This, AsyncMethod<This, Args, Return>>
) => AsyncMethod<This, Args, Return>;

export function logStep(label: string): AsyncMethodDecorator;
export function logStep<This, Args extends unknown[]>(
  label: (that: This, ...parameters: Args) => string
): <Return>(
  method: AsyncMethod<This, Args, Return>,
  context: ClassMethodDecoratorContext<This, AsyncMethod<This, Args, Return>>
) => AsyncMethod<This, Args, Return>;
export function logStep(label: unknown) {
  return function <This, Args extends unknown[], Return>(
    method: AsyncMethod<This, Args, Return>,
    _context: ClassMethodDecoratorContext<This, AsyncMethod<This, Args, Return>>
  ) {
    return async function (this: This, ...parameters: Args): Promise<Return> {
      const description =
        typeof label === 'string'
          ? label
          : (label as (that: This, ...parameters: Args) => string)(
              this,
              ...parameters
            );
      const title = `[npm2exe] ${description}`;

      console.info(`\n${title}\n`);
      console.time(title);
      try {
        return await method.apply(this, parameters);
      } finally {
        console.timeEnd(title);
      }
    };
  };
}

export async function createIgnorePatterns(sourceFolder: string) {
  const gitIgnorePath = path.join(sourceFolder, '.gitignore');
  const baseIgnorePatterns = [
    '.git/**',
    '.temp/**',
    'out/**',
    'node_modules/**',
    '**/.temp/**',
    '**/out/**',
    '**/node_modules/**'
  ];

  if (!(await fs.pathExists(gitIgnorePath))) return baseIgnorePatterns;

  return [...baseIgnorePatterns, ...gitignoreToGlob(gitIgnorePath)];
}

export async function commandExists(command: string) {
  try {
    if (process.platform === 'win32') await $`where.exe ${command}`;
    else await $`which ${command}`;

    return true;
  } catch {
    return false;
  }
}

export type TargetPlatform = 'linux' | 'darwin' | 'win';

export const extractArchive = async ({
  extension,
  archivePath,
  runtimeFolder,
  platform
}: {
  extension: string;
  archivePath: string;
  runtimeFolder: string;
  platform: TargetPlatform;
}) =>
  getExtractionCommand(extension) === 'tar'
    ? $`tar -xf ${archivePath} -C ${runtimeFolder}`
    : platform === 'win' && (await commandExists('powershell'))
      ? $`powershell -NoProfile -Command Expand-Archive -Path ${archivePath} -DestinationPath ${runtimeFolder} -Force`
      : (await commandExists('python'))
        ? $`python -m zipfile -e ${archivePath} ${runtimeFolder}`
        : $`unzip -q -o ${archivePath} -d ${runtimeFolder}`;

export interface GitHubRelease {
  assets?: Record<'name' | 'browser_download_url', string>[];
}

export const githubClient = new HTTPClient({
  baseURI: 'https://api.github.com',
  responseType: 'json'
}).use(({ request }, next) => {
  request.headers['Accept'] ||= 'application/vnd.github.v3+json';
  request.headers['Authorization'] ||= `Bearer ${process.env.GITHUB_TOKEN}`;

  return next();
});

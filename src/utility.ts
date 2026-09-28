import path from 'node:path';
import gitignoreToGlob from 'gitignore-to-glob';
import { ByteSize } from 'web-utility';
import { fs } from 'zx';

export const LOCK_FILES = [
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'npm-shrinkwrap.json'
];

export const normalizeVersion = (version: string): string =>
  version.startsWith('v') ? version : `v${version}`;

export const toPosixPath = (filePath: string): string =>
  filePath.split(path.sep).join('/');

export const toWindowsPath = (filePath: string): string =>
  filePath.replaceAll('/', '\\');

export const getExtractionCommand = (extension: string): 'zip' | 'tar' =>
  extension === 'zip' ? 'zip' : 'tar';

export const formatBytes = (size: number): string => {
  if (!Number.isFinite(size) || size <= 0) return '0 B';

  return new ByteSize(size).toShortString(size < 1024 ? 0 : 1);
};

export const logStep =
  (label: string) =>
  <This, Args extends unknown[], Return>(
    method: (this: This, ...args: Args) => Return,
    _context: ClassMethodDecoratorContext<
      This,
      (this: This, ...args: Args) => Return
    >
  ) =>
    async function (this: This, ...args: Args): Promise<Awaited<Return>> {
      const title = `[npm2exe] ${label}`;

      console.info(`\n${title}\n`);
      console.time(title);
      try {
        return (await method.apply(this, args)) as Awaited<Return>;
      } finally {
        console.timeEnd(title);
      }
    };

export const createIgnorePatterns = async (sourceFolder: string) => {
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
};

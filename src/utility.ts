import path from 'node:path';

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

  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(
    Math.floor(Math.log(size) / Math.log(1024)),
    units.length - 1
  );
  const value = size / 1024 ** exponent;

  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
};

export const logStep =
  (label: string) =>
  <This, Args extends unknown[], Return>(
    method: (this: This, ...args: Args) => Return,
    context: ClassMethodDecoratorContext<
      This,
      (this: This, ...args: Args) => Return
    >
  ) =>
    async function (this: This, ...args: Args): Promise<Awaited<Return>> {
      const startedAt = performance.now();

      console.info(`[npm2exe] start ${label}`);

      try {
        const result = await method.apply(this, args);
        const elapsed = Math.round(performance.now() - startedAt);

        console.info(`[npm2exe] end ${label} (${elapsed}ms)`);

        return result as Awaited<Return>;
      } catch (error) {
        const elapsed = Math.round(performance.now() - startedAt);

        console.error(`[npm2exe] end ${label} (${elapsed}ms)`);

        throw error;
      }
    };

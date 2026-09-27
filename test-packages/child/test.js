import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageFolder = path.dirname(fileURLToPath(import.meta.url));
const rootFolder = path.resolve(packageFolder, '../..');

function run(file, args) {
  const { error, status } = spawnSync(file, args, {
    cwd: packageFolder,
    stdio: 'inherit'
  });

  if (error) throw error;
  if (status !== 0) throw new Error(`${file} exited with code ${status}`);
}

run(process.execPath, [
  path.join(rootFolder, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  path.join(rootFolder, 'src', 'index.tsx'),
  '.'
]);
run(process.execPath, [
  path.join(
    packageFolder,
    '.temp',
    'npm2exe-apps',
    'test-child',
    'app',
    'index.js'
  )
]);

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fs, os, path } from 'zx';

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'npm2exe-bundle-'));
const windows = process.platform === 'win32';
const env = {
  ...process.env,
  HOME: profile,
  USERPROFILE: profile,
  NODE_PATH: ''
};

function run(label: string, file: string, args: string[]) {
  console.info(`[npm2exe smoke] ${label}: ${file}`);
  const result = spawnSync(file, args, {
    env,
    encoding: 'utf8',
    windowsVerbatimArguments: windows
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error)
    throw new Error(`${label} could not start: ${result.error.message}`, {
      cause: result.error
    });
  if (result.status !== 0)
    throw new Error(
      `${label} failed: exit code ${result.status}, signal ${result.signal}`
    );

  return result.stdout;
}

try {
  run(
    'install self-extracting bundle',
    path.resolve('out', windows ? 'npm2exe.exe' : 'npm2exe'),
    windows ? ['-y'] : []
  );
  const launcher = path.join(profile, windows ? 'npm2exe.cmd' : 'npm2exe');
  assert.ok(
    await fs.pathExists(launcher),
    `Installer did not create ${launcher}`
  );
  const output = windows
    ? run('start installed launcher', process.env.ComSpec || 'cmd.exe', [
        '/d',
        '/s',
        '/c',
        `""${launcher}" -h"`
      ])
    : run('start installed launcher', launcher, ['-h']);

  assert.match(output, /Pack a JavaScript local project/);
} finally {
  await fs.remove(profile);
}

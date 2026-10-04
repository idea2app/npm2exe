import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { $, fs, os, path, usePowerShell } from 'zx';
import type { PackageJson } from 'type-fest';

import { WorkspaceStager } from '../src/workspace.ts';
import {
  DependencyCopier,
  type ProjectFilesCopyInput,
  type ProjectFilesCopier
} from '../src/dependencies.ts';
import { PlatformPackager } from '../src/platform.ts';

if (process.platform === 'win32')
  if (typeof $.shell === 'string')
    $.quote = arg => `'${arg.replace(/'/g, `'\\''`)}'`;
  else {
    usePowerShell();
    $.prefix = '& ';
  }

const fixtures = fileURLToPath(new URL('./', import.meta.url));
const copyFixture = (name: string, target: string) =>
  fs.copy(path.join(fixtures, name), target);
const readPackage = async (folder: string): Promise<PackageJson> =>
  JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'));

const copyProjectFiles: ProjectFilesCopier = ({
  sourceFolder,
  appFolder,
  sourcePackage
}: ProjectFilesCopyInput) =>
  fs.copy(sourceFolder, appFolder, {
    filter: source => {
      const relativePath = path.relative(sourceFolder, source);
      const entry = relativePath.split(path.sep)[0];

      if (entry === 'node_modules') return false;

      return (
        !relativePath ||
        entry === 'package.json' ||
        !sourcePackage.files?.length ||
        sourcePackage.files.includes(entry)
      );
    }
  });

async function createFixture(t: TestContext, name: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'npm2exe-fixture-'));
  t.after(() => fs.remove(root));
  const sourceFolder = path.join(root, 'source');
  const appFolder = path.join(root, 'output');
  await copyFixture(name, sourceFolder);
  return { root, sourceFolder, appFolder };
}

function assertRuns(appFolder: string, expected: string) {
  const result = spawnSync(
    process.execPath,
    [path.join(appFolder, 'index.cjs')],
    {
      encoding: 'utf-8'
    }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), expected);
}

const assertUnusedAbsent = (appFolder: string) =>
  assert.rejects(
    readPackage(path.join(appFolder, 'node_modules', 'fixture-unused')),
    { code: 'ENOENT' }
  );

async function installExternal(modules: string) {
  await copyFixture('external', path.join(modules, 'fixture-external'));
  await copyFixture('transitive', path.join(modules, '@fixture', 'transitive'));
  await copyFixture('unused', path.join(modules, 'fixture-unused'));
}

async function linkWorkspace(folder: string, modules: string) {
  await fs.ensureDir(modules);
  await fs.symlink(
    path.join(folder, 'packages', 'lib'),
    path.join(modules, 'fixture-workspace'),
    'junction'
  );
}

async function installHoisted(folder: string) {
  const modules = path.join(folder, 'node_modules');
  await installExternal(modules);
  await linkWorkspace(folder, modules);
}

async function stageFixture(
  t: TestContext,
  install: (folder: string) => Promise<unknown> = installHoisted
) {
  const { sourceFolder: workspaceFolder, appFolder } = await createFixture(
    t,
    'workspace'
  );
  const sourceFolder = path.join(workspaceFolder, 'packages', 'app');
  const sourcePackage = await readPackage(sourceFolder);
  await new WorkspaceStager(copyProjectFiles, install).stagePackage({
    sourceFolder,
    appFolder,
    sourcePackage
  });
  return { workspaceFolder, appFolder };
}

test('exports standalone dependencies with the shared copier and no source links', async t => {
  const { sourceFolder, appFolder } = await createFixture(t, 'standalone');
  await installExternal(path.join(sourceFolder, 'node_modules'));
  await copyFixture('bin', path.join(sourceFolder, 'node_modules', '.bin'));
  await new DependencyCopier(copyProjectFiles).copyPackage({
    sourceFolder,
    appFolder,
    sourcePackage: await readPackage(sourceFolder)
  });
  await fs.remove(sourceFolder);
  assertRuns(appFolder, '21');
  assert.equal(
    await fs.readFile(
      path.join(appFolder, 'node_modules', '.bin', 'fixture.cmd'),
      'utf8'
    ),
    await fs.readFile(path.join(fixtures, 'bin', 'fixture.cmd'), 'utf8')
  );
  await assertUnusedAbsent(appFolder);
  const { name: transitivePackageName } = await readPackage(
    path.join(appFolder, 'node_modules', '@fixture', 'transitive')
  );
  assert.equal(transitivePackageName, '@fixture/transitive');
  const nestedTransitivePackageFolder = path.join(
    appFolder,
    'node_modules',
    'fixture-external',
    'node_modules',
    '@fixture',
    'transitive'
  );
  assert.equal(await fs.pathExists(nestedTransitivePackageFolder), false);
});

test('keeps a long dependency chain shallow enough for portable archives', async t => {
  const { sourceFolder, appFolder } = await createFixture(t, 'long-chain');
  const modules = path.join(sourceFolder, 'node_modules');
  const names: string[] = [];

  for (const entry of await fs.readdir(path.join(sourceFolder, 'packages'))) {
    const folder = path.join(sourceFolder, 'packages', entry);
    const { name } = await readPackage(folder);
    assert.ok(name);
    names.push(name);
    await fs.copy(folder, path.join(modules, name));
  }
  await fs.remove(path.join(sourceFolder, 'packages'));
  await new DependencyCopier(copyProjectFiles).copyPackage({
    sourceFolder,
    appFolder,
    sourcePackage: await readPackage(sourceFolder)
  });
  await fs.remove(sourceFolder);

  assertRuns(appFolder, '21');

  for (const name of names)
    assert.equal(
      (await readPackage(path.join(appFolder, 'node_modules', name))).name,
      name
    );
});

test('exports a standalone project without runtime dependencies', async t => {
  const { sourceFolder, appFolder } = await createFixture(t, 'empty');
  await new DependencyCopier(copyProjectFiles).copyPackage({
    sourceFolder,
    appFolder,
    sourcePackage: await readPackage(sourceFolder)
  });
  await fs.remove(sourceFolder);
  assertRuns(appFolder, '42');
});

test('stages hoisted external and transitive dependencies without local node_modules', async t => {
  const { workspaceFolder, appFolder } = await stageFixture(t);
  await fs.remove(workspaceFolder);
  assertRuns(appFolder, '42');
  await assertUnusedAbsent(appFolder);
});

test('stages local workspace links and external hoisted dependencies', async t => {
  const { appFolder } = await stageFixture(t, async folder => {
    await installHoisted(folder);
    await linkWorkspace(
      folder,
      path.join(folder, 'packages', 'app', 'node_modules')
    );
  });
  assert.equal(
    (
      await readPackage(
        path.join(appFolder, 'node_modules', 'fixture-external')
      )
    ).name,
    'fixture-external'
  );
});

test('preserves nested dependency versions instead of reusing a different hoisted version', async t => {
  const { appFolder } = await stageFixture(t, async workspaceFolder => {
    await installHoisted(workspaceFolder);
    await copyFixture(
      'external-v2',
      path.join(
        workspaceFolder,
        'packages',
        'lib',
        'node_modules',
        'fixture-external'
      )
    );
  });
  assertRuns(appFolder, '43');
});

test('copies isolated external symlinks and resolves their store dependencies', async t => {
  const { appFolder } = await stageFixture(t, async folder => {
    await installHoisted(folder);
    const store = path.join(
      folder,
      'node_modules',
      '.pnpm',
      'external',
      'node_modules'
    );
    await installExternal(store);
    const modules = path.join(folder, 'packages', 'app', 'node_modules');
    await fs.ensureDir(modules);
    await fs.symlink(
      path.join(store, 'fixture-external'),
      path.join(modules, 'fixture-external'),
      'junction'
    );
  });
  assertRuns(appFolder, '42');
});

test('terminates cyclic dependency graphs with unresolved peer dependencies', async t => {
  const { appFolder } = await stageFixture(t, async folder => {
    await installHoisted(folder);
    await copyFixture(
      'cyclic-peer',
      path.join(folder, 'node_modules', '@fixture', 'transitive')
    );
  });
  assertRuns(appFolder, '42');
});

test('reports missing required runtime dependencies', async t => {
  await assert.rejects(
    stageFixture(t, async folder => {
      await installHoisted(folder);
      await fs.remove(path.join(folder, 'node_modules', 'fixture-external'));
    }),
    /Cannot find runtime dependency "fixture-external"/
  );
});

test('leaves packages without workspace protocols on the standalone staging path', async () => {
  const stager = new WorkspaceStager(
    () => assert.fail('Should not copy workspace files'),
    () => assert.fail('Should not install workspace dependencies')
  );
  assert.equal(
    await stager.stagePackage({
      sourceFolder: path.join(fixtures, 'standalone'),
      appFolder: path.resolve('fixture-output'),
      sourcePackage: await readPackage(path.join(fixtures, 'standalone'))
    }),
    false
  );
});

test('exports a real pnpm workspace with a third-party dependency', async t => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'npm2exe-real-workspace-')
  );
  t.after(() => fs.remove(root));
  const workspaceFolder = path.join(root, 'workspace');
  const appFolder = path.join(root, 'app');
  await fs.copy(
    fileURLToPath(new URL('./real-workspace/', import.meta.url)),
    workspaceFolder,
    {
      filter: source =>
        !['node_modules', '.temp', 'out'].includes(path.basename(source))
    }
  );
  const sourceFolder = path.join(workspaceFolder, 'child');
  const platformPackager = new PlatformPackager();
  await new WorkspaceStager(copyProjectFiles, folder =>
    platformPackager.installProductionDependencies(folder)
  ).stagePackage({
    sourceFolder,
    appFolder,
    sourcePackage: await readPackage(sourceFolder)
  });
  await fs.remove(workspaceFolder);
  const result = spawnSync(
    process.execPath,
    [path.join(appFolder, 'index.js')],
    {
      encoding: 'utf8',
      cwd: root,
      env: { ...process.env, NODE_PATH: '' }
    }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /child: parent/);
  const typescript = await readPackage(
    path.join(appFolder, 'node_modules', 'typescript')
  );
  assert.ok(result.stdout.includes(`typescript: ${typescript.version}`));
});

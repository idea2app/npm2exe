import path from 'node:path';
import { fs } from 'zx';
import fg from 'fast-glob';
import gitignoreToGlob from 'gitignore-to-glob';
import type { PackageJson } from 'type-fest';

export interface ProjectFilesCopyInput {
  sourceFolder: string;
  appFolder: string;
  sourcePackage: PackageJson;
}

interface StageWorkspacePackageInput extends ProjectFilesCopyInput {
  copyProjectFiles(input: ProjectFilesCopyInput): Promise<void>;
  installProductionDependencies(appFolder: string): Promise<void>;
}

const WORKSPACE_PROTOCOL = 'workspace:';
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies'
] as const;
const RUNTIME_DEPENDENCY_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies'
] as const;

export async function stageWorkspacePackage({
  sourceFolder,
  sourcePackage,
  appFolder,
  copyProjectFiles,
  installProductionDependencies
}: StageWorkspacePackageInput) {
  if (!hasWorkspaceProtocolDependency(sourcePackage)) return;

  const workspaceRoot = await findWorkspaceRoot(sourceFolder);
  if (!workspaceRoot)
    throw new Error(
      'Detected `workspace:` dependencies but no workspace root was found'
    );

  const relativePackageFolder = path.relative(workspaceRoot, sourceFolder);
  const workspacePackage = (await fs.readJSON(
    path.join(workspaceRoot, 'package.json')
  )) as PackageJson;
  const workspacePackageName =
    workspacePackage.name?.trim() || path.basename(workspaceRoot);
  const workspaceTempFolder = path.join(
    sourceFolder,
    '.temp',
    workspacePackageName
  );
  const stagedPackageFolder = path.join(
    workspaceTempFolder,
    relativePackageFolder
  );

  await fs.remove(workspaceTempFolder);
  await fs.remove(appFolder);
  await fs.ensureDir(appFolder);
  await copyWorkspaceFiles(workspaceRoot, workspaceTempFolder);
  await installProductionDependencies(workspaceTempFolder);
  await copyProjectFiles({
    sourceFolder: stagedPackageFolder,
    appFolder,
    sourcePackage
  });
  await copyResolvedNodeModules({
    sourcePackageFolder: stagedPackageFolder,
    targetPackageFolder: appFolder,
    copyProjectFiles
  });
  await fs.remove(workspaceTempFolder);

  return true;
}

const hasWorkspaceProtocolDependency = (packageJson: PackageJson) =>
  DEPENDENCY_FIELDS.some(field =>
    Object.values(packageJson[field] || {}).some(version =>
      version.startsWith(WORKSPACE_PROTOCOL)
    )
  );

async function findWorkspaceRoot(sourceFolder: string) {
  let current = sourceFolder;

  while (true) {
    if (await fs.pathExists(path.join(current, 'pnpm-workspace.yaml')))
      return current;

    const packageJsonPath = path.join(current, 'package.json');

    if (await fs.pathExists(packageJsonPath)) {
      const currentPackage = (await fs.readJSON(
        packageJsonPath
      )) as PackageJson;

      if (currentPackage.workspaces) return current;
    }

    const parent = path.dirname(current);
    if (parent === current) return null;

    current = parent;
  }
}

async function copyWorkspaceFiles(sourceFolder: string, targetFolder: string) {
  const relativePaths = await fg('**/*', {
    cwd: sourceFolder,
    dot: true,
    onlyFiles: false,
    followSymbolicLinks: false,
    ignore: await createIgnorePatterns(sourceFolder)
  });

  for (const relativePath of relativePaths) {
    const from = path.join(sourceFolder, relativePath);
    const stats = await fs.lstat(from);
    const to = path.join(targetFolder, relativePath);

    if (stats.isDirectory()) {
      await fs.ensureDir(to);
      continue;
    }

    await fs.copy(from, to);
  }
}

async function createIgnorePatterns(sourceFolder: string) {
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

async function copyResolvedNodeModules({
  sourcePackageFolder,
  targetPackageFolder,
  copyProjectFiles
}: {
  sourcePackageFolder: string;
  targetPackageFolder: string;
  copyProjectFiles(input: ProjectFilesCopyInput): Promise<void>;
}) {
  const sourceNodeModulesFolder = path.join(
    sourcePackageFolder,
    'node_modules'
  );
  if (!(await fs.pathExists(sourceNodeModulesFolder))) return;

  const sourcePackage = (await fs.readJSON(
    path.join(sourcePackageFolder, 'package.json')
  )) as PackageJson;
  const targetNodeModulesFolder = path.join(
    targetPackageFolder,
    'node_modules'
  );

  await fs.ensureDir(targetNodeModulesFolder);

  const sourceBinaryFolder = path.join(sourceNodeModulesFolder, '.bin');
  if (await fs.pathExists(sourceBinaryFolder))
    await fs.copy(
      sourceBinaryFolder,
      path.join(targetNodeModulesFolder, '.bin'),
      {
        dereference: true
      }
    );

  for (const dependencyName of getRuntimeDependencyNames(sourcePackage)) {
    const dependencyPathParts = dependencyName.split('/');

    await copyInstalledNodeModulesEntry({
      sourceEntry: path.join(sourceNodeModulesFolder, ...dependencyPathParts),
      targetEntry: path.join(targetNodeModulesFolder, ...dependencyPathParts),
      copyProjectFiles
    });
  }
}

async function copyInstalledNodeModulesEntry({
  sourceEntry,
  targetEntry,
  copyProjectFiles
}: {
  sourceEntry: string;
  targetEntry: string;
  copyProjectFiles(input: ProjectFilesCopyInput): Promise<void>;
}) {
  if (!(await fs.pathExists(sourceEntry))) return;

  const sourceStats = await fs.lstat(sourceEntry);

  if (sourceStats.isSymbolicLink()) {
    const resolvedEntry = await fs.realpath(sourceEntry);

    if (
      sourceEntry.includes(`${path.sep}.bin${path.sep}`) ||
      path.basename(path.dirname(sourceEntry)) === '.bin'
    ) {
      await fs.copy(sourceEntry, targetEntry, { dereference: true });
      return;
    }

    if (await fs.pathExists(path.join(resolvedEntry, 'package.json'))) {
      const resolvedPackage = (await fs.readJSON(
        path.join(resolvedEntry, 'package.json')
      )) as PackageJson;

      await fs.ensureDir(targetEntry);
      await copyProjectFiles({
        sourceFolder: resolvedEntry,
        appFolder: targetEntry,
        sourcePackage: resolvedPackage
      });
      await copyResolvedNodeModules({
        sourcePackageFolder: resolvedEntry,
        targetPackageFolder: targetEntry,
        copyProjectFiles
      });
      return;
    }

    await fs.copy(sourceEntry, targetEntry, { dereference: true });
    return;
  }

  if (!sourceStats.isDirectory()) {
    await fs.copy(sourceEntry, targetEntry);
    return;
  }

  await fs.ensureDir(targetEntry);
  await fs.copy(sourceEntry, targetEntry);
}

const getRuntimeDependencyNames = (packageJson: PackageJson) =>
  RUNTIME_DEPENDENCY_FIELDS.flatMap(field =>
    Object.keys(packageJson[field] || {})
  );

import path from 'node:path';
import { fs } from 'zx';
import fg from 'fast-glob';
import type { PackageJson } from 'type-fest';
import { createIgnorePatterns } from './utility.js';

export interface ProjectFilesCopyInput {
  sourceFolder: string;
  appFolder: string;
  sourcePackage: PackageJson;
}

interface WorkspaceStagerInput extends ProjectFilesCopyInput {
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

export class WorkspaceStager {
  constructor(
    private readonly copyProjectFiles: WorkspaceStagerInput['copyProjectFiles'],
    private readonly installProductionDependencies: WorkspaceStagerInput['installProductionDependencies']
  ) {}

  async stagePackage({
    sourceFolder,
    sourcePackage,
    appFolder
  }: ProjectFilesCopyInput) {
    if (!WorkspaceStager.hasWorkspaceProtocolDependency(sourcePackage))
      return false;

    const workspaceRoot = await this.findWorkspaceRoot(sourceFolder);

    if (!workspaceRoot)
      throw new Error(
        'Detected `workspace:` dependencies but no workspace root was found'
      );

    const relativePackageFolder = path.relative(workspaceRoot, sourceFolder);
    const workspacePackage = (await fs.readJSON(
      path.join(workspaceRoot, 'package.json')
    )) as PackageJson;
    const workspacePackageName =
      workspacePackage.name?.trim().replace(/\//g, '__') ||
      path.basename(workspaceRoot);
    const workspaceTempFolder = path.join(
      workspaceRoot,
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
    await this.copyWorkspaceFiles(workspaceRoot, workspaceTempFolder);
    await this.installProductionDependencies(workspaceTempFolder);
    await this.copyProjectFiles({
      sourceFolder: stagedPackageFolder,
      appFolder,
      sourcePackage
    });
    await this.copyResolvedNodeModules({
      sourcePackageFolder: stagedPackageFolder,
      targetPackageFolder: appFolder
    });
    await fs.remove(workspaceTempFolder);

    return true;
  }

  private static hasWorkspaceProtocolDependency(packageJson: PackageJson) {
    return DEPENDENCY_FIELDS.some(field =>
      Object.values(packageJson[field] || {}).some(version =>
        version?.startsWith(WORKSPACE_PROTOCOL)
      )
    );
  }

  private async findWorkspaceRoot(sourceFolder: string) {
    let currentFolder = sourceFolder;

    while (true) {
      if (await fs.pathExists(path.join(currentFolder, 'pnpm-workspace.yaml')))
        return currentFolder;

      const packageJsonPath = path.join(currentFolder, 'package.json');

      if (await fs.pathExists(packageJsonPath)) {
        const currentPackage = (await fs.readJSON(
          packageJsonPath
        )) as PackageJson;

        if (currentPackage.workspaces) return currentFolder;
      }

      const parentFolder = path.dirname(currentFolder);

      if (parentFolder === currentFolder) return;

      currentFolder = parentFolder;
    }
  }

  private async copyWorkspaceFiles(sourceFolder: string, targetFolder: string) {
    const relativePaths = await fg('**/*', {
      cwd: sourceFolder,
      dot: true,
      onlyFiles: false,
      followSymbolicLinks: false,
      ignore: await createIgnorePatterns(sourceFolder)
    });

    for (const relativePath of relativePaths) {
      const sourcePath = path.join(sourceFolder, relativePath);
      const stats = await fs.lstat(sourcePath);
      const targetPath = path.join(targetFolder, relativePath);

      if (stats.isDirectory()) await fs.ensureDir(targetPath);
      else await fs.copy(sourcePath, targetPath);
    }
  }

  private async copyResolvedNodeModules({
    sourcePackageFolder,
    targetPackageFolder
  }: {
    sourcePackageFolder: string;
    targetPackageFolder: string;
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
        { dereference: true }
      );

    for (const dependencyName of WorkspaceStager.getRuntimeDependencyNames(
      sourcePackage
    )) {
      const dependencyPathParts = dependencyName.split('/');

      await this.copyInstalledNodeModulesEntry({
        sourceEntry: path.join(sourceNodeModulesFolder, ...dependencyPathParts),
        targetEntry: path.join(targetNodeModulesFolder, ...dependencyPathParts)
      });
    }
  }

  private async copyInstalledNodeModulesEntry({
    sourceEntry,
    targetEntry
  }: {
    sourceEntry: string;
    targetEntry: string;
  }) {
    if (!(await fs.pathExists(sourceEntry))) return;

    const sourceStats = await fs.lstat(sourceEntry);

    if (sourceStats.isSymbolicLink()) {
      const resolvedEntry = await fs.realpath(sourceEntry);

      if (
        sourceEntry.includes(`${path.sep}.bin${path.sep}`) ||
        path.basename(path.dirname(sourceEntry)) === '.bin'
      )
        return fs.copy(sourceEntry, targetEntry, { dereference: true });

      if (await fs.pathExists(path.join(resolvedEntry, 'package.json'))) {
        const resolvedPackage = (await fs.readJSON(
          path.join(resolvedEntry, 'package.json')
        )) as PackageJson;

        await fs.ensureDir(targetEntry);
        await this.copyProjectFiles({
          sourceFolder: resolvedEntry,
          appFolder: targetEntry,
          sourcePackage: resolvedPackage
        });

        return this.copyResolvedNodeModules({
          sourcePackageFolder: resolvedEntry,
          targetPackageFolder: targetEntry
        });
      }

      return fs.copy(sourceEntry, targetEntry, { dereference: true });
    }

    if (!sourceStats.isDirectory()) return fs.copy(sourceEntry, targetEntry);

    await fs.ensureDir(targetEntry);

    return fs.copy(sourceEntry, targetEntry);
  }

  private static getRuntimeDependencyNames(packageJson: PackageJson) {
    return RUNTIME_DEPENDENCY_FIELDS.flatMap(field =>
      Object.keys(packageJson[field] || {})
    );
  }
}

import path from 'node:path';
import { fs } from 'zx';
import fg from 'fast-glob';
import type { PackageJson } from 'type-fest';

import { ProgressRenderer } from './progress.js';
import { createIgnorePatterns, logStep } from './utility.js';
import {
  DependencyCopier,
  type ProjectFilesCopyInput,
  type ProjectFilesCopier
} from './dependencies.js';

const WORKSPACE_PROTOCOL = 'workspace:';
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies'
] as const;

export class WorkspaceStager {
  constructor(
    copyProjectFiles: ProjectFilesCopier,
    private readonly installProductionDependencies: (
      appFolder: string
    ) => Promise<unknown>,
    private readonly dependencyCopier = new DependencyCopier(copyProjectFiles)
  ) {}

  @logStep('stage workspace package')
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
      workspacePackage.name?.trim().replace(/[@/]+/g, '-') ||
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
    try {
      await this.copyWorkspaceFiles(workspaceRoot, workspaceTempFolder);
      await this.installProductionDependencies(workspaceTempFolder);
      await this.dependencyCopier.copyPackage({
        sourceFolder: stagedPackageFolder,
        appFolder,
        sourcePackage
      });
    } finally {
      await fs.remove(workspaceTempFolder);
    }

    return true;
  }

  private static hasWorkspaceProtocolDependency = (packageJson: PackageJson) =>
    DEPENDENCY_FIELDS.some(field =>
      Object.values(packageJson[field] || {}).some(version =>
        version?.startsWith(WORKSPACE_PROTOCOL)
      )
    );

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

  @logStep('copy workspace files')
  private async copyWorkspaceFiles(sourceFolder: string, targetFolder: string) {
    const relativePaths = await fg('**/*', {
      cwd: sourceFolder,
      dot: true,
      onlyFiles: false,
      followSymbolicLinks: false,
      ignore: await createIgnorePatterns(sourceFolder)
    });
    const progressRenderer = new ProgressRenderer(
      'Copying workspace files',
      'items'
    );
    let copied = 0;

    try {
      for (const relativePath of relativePaths) {
        const sourcePath = path.join(sourceFolder, relativePath);
        const stats = await fs.lstat(sourcePath);
        const targetPath = path.join(targetFolder, relativePath);

        if (stats.isDirectory()) await fs.ensureDir(targetPath);
        else await fs.copy(sourcePath, targetPath);

        progressRenderer.update(++copied, relativePaths.length);
      }
    } finally {
      progressRenderer.close();
    }
  }
}

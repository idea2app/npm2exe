import path from 'node:path';
import { fs } from 'zx';
import type { PackageJson } from 'type-fest';
import { ProgressRenderer } from './progress.js';
import { logStep } from './utility.js';

export interface ProjectFilesCopyInput {
  sourceFolder: string;
  appFolder: string;
  sourcePackage: PackageJson;
}

export type ProjectFilesCopier = (
  input: ProjectFilesCopyInput
) => Promise<unknown>;

interface DependencyCopyInput {
  sourcePackageFolder: string;
  targetPackageFolder: string;
  appFolder: string;
  copiedPackages: Map<string, string>;
  queue: DependencyCopyInput[];
}

const RUNTIME_DEPENDENCY_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies'
] as const;

export class DependencyCopier {
  constructor(private readonly copyProjectFiles: ProjectFilesCopier) {}

  @logStep('copy package and runtime dependencies')
  async copyPackage(input: ProjectFilesCopyInput) {
    await this.copyProjectFiles(input);
    const sourcePackageFolder = await fs.realpath(input.sourceFolder);
    const targetPackageFolder = path.resolve(input.appFolder);

    const queue: DependencyCopyInput[] = [];
    queue.push({
      sourcePackageFolder,
      targetPackageFolder,
      appFolder: targetPackageFolder,
      copiedPackages: new Map([[targetPackageFolder, sourcePackageFolder]]),
      queue
    });

    // Export each level before its children so direct dependencies reserve their slots.
    for (let index = 0; index < queue.length; index++)
      await this.copyDependencies(queue[index]);
  }

  private async findInstalledDependency(
    packageFolder: string,
    dependencyName: string
  ) {
    let currentFolder = packageFolder;

    while (true) {
      if (path.basename(currentFolder) !== 'node_modules') {
        const entry = path.join(
          currentFolder,
          'node_modules',
          ...dependencyName.split('/')
        );

        if (await fs.pathExists(entry)) return entry;
      }

      const parentFolder = path.dirname(currentFolder);

      if (parentFolder === currentFolder) return;

      currentFolder = parentFolder;
    }
  }

  private async copyDependencies({
    sourcePackageFolder,
    targetPackageFolder,
    appFolder,
    copiedPackages,
    queue
  }: DependencyCopyInput) {
    const sourcePackage = (await fs.readJSON(
      path.join(sourcePackageFolder, 'package.json')
    )) as PackageJson;
    const targetNodeModulesFolder = path.join(
      targetPackageFolder,
      'node_modules'
    );
    const sourceBinaryFolder = path.join(
      sourcePackageFolder,
      'node_modules',
      '.bin'
    );

    await fs.ensureDir(targetNodeModulesFolder);

    if (await fs.pathExists(sourceBinaryFolder))
      await fs.copy(
        sourceBinaryFolder,
        path.join(targetNodeModulesFolder, '.bin'),
        { dereference: true }
      );

    const dependencyNames = new Set(
      RUNTIME_DEPENDENCY_FIELDS.flatMap(field =>
        Object.keys(sourcePackage[field] || {})
      )
    );
    const progressRenderer = new ProgressRenderer(
      'Copying runtime dependencies',
      'items'
    );
    let copied = 0;

    try {
      for (const dependencyName of dependencyNames) {
        const sourceEntry = await this.findInstalledDependency(
          sourcePackageFolder,
          dependencyName
        );

        if (!sourceEntry) {
          const optional =
            sourcePackage.optionalDependencies?.[dependencyName] !==
              undefined ||
            (sourcePackage.dependencies?.[dependencyName] === undefined &&
              sourcePackage.peerDependenciesMeta?.[dependencyName]?.optional);
          const peerDependency =
            sourcePackage.peerDependencies?.[dependencyName] !== undefined;

          if (!optional && !peerDependency)
            throw new Error(
              `Cannot find runtime dependency "${dependencyName}" from "${sourcePackageFolder}"`
            );
        } else {
          const resolvedEntry = await fs.realpath(sourceEntry);
          const targetEntry = this.findTargetEntry(
            targetPackageFolder,
            appFolder,
            dependencyName,
            resolvedEntry,
            copiedPackages
          );

          if (copiedPackages.get(targetEntry) !== resolvedEntry) {
            await this.copyInstalledEntry(
              sourceEntry,
              targetEntry,
              copiedPackages
            );
            queue.push({
              sourcePackageFolder: resolvedEntry,
              targetPackageFolder: targetEntry,
              appFolder,
              copiedPackages,
              queue
            });
          }
        }

        progressRenderer.update(++copied, dependencyNames.size);
      }
    } finally {
      progressRenderer.close();
    }
  }

  private findTargetEntry(
    packageFolder: string,
    appFolder: string,
    dependencyName: string,
    resolvedEntry: string,
    copiedPackages: Map<string, string>
  ) {
    let currentFolder = packageFolder;
    let targetEntry = path.join(
      currentFolder,
      'node_modules',
      ...dependencyName.split('/')
    );

    while (true) {
      if (path.basename(currentFolder) !== 'node_modules') {
        const candidate = path.join(
          currentFolder,
          'node_modules',
          ...dependencyName.split('/')
        );
        const installed = copiedPackages.get(candidate);

        if (installed === resolvedEntry) return candidate;
        if (installed) return targetEntry;

        targetEntry = candidate;
      }

      if (currentFolder === appFolder) return targetEntry;

      currentFolder = path.dirname(currentFolder);
    }
  }

  private async copyInstalledEntry(
    sourceEntry: string,
    targetEntry: string,
    copiedPackages: Map<string, string>
  ) {
    const sourceStats = await fs.lstat(sourceEntry);
    const resolvedEntry = await fs.realpath(sourceEntry);
    const manifestPath = path.join(resolvedEntry, 'package.json');

    if (!(await fs.pathExists(manifestPath)))
      return fs.copy(sourceEntry, targetEntry, { dereference: true });

    await fs.ensureDir(targetEntry);

    if (
      sourceStats.isSymbolicLink() &&
      !resolvedEntry.split(path.sep).includes('node_modules')
    )
      await this.copyProjectFiles({
        sourceFolder: resolvedEntry,
        appFolder: targetEntry,
        sourcePackage: (await fs.readJSON(manifestPath)) as PackageJson
      });
    else
      await fs.copy(resolvedEntry, targetEntry, {
        dereference: true,
        filter: sourcePath => path.basename(sourcePath) !== 'node_modules'
      });

    copiedPackages.set(targetEntry, resolvedEntry);
  }
}

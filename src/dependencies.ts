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
  copiedPackages: Map<string, string>;
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

    await this.copyDependencies({
      sourcePackageFolder,
      targetPackageFolder,
      copiedPackages: new Map([[targetPackageFolder, sourcePackageFolder]])
    });
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
    copiedPackages
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

          if (!optional)
            throw new Error(
              `Cannot find runtime dependency "${dependencyName}" from "${sourcePackageFolder}"`
            );
        } else {
          const resolvedEntry = await fs.realpath(sourceEntry);
          const existingTarget = await this.findInstalledDependency(
            targetPackageFolder,
            dependencyName
          );

          // Reuse only the same installed package; other versions need a local copy.
          if (
            !existingTarget ||
            copiedPackages.get(existingTarget) !== resolvedEntry
          )
            await this.copyInstalledEntry(
              sourceEntry,
              path.join(targetNodeModulesFolder, ...dependencyName.split('/')),
              copiedPackages
            );
        }

        progressRenderer.update(++copied, dependencyNames.size);
      }
    } finally {
      progressRenderer.close();
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

    await this.copyDependencies({
      sourcePackageFolder: resolvedEntry,
      targetPackageFolder: targetEntry,
      copiedPackages
    });
  }
}

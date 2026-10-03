# NPM to EXE

Pack a JavaScript local project to a **portable executable**.

[![NPM Dependency](https://img.shields.io/librariesio/github/idea2app/npm2exe.svg)][1]
[![CI & CD](https://github.com/idea2app/npm2exe/actions/workflows/main.yml/badge.svg)][2]

[![NPM](https://nodei.co/npm/npm2exe.png?downloads=true&downloadRank=true&stars=true)][3]

## Usage

```bash
# build your project first
npm run build
# pack current project
npm2exe .
# pack other project
npm2exe path/to/project
```

Options:

- `--arch <x86|ia32|x64|arm|arm64>` target runtime architecture (`ia32` maps to `x86`, `arm` maps to `armv7l`)
- `--platform <linux|darwin|win|win32>` target platform (default current platform)
- `--node-version <version>` specific runtime version (for example `v22.18.0`)
- `--output <name>` output bundle file name (default package name; Windows appends `.exe`)
- `--compression-level <0-9>` compression level (default `0`, no compression; higher levels trade speed for a smaller archive)
- `--verbose` or `-V` enable Verbose output

`npm2exe` reads your [`package.json#bin`][9], installs only production dependencies into a temporary staging directory, downloads a matching [stock Node.js runtime][10], then wraps both into a [self-extracting package][10].

Standalone projects and workspace packages use the same dependency copier to export their runtime dependency graph into the app. For packages using `workspace:` dependencies, installation runs at the staged workspace root instead of the standalone project directory. Dependencies hoisted to ancestor `node_modules` directories are included, along with transitive dependencies and linked workspace packages. Missing optional dependencies are skipped; missing required runtime dependencies stop packaging with an error. Temporary installation directories are removed after export.

Run `npm run test-workspace` for the standalone dependency copying and workspace staging regression tests. This includes `test-packages/real-workspace`, whose parent/child packages exercise a real PNPM production install with TypeScript as a third-party dependency. PNPM (or Corepack) and registry access on a cold cache are required; executable packaging and Node.js runtime downloads are not.
Static test packages live directly under `test-packages`, alongside `real-workspace`; tests copy them into isolated temporary directories and construct installation layouts and links without generating package manifests or entry scripts.

## Compared with Node SEA / pkg / nexe / caxa

| Feature          | npm2exe                                                                        | Node SEA                             | pkg                                                       | nexe                                      | caxa                                        |
| ---------------- | ------------------------------------------------------------------------------ | ------------------------------------ | --------------------------------------------------------- | ----------------------------------------- | ------------------------------------------- |
| OS / CPU         | ✅ [`linux` / `darwin` / `win`; `x64` / `arm64` / `armv7l`; Windows `x86`][10] | ✅ [stock Node target][4]            | ✅ [Linux / macOS / Windows / Alpine / static Linux][6]   | ✅ [target triple][13]                    | ✅ [Windows / macOS / Linux][14]            |
| Node version     | ✅ [build `>=22`][9]; [runtime auto-resolved or overridden][10]                | ✅ [Node SEA in official Node][4]    | ✅ [build `>=22`][5]; [`node22` / `node24` / `latest`][6] | ✅ [runtime version in target string][13] | ✅ [build `>=22.15.0`][14]                  |
| Entry model      | ✅ [`package.json#bin`, one or many launchers][10]                             | ⚠️ [one `main` only][4]              | ⚠️ [one package entry][5]                                 | ⚠️ [one input or stdin bundle][13]        | ✅ [command array; multi-target output][14] |
| Monorepo         | ✅ [`workspace:` staging][11]                                                  | ❓ [no dedicated flow documented][4] | ❓ [no dedicated flow documented][7]                      | ❓ [no dedicated flow documented][13]     | ❓ [no dedicated flow documented][14]       |
| Installed layout | ✅ [real app tree in home/profile][10]                                         | ⚠️ [in-binary VFS][4]                | ⚠️ [snapshot FS + cache extraction][8]                    | ⚠️ [single executable VFS][13]            | ✅ [extracted app tree in temp/cache][14]   |
| Native addons    | ✅ [normal on-disk loading][10]                                                | ⚠️ [must extract first][4]           | ⚠️ [supported, but extracted to cache][8]                 | ❌ [ship beside binary][13]               | ✅ [extracted before run][14]               |
| Config           | ✅ [low][3] ([npm2exe configuration][12])                                      | ⚠️ [medium][4]                       | ⚠️ [medium / high][7]                                     | ⚠️ [medium / high][13]                    | ⚠️ [low / medium][14]                       |
| Wrapper form     | ✅ [7z SFX][10] / [`makeself`][10]                                             | ⚠️ [injected stock Node binary][4]   | ⚠️ [patched runtime][5] or [SEA][8]                       | ⚠️ [compiled single executable][13]       | ⚠️ [Rust self-extractor][14]                |

In short: [**SEA**][4], [**pkg**][5], and [**nexe**][13] lean toward a tighter single-binary image, while [**caxa**][14] and [**npm2exe**][10] lean toward extracting and running a real app tree. That makes `npm2exe` especially friendly to regular Node.js install behavior and [`workspace:` monorepos][11].

## GitHub Actions release workflow

```shell
cd path/to/your/project

npx git-utility download https://github.com/idea2app/npm2exe main .github/workflows/ .github/workflows/
```

Notes:

- The downloaded workflow example keeps a [single packaging step][15], so no per-OS `shell` switching is needed.
- Build on each native runner instead of cross-packaging from one host, because `npm2exe` currently uses different [wrapping backends for Windows and POSIX targets][10].
- Linux/macOS outputs are [self-extracting shell archives][10]; Windows output is a [self-extracting `.exe`][10].
- The release asset is the [installer wrapper][10]. The [final launcher][10] gets installed into the user home/profile when the asset is executed.
- [Code signing][4], [notarization][10], and [checksum publishing][14] are intentionally left to the application repository.

[1]: https://libraries.io/npm/npm2exe
[2]: https://github.com/idea2app/npm2exe/actions/workflows/main.yml
[3]: https://npm.im/npm2exe
[4]: https://nodejs.org/api/single-executable-applications.html
[5]: https://yao-pkg.github.io/pkg/guide/getting-started
[6]: https://yao-pkg.github.io/pkg/guide/targets
[7]: https://yao-pkg.github.io/pkg/guide/configuration
[8]: https://yao-pkg.github.io/pkg/guide/native-addons
[9]: https://github.com/idea2app/npm2exe/blob/master/package.json
[10]: https://github.com/idea2app/npm2exe/blob/master/src/workflow.ts
[11]: https://github.com/idea2app/npm2exe/blob/master/src/workspace.ts
[12]: https://github.com/idea2app/npm2exe/blob/master/src/index.tsx
[13]: https://github.com/nexe/nexe/blob/master/README.md
[14]: https://github.com/cdxgen/caxa/blob/main/README.md
[15]: https://github.com/idea2app/npm2exe/blob/master/.github/workflows/main.yml

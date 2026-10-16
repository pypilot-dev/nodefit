# nodefit

[![npm](https://img.shields.io/npm/v/nodefit?color=blue&logo=npm)](https://www.npmjs.com/package/nodefit)
[![Node](https://img.shields.io/node/v/nodefit?logo=node.js&logoColor=white)](https://www.npmjs.com/package/nodefit)
[![License: AGPL-3.0-or-later](https://img.shields.io/npm/l/nodefit?color=blue)](https://github.com/pypilot-dev/nodefit/blob/main/LICENSE)

Finds the Node.js version every dependency of a project supports, and
catches native modules with no prebuilt binary before `npm install` falls
back to node-gyp and fails with compiler errors.

Every package narrows the Node releases a project can run on: its
`engines.node` range, and for a native module (better-sqlite3, sharp,
bcrypt, canvas…) the releases it ships a prebuilt binary for on your
platform. nodefit intersects them, recommends a release, and when nothing
fits, names the two packages that clash.

```console
$ npx nodefit doctor
nodefit doctor — /work/shop
  platform         : linux-x64
  package manager  : npm (package-lock.json, 412 packages)

── Environment ─────────────────────────────────────────
  node             : 18.20.4 (/usr/bin/node)
  version managers : fnm
  node releases    : newest 24.11.0 (network)

── Project ─────────────────────────────────────────────
  name             : shop
  dependencies     : 2 prod, 1 dev
  node pins        : engines >=18

── Compatibility ───────────────────────────────────────
  supported Node   : 20.19.5+, 22
  recommended      : 22.21.1 (LTS Jod)
    • better-sqlite3 12.4.1  20, 22  prebuilt (downloaded by prebuild-install) · engines >=18
    • rollup 4.50.0          20.19.5+, 21–24  engines >=20.19.0 · via vite · dev
    + 410 packages not listed (see --json)

── Findings ────────────────────────────────────────────
  [ERROR] Node 18.20 does not fit this project
          Node 18.20.4 is outside what better-sqlite3 12.4.1 (20, 22) and rollup 4.50.0 (20.19.5+, 21–24) support. Switch to Node 22, the newest LTS release that fits every dependency.
          fix: fnm use 22
  [WARN ] npm will compile better-sqlite3 with node-gyp on Node 18.20
          better-sqlite3 12.4.1 has no prebuilt binary for Node 18.20 on linux-x64, so npm builds it from source, which needs Python and a C++ toolchain. Prebuilt binaries exist for Node 20, 22.
          fix: fnm use 22
```

## Install

Nothing to install: `npx nodefit doctor` runs it. Or add it to a project
(`npm install --save-dev nodefit`) or globally (`npm install -g nodefit`).
It runs on Node 18 and later, with no dependencies of its own.

## Commands

| Command | What it does |
|---|---|
| `nodefit doctor [--path <dir>] [--json] [--prod] [--offline]` | Checks the project against this machine's Node and every Node release. `--prod` leaves out packages only dev dependencies need. |
| `nodefit check <package[@range]>` | Can this package install and run on the project's Node? `nodefit check sharp`, `nodefit check better-sqlite3@^11`, `nodefit check bcrypt@5.1.1`. |
| `nodefit pin [version]` | Writes the recommended release (or the one given) to the project's pin file: the `.nvmrc`, `.node-version`, `.tool-versions`, `mise.toml` or `volta` entry it already uses, else a new `.nvmrc`. |
| `nodefit lsp` | Runs the language server (editors start this). |

Exit status: `0` no errors, `1` the check found errors, `2` nodefit itself
failed. `--json` prints the whole report; each set of releases appears as
its short form and the full version list.

Colours appear only on a terminal and never when `NO_COLOR` is set.

## How it decides

- **What is installed.** The lockfile (`package-lock.json`, `bun.lock`,
  `pnpm-lock.yaml`, `yarn.lock`) when there is one, skipping packages whose
  `os`/`cpu` exclude this machine, as npm does. Without a readable lockfile,
  each dependency in package.json is resolved the way npm would resolve it
  today.
- **What each package allows.** `engines.node`, read the way npm reads it.
  For a native module, the Node releases with a prebuilt binary for this
  platform: those are the releases where it installs without a compiler.
- **Source builds do not narrow the set.** A package that always compiles
  with node-gyp gets a warning about the toolchain it needs, but no Node
  release avoids that, so it does not shrink the recommendation.
- **The recommendation** is the newest LTS release every package allows,
  else the newest release.
- **When nothing fits**, nodefit names the package with the lowest ceiling
  and the one with the highest floor, with the releases each supports.

Registry documents are cached for a day and Node's release list is cached
too, so repeated runs are fast and `--offline` works from the cache.

## Editors

The language server underlines dependencies in package.json that do not
fit (a transitive package's problem lands on the direct dependency that
pulls it in), shows each dependency's engines, binaries and supported
releases on hover, and offers quick fixes to pin the recommended Node.

- **VS Code**: install the nodefit extension; it bundles the server.
- **Zed and other LSP editors**: run `nodefit lsp --stdio` for `package.json`
  files. Initialization options:
  `{ "notifications": "all" | "problems-only" | "off", "includeDev": true }`.

Besides standard LSP the server sends `nodefit/status` after each check and
answers `nodefit/report` (the doctor report as Markdown) and
`nodefit/check` (`{ "spec": "sharp" }`); see `src/protocol.ts`.

## Library

```ts
import { analyze, formatDoctor, loadInputs } from "nodefit";

const report = await analyze(await loadInputs(process.cwd()));
console.log(report.recommended?.version, report.supported.toString());
for (const f of report.findings) console.log(f.severity, f.title);
```

`checkPackage`, `reportToMarkdown`, `reportToDiagnostics` and `toJson` are
exported too, along with the types in `src/types.ts`.

## License

AGPL-3.0-or-later.

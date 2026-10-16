# nodefit

Finds the Node.js version every dependency of a project supports, and
catches native modules with no prebuilt binary before `npm install` falls
back to node-gyp and fails with compiler errors.

Every package narrows the Node releases a project can run on: its
`engines.node` range, and for a native module (better-sqlite3, sharp,
bcrypt, canvas, node-sass…) the releases it ships a prebuilt binary for on
your platform. nodefit intersects them, recommends a release, and when
nothing fits, names the two packages that clash.

It is [PyPilot](https://github.com/pypilot-dev/pypilot)'s approach, applied to
Node.

```console
$ npx @pypilot-dev/nodefit doctor
...
  supported Node   : none
    • sharp 0.35.5      20.9+, 21–26  prebuilt (per-platform packages) · engines >=20.9.0
    • node-sass 4.14.1  8–14  prebuilt (downloaded at install) · engines >=0.10.0

  [ERROR] No Node release fits every dependency
          node-sass 4.14.1 supports Node up to 14.21.3 (8–14) but sharp 0.35.5 needs at least
          Node 20.9.0 (20.9+, 21–26), so no single release satisfies both.
  [WARN ] node-sass 4.14.1 is deprecated
          npm says: "Node Sass is no longer supported. Please use `sass` or `sass-embedded` instead."
```

## Packages

| Package | What |
|---|---|
| [`packages/nodefit`](packages/nodefit) | The [`@pypilot-dev/nodefit`](https://www.npmjs.com/package/@pypilot-dev/nodefit) npm package: CLI (`doctor`, `check`, `pin`), language server and library. Runs on Node 18+, with no dependencies of its own. |
| [`packages/vscode`](packages/vscode) | The VS Code extension. It bundles the language server: diagnostics on package.json, a status bar entry, notifications with fixes, and the report. |

Editors other than VS Code can run `nodefit lsp --stdio`; see the
[package README](packages/nodefit/README.md#editors).

## How it works

- **What is installed** comes from the lockfile (npm, bun, pnpm, yarn classic
  and berry), or without one from package.json resolved the way npm would.
- **What each package allows** is its `engines.node` range, and for a native
  module the releases with a prebuilt binary for this platform. nodefit knows
  the ways binaries are shipped: per-platform packages (sharp, esbuild,
  @swc/core), binaries in the tarball (prebuildify), downloads at install
  (prebuild-install, node-pre-gyp, node-sass), and packages that always
  compile.
- **Node releases** come from nodejs.org, with each release's native ABI,
  N-API level and end-of-life date; a snapshot ships with the package for
  offline use.
- **This machine** is read too: the `node` on PATH, the version managers
  installed (nvm, nvm-windows, fnm, volta, mise, asdf, n) and the pins the
  project already has (.nvmrc, .node-version, .tool-versions, mise.toml,
  volta, engines, devEngines).

## Development

[Bun](https://bun.sh) is the package manager, test runner and bundler. See
[AGENTS.md](AGENTS.md) for the conventions.

```bash
bun install
bun run typecheck
bun test                         # offline
bun run lint
bun run build
cd packages/vscode && bun run e2e   # the extension in a real VS Code
```

## License

AGPL-3.0-or-later, for both the `nodefit` package and the VS Code
extension, which bundles it.

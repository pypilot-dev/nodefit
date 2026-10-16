<p align="center">
  <img src="media/icon.png" width="128" height="128" alt="nodefit logo" />
</p>

# nodefit for VS Code

Every dependency narrows the set of Node.js releases your project can run on:
its `engines.node` range, and, for a native module, the Node releases it ships
prebuilt binaries for on your platform. nodefit intersects them all, tells you
which release fits, and names the packages that clash, **before** `npm install`
falls back to node-gyp and fails with a page of compiler errors.

## An example

You open a project that depends on `better-sqlite3@^9` and `sharp`, on a
machine running a newer Node than that `better-sqlite3` release was built for.
`npm install` would find no prebuilt binary for your Node's ABI, start
node-gyp, and fail unless Python and a C++ toolchain are installed.

With nodefit:

- the status bar shows an error next to `Node 23.11`, with a tooltip naming the
  Node you run, the release nodefit recommends and every release that fits;
- the `better-sqlite3` entry in `package.json` gets a diagnostic: no prebuilt
  binary for this Node on this platform, so the install would compile from
  source;
- a notification names the problem, with a button for its fix, **Pin Node 22**
  (writes `.nvmrc`, or the pin file the project already uses) or **Switch to
  Node 22** (runs your version manager's command, e.g. `nvm use 22`, in a
  terminal), and **Show report**.

The report lists every package, the Node releases each one allows, which
ones are native modules and how they get their binaries (platform packages
like `sharp`'s `@img/*`, bundled prebuilds, `prebuild-install`,
`node-pre-gyp`, or source only).

## Features

- **Diagnostics, hovers and quick fixes** on `package.json` dependencies.
- **Status bar** with the Node release the project fits; click it for the report.
- **Notifications** for new errors and warnings, once per session each, with
  buttons that apply the fix.
- **Lockfile aware**: reads `package-lock.json`, `npm-shrinkwrap.json`,
  `bun.lock`, `pnpm-lock.yaml` and `yarn.lock`, so transitive native modules
  count too.
- **Pin files**: `.nvmrc`, `.node-version`, `.tool-versions`, `mise.toml`,
  Volta and `engines`. Editing any of them re-runs the check.
- **No install**: the language server is bundled and runs on VS Code's own
  Node; it reads the npm registry and nodejs.org, and caches what it fetches.

## Commands

| Command | What it does |
|---|---|
| `nodefit: Show Report` | The full report for the project, as a Markdown preview |
| `nodefit: Check a Package…` | Can a package (`sharp`, `better-sqlite3@^11`, `bcrypt@5.1.1`) install and run here, and on which Node releases? |
| `nodefit: Pin Node Version…` | Writes the recommended (or a chosen) version into the project's pin file |
| `nodefit: Re-check the Project` | Re-reads the project and runs the check again |
| `nodefit: Show Output` | The language server's log |

## Settings

| Setting | Default | |
|---|---|---|
| `nodefit.notifications` | `problems-only` | `problems-only`: errors and warnings. `all`: also say once when everything fits. `off`: none; the status bar and diagnostics remain. |
| `nodefit.includeDevDependencies` | `true` | Count devDependencies too. Turn off when your tooling runs on a different Node than the app. |
| `nodefit.trace.server` | `off` | Log the language server traffic to the nodefit output (`messages`, `verbose`). |

## The `nodefit` CLI

The extension runs the same engine as the [`@pypilot-dev/nodefit`](https://www.npmjs.com/package/@pypilot-dev/nodefit)
npm package. Outside VS Code, or in CI:

```bash
npx @pypilot-dev/nodefit doctor              # the same report, in the terminal
npx @pypilot-dev/nodefit check sharp         # one package
npx @pypilot-dev/nodefit pin                 # pin the recommended Node
```

## Known limitations

- In a multi-root workspace, nodefit checks the first folder that has a
  `package.json` at its root.
- Requires VS Code 1.85 or later.

## License

AGPL-3.0-or-later, like the `nodefit` engine it bundles. Source: [pypilot-dev/nodefit](https://github.com/pypilot-dev/nodefit/tree/main/packages/vscode).

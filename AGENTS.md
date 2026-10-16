# Working on nodefit

Read this before changing anything. It applies to AI agents and humans alike.

nodefit is PyPilot's idea applied to Node.js: every dependency narrows the set
of Node releases a project can run on (its `engines.node` range, and for a
native module the releases it ships prebuilt binaries for on this platform).
nodefit computes the intersection, recommends a release, and names the
packages that clash, before an install falls back to node-gyp and fails with
compiler errors.

## Layout

| Path | What |
|---|---|
| `packages/nodefit/` | the npm package `@pypilot-dev/nodefit` (command `nodefit`): library, CLI (`nodefit doctor/check/pin/lsp`) and language server |
| `packages/nodefit/src/types.ts` | **the contract between modules**. Change it deliberately, never casually |
| `packages/nodefit/src/node/` | Node releases (`loadNodeIndex`) and `NodeSet` |
| `packages/nodefit/src/registry/` | npm registry client (abbreviated packuments, disk cache) and `FixtureRegistry` for tests |
| `packages/nodefit/src/native/` | native module classification and prebuilt-binary availability |
| `packages/nodefit/src/project/` | package.json, lockfiles, Node pins, version managers |
| `packages/nodefit/src/analyze/` | intersects everything into a `Report` |
| `packages/nodefit/src/cli/`, `src/lsp/` | presentation |
| `packages/nodefit/src/protocol.ts` | language-server messages beyond standard LSP |
| `packages/vscode/` | the VS Code extension; bundles `nodefit` and runs its language server |

## Tooling

Bun is the package manager, test runner and bundler. The published package
runs on **Node >= 18** (users run `npx @pypilot-dev/nodefit` on whatever Node they have),
so source code must only use Node APIs available in Node 18: no `Bun.*`
outside build scripts and tests.

```bash
bun install
bun run typecheck      # tsc --noEmit for every package
bun test               # all tests; offline
bun run lint           # biome
bun run format         # biome --write
bun run build
```

## Rules

- **Tests are offline.** Use `FixtureRegistry`, recorded JSON under
  `packages/nodefit/test/fixtures/`, and an injected `HttpClient`. Live
  checks belong in scripts, not in `bun test`.
- Library code never prints. The CLI and server present.
- No runtime `dependencies` in `packages/nodefit`: everything is bundled into
  `dist/` by `build.ts`, so `npx @pypilot-dev/nodefit` installs one package.
- Comments explain why, not what. Match the surrounding style.
- LF line endings.

## Commits

- Small, logical commits: `feat(scope): …`, `fix(…)`, `test: …`, `docs: …`,
  `chore: …`, `release: …`, each with a body explaining why.
- **Never** add `Co-Authored-By` or any AI trailer, and don't write that
  phrase in messages. Commits are signed (`git commit -S`).
- Every commit must pass `bun run typecheck`, `bun test` and `bun run lint`.
- Do not push, tag or publish unless asked.

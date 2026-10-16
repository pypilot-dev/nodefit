/**
 * Bundles the published package with Bun. Everything, dependencies included,
 * goes into `dist/`, so `npx @pypilot-dev/nodefit` installs nothing else and starts fast.
 * The output targets Node (>= 18): users run nodefit on the Node they have,
 * which is often the one they need help with.
 *
 *   bun run build.ts
 */

import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Chunk names carry content hashes, so chunks from earlier builds would pile
// up in dist/ and be published. Remove files one by one: a recursive
// directory delete is unreliable under Bun on Windows.
function clear(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) clear(path);
    else rmSync(path, { force: true });
  }
}
clear("./dist");

const result = await Bun.build({
  entrypoints: ["./src/index.ts", "./src/cli.ts", "./src/lsp.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  splitting: true,
  sourcemap: "none",
  minify: false,
  naming: { entry: "[name].js", chunk: "chunks/[name]-[hash].js" },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// npm links `bin` entries as-is; the shebang makes them runnable on POSIX.
const cli = "./dist/cli.js";
const text = readFileSync(cli, "utf8");
if (!text.startsWith("#!")) writeFileSync(cli, `#!/usr/bin/env node\n${text}`);
if (process.platform !== "win32") chmodSync(cli, 0o755);

console.log(`Built ${result.outputs.length} file(s) to ./dist`);

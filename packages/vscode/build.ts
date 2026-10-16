/**
 * Bundles the extension with Bun. Two CommonJS entry points for VS Code's
 * Node: the extension itself and the language server it starts as a child
 * process. Everything, the nodefit engine included, ends up in `out/`, so the
 * VSIX ships no node_modules.
 *
 * `@pypilot-dev/nodefit` and `@pypilot-dev/nodefit/lsp` resolve to the engine's TypeScript source
 * through the `paths` in tsconfig.json (Bun's bundler honours them before
 * node_modules), so the extension builds without building packages/nodefit
 * first and always carries the engine from the same commit.
 *
 *   bun run build.ts                # one-shot build
 *   bun run build.ts --watch        # rebuild on changes to src/ or the engine
 *   bun run build.ts --production   # release build (no sourcemaps)
 */

import { existsSync, watch as fsWatch, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const watchMode = process.argv.includes("--watch");
// .vscodeignore ships no *.map, so release builds must not emit a
// `sourceMappingURL` comment pointing at a file that is not in the VSIX.
const production = process.argv.includes("--production");

// Maps left over from a development build would otherwise sit next to the
// release bundle; .vscodeignore drops them, but out/ should match the VSIX.
// File by file: Bun's recursive rmSync leaves directories behind on Windows.
if (production && existsSync("./out")) {
  for (const name of readdirSync("./out")) if (name.endsWith(".map")) unlinkSync(join("./out", name));
}

async function build(): Promise<boolean> {
  const result = await Bun.build({
    entrypoints: ["./src/extension.ts", "./src/server.ts"],
    outdir: "./out",
    target: "node",
    // VS Code loads extensions with require().
    format: "cjs",
    // Provided by the host at runtime; never bundle it.
    external: ["vscode"],
    sourcemap: production ? "none" : "linked",
    minify: false,
    naming: "[name].js",
  });

  if (!result.success) {
    console.error("Build failed:");
    for (const log of result.logs) console.error(" ", log);
    return false;
  }

  const now = new Date().toLocaleTimeString();
  console.log(`[${now}] Built ${result.outputs.length} file(s) to ./out`);
  return true;
}

const built = await build();
if (!built && !watchMode) process.exit(1);

if (watchMode) {
  console.log("Watching for changes… (Ctrl-C to stop)");

  // A single save fires several events, so coalesce them, and keep watching
  // when a build fails: a syntax error must not kill the watcher.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onChange = (_event: string, filename: string | null) => {
    if (!filename?.endsWith(".ts")) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      console.log(`Changed: ${filename}`);
      build().then((ok) => {
        if (!ok) console.error("Build failed; fix the error and save again.");
      });
    }, 100);
  };
  for (const dir of [join(import.meta.dir, "src"), join(import.meta.dir, "..", "nodefit", "src")]) {
    fsWatch(dir, { recursive: true }, onChange);
  }

  await new Promise(() => {});
}

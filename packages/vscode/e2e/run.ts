/**
 * End-to-end check in a real VS Code, kept out of `bun test` because it
 * downloads VS Code and needs a display. Uses a throwaway profile and
 * extensions directory, so the developer's own VS Code is untouched.
 *
 *   bun run e2e
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runTests } from "@vscode/test-electron";

const root = resolve(import.meta.dir, "..");

const built = await Bun.build({
  entrypoints: [join(import.meta.dir, "suite.ts")],
  outdir: join(root, "out-e2e"),
  target: "node",
  format: "cjs",
  external: ["vscode"],
});
if (!built.success) throw new AggregateError(built.logs, "building the e2e suite failed");

// A project nodefit must complain about: node-sass 4 has binaries for Node
// 8-14 only, and .nvmrc pins a Node that sharp cannot run on.
const project = mkdtempSync(join(tmpdir(), "nodefit-e2e-"));
writeFileSync(
  join(project, "package.json"),
  `${JSON.stringify({ name: "legacy-app", version: "1.0.0", dependencies: { "node-sass": "4.14.1", sharp: "^0.35.0" } }, null, 2)}\n`,
);
writeFileSync(join(project, ".nvmrc"), "16\n");
const profile = mkdtempSync(join(tmpdir(), "nodefit-e2e-profile-"));
const logFile = join(profile, "e2e.log");

try {
  await runTests({
    version: "1.85.0",
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, "out-e2e", "suite.js"),
    extensionTestsEnv: { NODEFIT_E2E_LOG: logFile },
    launchArgs: [
      project,
      "--disable-extensions",
      "--disable-workspace-trust",
      `--user-data-dir=${join(profile, "user")}`,
      `--extensions-dir=${join(profile, "extensions")}`,
    ],
  });
} finally {
  try {
    console.log(readFileSync(logFile, "utf8"));
  } catch {
    console.log("(the suite wrote no log)");
  }
  rmSync(project, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true });
}

/**
 * Runs inside a real VS Code (see run.ts): the extension must activate on a
 * project with a package.json, its language server must check it and put
 * diagnostics on the dependency entries, and the report command must open.
 */
import { appendFileSync } from "node:fs";
import * as vscode from "vscode";

const EXTENSION_ID = "AbdullahMasood-005.nodefit-vscode";

/** The runner reads this file: the test host's stdout does not always reach it. */
function log(line: string): void {
  console.log(line);
  const file = process.env.NODEFIT_E2E_LOG;
  if (file)
    appendFileSync(
      file,
      `${line}
`,
    );
}

async function waitFor<T>(what: string, probe: () => T | undefined, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export async function run(): Promise<void> {
  log("[e2e] suite started");
  const deadline = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("the e2e suite took longer than 4 minutes")), 240_000),
  );
  try {
    await Promise.race([steps(), deadline]);
  } catch (err) {
    log(`[e2e] FAIL: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

async function steps(): Promise<void> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  if (!extension) throw new Error(`${EXTENSION_ID} is not loaded`);
  await extension.activate();
  log("[e2e] extension active");

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error("no workspace folder");
  const manifest = vscode.Uri.joinPath(folder.uri, "package.json");
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(manifest));

  const diagnostics = await waitFor("diagnostics on package.json", () => {
    const found = vscode.languages.getDiagnostics(manifest).filter((d) => d.source === "nodefit");
    return found.length ? found : undefined;
  });
  const text = (await vscode.workspace.openTextDocument(manifest)).getText();
  for (const d of diagnostics) {
    const severity = vscode.DiagnosticSeverity[d.severity];
    log(
      `[e2e] ${severity} on "${text.slice(document(text).offsetAt(d.range.start), document(text).offsetAt(d.range.end))}": ${d.message.split("\n")[0]}`,
    );
  }
  if (!diagnostics.some((d) => d.message.includes("node-sass"))) throw new Error("no diagnostic mentions node-sass");

  await vscode.commands.executeCommand("nodefit.showReport");
  const report = await waitFor("the report document", () =>
    vscode.workspace.textDocuments.find((d) => d.uri.scheme === "nodefit" && d.getText().length > 0),
  );
  const firstLines = report.getText().split("\n").slice(0, 6).join(" | ");
  log(`[e2e] report opened (${report.getText().length} chars): ${firstLines}`);
  log("[e2e] PASS");
}

/** Offset arithmetic over the raw text, without depending on an open editor. */
function document(text: string) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return { offsetAt: (p: vscode.Position) => (starts[p.line] ?? 0) + p.character };
}

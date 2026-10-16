/**
 * nodefit for VS Code: starts nodefit's language server (bundled into
 * out/server.js and run on VS Code's own Node over IPC, so the user installs
 * nothing else) and turns its `nodefit/status` notifications into a status
 * bar item and notifications with buttons that apply the fix.
 *
 * Diagnostics, hovers and code actions on package.json are standard LSP and
 * need nothing here.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "@pypilot-dev/nodefit";
import {
  CHECK_REQUEST,
  type CheckParams,
  type CheckResult,
  COMMANDS,
  REPORT_REQUEST,
  type ReportResult,
  STATUS_NOTIFICATION,
  type StatusParams,
} from "@pypilot-dev/nodefit/protocol";
import * as vscode from "vscode";
import {
  ExecuteCommandRequest,
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";
import { MarkdownDocuments, SCHEME } from "./report";
import { fixAction, type NotificationMode, newProblems, notificationMessage, statusBarView } from "./view";

const REPORT_NAME = "nodefit report";

/** Files whose change can change the answer; the server re-checks on them. */
const WATCHED =
  "**/{package.json,package-lock.json,npm-shrinkwrap.json,bun.lock,bun.lockb,pnpm-lock.yaml,yarn.lock," +
  ".nvmrc,.node-version,.tool-versions,mise.toml,.mise.toml}";

/** Server commands the extension also puts in the palette. */
const SERVER_COMMANDS: readonly string[] = [COMMANDS.pinNode, COMMANDS.refresh];

interface SessionState {
  /** The last status the server sent, for the pin quick pick. */
  status?: StatusParams;
  /** Finding ids already notified about in this session. */
  seen: Set<string>;
  /** Whether the "everything fits" message has been shown ("all" mode). */
  toldFits: boolean;
}

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const docs = new MarkdownDocuments();
  context.subscriptions.push(docs, vscode.workspace.registerTextDocumentContentProvider(SCHEME, docs));

  // Created before the server starts so a server that fails to start still
  // leaves something to click.
  const item = vscode.window.createStatusBarItem("nodefit.status", vscode.StatusBarAlignment.Left, 100);
  item.name = "nodefit";
  context.subscriptions.push(item);

  const output = vscode.window.createOutputChannel("nodefit");
  context.subscriptions.push(output);
  const state: SessionState = { seen: new Set(), toldFits: false };

  const r = (id: string, fn: (...args: never[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  r("nodefit.showReport", () => withClient((c) => showReport(c, docs)));
  r("nodefit.checkPackage", () => withClient((c) => checkPackage(c, docs)));
  r("nodefit.showOutput", () => output.show(true));

  // v0.1 runs one server, for the first folder that is a Node project.
  const folder = vscode.workspace.workspaceFolders?.find((f) => existsSync(join(f.uri.fsPath, "package.json")));
  if (!folder) {
    // Reached through onCommand activation: say why nothing happens.
    for (const id of SERVER_COMMANDS) r(id, () => withClient(async () => undefined));
    return;
  }

  const c = startClient(context, folder, output, state);
  client = c;
  setStatus(item, { state: "checking", text: "nodefit", tooltip: "", supported: "", findings: [] });
  c.onNotification(STATUS_NOTIFICATION, (params: StatusParams) => {
    state.status = params;
    setStatus(item, params);
    if (params.state === "checking") return;
    notify(params, state, docs).catch((err) => output.appendLine(`nodefit: notification failed: ${err}`));
    if (docs.isOpen(REPORT_NAME)) refreshReport(c, docs).catch(() => undefined);
  });
  context.subscriptions.push({ dispose: () => c.stop() });

  try {
    await c.start();
  } catch (err) {
    item.text = "$(error) nodefit";
    item.tooltip = `nodefit: the language server failed to start. ${err}\n\nClick to show the output.`;
    item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    item.command = "nodefit.showOutput";
    item.show();
    vscode.window.showErrorMessage(`nodefit: the language server failed to start. ${err}`);
    return;
  }

  // vscode-languageclient registers a VS Code command for every command the
  // server advertises and routes it through `middleware.executeCommand`
  // (which adds the pin quick pick). Registering the same ids here would
  // throw, so only fill in what the server did not advertise.
  const advertised = c.initializeResult?.capabilities.executeCommandProvider?.commands ?? [];
  for (const id of SERVER_COMMANDS) {
    if (advertised.includes(id)) continue;
    r(id, (...args: unknown[]) =>
      withClient((lc) =>
        runServerCommand(state, id, args, (command, a) =>
          lc.sendRequest(ExecuteCommandRequest.type, { command, arguments: a }),
        ),
      ),
    );
  }
}

export async function deactivate(): Promise<void> {
  await client?.stop();
}

function startClient(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder,
  output: vscode.OutputChannel,
  state: SessionState,
): LanguageClient {
  const module = context.asAbsolutePath(join("out", "server.js"));
  const serverOptions: ServerOptions = {
    run: { module, transport: TransportKind.ipc },
    debug: { module, transport: TransportKind.ipc, options: { execArgv: ["--nolazy", "--inspect=6011"] } },
  };

  const config = vscode.workspace.getConfiguration("nodefit", folder.uri);
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "json", pattern: "**/package.json" }],
    workspaceFolder: folder,
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, WATCHED)),
      configurationSection: "nodefit",
    },
    initializationOptions: {
      // The extension shows its own notifications (with buttons that apply
      // the fix), so the server must not also send window/showMessage.
      clientHandlesNotifications: true,
      notifications: config.get<NotificationMode>("notifications", "problems-only"),
      includeDev: config.get<boolean>("includeDevDependencies", true),
    },
    outputChannel: output,
    middleware: {
      executeCommand: (command, args, next) =>
        withClient(() => runServerCommand(state, command, args, async (cmd, a) => next(cmd, a))),
    },
  };

  // The id "nodefit" makes vscode-languageclient read `nodefit.trace.server`.
  return new LanguageClient("nodefit", "nodefit", serverOptions, clientOptions);
}

/**
 * Runs a server command from the palette, a code action or a notification
 * button. The palette passes no arguments, so pinning asks for the version.
 */
async function runServerCommand(
  state: SessionState,
  command: string,
  args: unknown[],
  send: (command: string, args: unknown[]) => Promise<unknown>,
): Promise<unknown> {
  if (command !== COMMANDS.pinNode) return send(command, args);
  const version = typeof args[0] === "string" ? args[0] : await pickVersion(state.status);
  if (!version) return undefined;
  const result = await send(command, [version]);
  vscode.window.showInformationMessage(`nodefit: pinned Node ${version}.`);
  return result;
}

function setStatus(item: vscode.StatusBarItem, status: StatusParams): void {
  const view = statusBarView(status);
  item.text = view.text;
  item.tooltip = view.tooltip;
  item.backgroundColor = view.background
    ? new vscode.ThemeColor(`statusBarItem.${view.background}Background`)
    : undefined;
  item.command = "nodefit.showReport";
  item.show();
}

async function withClient(fn: (c: LanguageClient) => Promise<unknown>): Promise<unknown> {
  if (!client) {
    vscode.window.showWarningMessage("nodefit: open a folder that has a package.json first.");
    return undefined;
  }
  try {
    return await fn(client);
  } catch (err) {
    vscode.window.showErrorMessage(`nodefit: ${err instanceof Error ? err.message : err}`);
    return undefined;
  }
}

async function notify(status: StatusParams, state: SessionState, docs: MarkdownDocuments): Promise<void> {
  const mode = vscode.workspace.getConfiguration("nodefit").get<NotificationMode>("notifications", "problems-only");
  const problems = newProblems(status.findings, state.seen, mode);
  const first = problems[0];
  if (first) {
    await showProblem(first, problems.length - 1, docs);
  } else if (mode === "all" && status.state === "ok" && !state.toldFits) {
    state.toldFits = true;
    const recommended = status.recommended ? ` Node ${status.recommended} is recommended.` : "";
    vscode.window.showInformationMessage(`nodefit: every dependency fits ${status.supported}.${recommended}`);
  }
}

async function showProblem(finding: Finding, others: number, docs: MarkdownDocuments): Promise<void> {
  const action = fixAction(finding.fix);
  const report = "Show report";
  const buttons = action ? [action.label, report] : [report];
  const show = finding.severity === "error" ? vscode.window.showErrorMessage : vscode.window.showWarningMessage;
  const choice = await show(notificationMessage(finding, others), ...buttons);
  if (choice === report) {
    await withClient((c) => showReport(c, docs));
  } else if (action && choice === action.label) {
    if (action.kind === "pin-node") {
      // Through the VS Code command, so it takes the same path as a code action.
      await vscode.commands.executeCommand(COMMANDS.pinNode, action.version);
    } else if (action.command) {
      // In a terminal rather than a child process: version managers (nvm in
      // particular) change the shell they run in, and the user sees it work.
      const terminal = vscode.window.createTerminal({ name: "nodefit" });
      terminal.show();
      terminal.sendText(action.command);
    } else {
      vscode.window.showInformationMessage(
        `nodefit: switch this machine to Node ${action.version} with your version manager, ` +
          `e.g. \`nvm install ${action.version}\`, \`fnm use --install-if-missing ${action.version}\` ` +
          `or \`volta install node@${action.version}\`.`,
      );
    }
  }
}

async function showReport(c: LanguageClient, docs: MarkdownDocuments): Promise<void> {
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "nodefit: building the report…" },
    () => c.sendRequest<ReportResult>(REPORT_REQUEST),
  );
  await docs.show(REPORT_NAME, result.markdown);
}

async function refreshReport(c: LanguageClient, docs: MarkdownDocuments): Promise<void> {
  const result = await c.sendRequest<ReportResult>(REPORT_REQUEST);
  docs.set(REPORT_NAME, result.markdown);
}

async function checkPackage(c: LanguageClient, docs: MarkdownDocuments): Promise<void> {
  const spec = (
    await vscode.window.showInputBox({
      title: "nodefit: Check a package",
      prompt: "Which Node releases can this package install and run on here?",
      placeHolder: "Package to check (e.g. sharp, better-sqlite3@^11)",
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() === "" ? "Enter a package name" : undefined),
    })
  )?.trim();
  if (!spec) return;
  const params: CheckParams = { spec };
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `nodefit: checking ${spec}…` },
    () => c.sendRequest<CheckResult>(CHECK_REQUEST, params),
  );
  await docs.show(`nodefit check ${spec}`, result.markdown);
}

async function pickVersion(status: StatusParams | undefined): Promise<string | undefined> {
  const other = "Other…";
  const items: vscode.QuickPickItem[] = [];
  if (status?.recommended) {
    items.push({ label: status.recommended, description: "recommended", detail: `Supported: ${status.supported}` });
  }
  if (status?.current && status.current !== status.recommended) {
    items.push({ label: status.current, description: "the Node this project runs on now" });
  }
  items.push({ label: other, description: "type a version" });
  const picked = await vscode.window.showQuickPick(items, {
    title: "nodefit: Pin the project's Node version",
    placeHolder: "Writes the version into .nvmrc (or the pin file the project already uses)",
  });
  if (!picked) return undefined;
  if (picked.label !== other) return picked.label;
  const typed = await vscode.window.showInputBox({
    title: "nodefit: Pin Node",
    prompt: "Node version to pin",
    placeHolder: "e.g. 22, 22.11.0, lts/jod",
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() === "" ? "Enter a Node version" : undefined),
  });
  return typed?.trim() || undefined;
}

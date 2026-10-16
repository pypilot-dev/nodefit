/**
 * nodefit's language server: standard LSP plus the messages in ../protocol.ts.
 *
 * One analysis per workspace root, re-run (debounced, never two at once)
 * when package.json, a lockfile or a Node pin changes. Logs go through
 * `connection.console`: with the stdio transport, stdout is the protocol.
 */

import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type CodeAction,
  CodeActionKind,
  createConnection,
  DidChangeWatchedFilesNotification,
  type InitializeParams,
  type InitializeResult,
  ProposedFeatures,
  ResponseError,
  TextDocumentSyncKind,
  TextDocuments,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { type AnalyzeOptions, analyze } from "../analyze";
import { checkPackage } from "../analyze/check";
import { loadEnvironment, loadInputs } from "../analyze/session";
import { fixText } from "../cli/describe";
import { writePin } from "../project";
import {
  CHECK_REQUEST,
  type CheckParams,
  type CheckResult,
  COMMANDS,
  REPORT_REQUEST,
  type ReportResult,
  STATUS_NOTIFICATION,
  type StatusParams,
} from "../protocol";
import type { Finding, Fix, ProjectInfo, Report } from "../types";
import { type Diagnostic, dependencyAt, reportToDiagnostics } from "./diagnostics";
import { checkToMarkdown, packageMarkdown, reportToMarkdown } from "./markdown";
import { checkingStatus, statusFor } from "./status";

const DEBOUNCE_MS = 500;

/** Files whose change can change the answer. */
const WATCHED = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "bun.lock",
  "bun.lockb",
  "pnpm-lock.yaml",
  "yarn.lock",
  ".nvmrc",
  ".node-version",
  ".tool-versions",
  "mise.toml",
  ".mise.toml",
];

export interface Settings {
  notifications: "all" | "problems-only" | "off";
  includeDev: boolean;
  /** The VS Code extension shows its own notifications from the status messages. */
  clientHandlesNotifications: boolean;
}

/**
 * Merge editor settings: initializationOptions, or a didChangeConfiguration
 * payload (VS Code sends the `nodefit` section, where the key is
 * `includeDevDependencies`; Zed sends what the user wrote).
 */
export function readSettings(raw: unknown, base: Settings): Settings {
  const outer = isObject(raw) ? raw : {};
  const s = isObject(outer.nodefit) ? outer.nodefit : outer;
  const next = { ...base };
  if (s.notifications === "all" || s.notifications === "problems-only" || s.notifications === "off") {
    next.notifications = s.notifications;
  }
  const dev = s.includeDev ?? s.includeDevDependencies;
  if (typeof dev === "boolean") next.includeDev = dev;
  if (typeof s.clientHandlesNotifications === "boolean") next.clientHandlesNotifications = s.clientHandlesNotifications;
  return next;
}

/** Quick fixes for nodefit's diagnostics: pin the version a fix names, or check again. */
export function codeActionsFor(diagnostics: Diagnostic[], pinFile: string): CodeAction[] {
  const actions = new Map<string, CodeAction>();
  for (const d of diagnostics) {
    if (d.source !== "nodefit") continue;
    const fix = d.data?.fix;
    // A use-node fix names the release the shell should switch to; pinning
    // it makes every machine (and CI) pick the same one.
    if (fix && (fix.kind === "pin-node" || fix.kind === "use-node")) {
      const title = `Pin Node ${fix.version} in ${pinFile}`;
      const known = actions.get(title);
      if (known) known.diagnostics?.push(d);
      else {
        actions.set(title, {
          title,
          kind: CodeActionKind.QuickFix,
          diagnostics: [d],
          isPreferred: true,
          command: { title, command: COMMANDS.pinNode, arguments: [fix.version] },
        });
      }
    }
  }
  if (diagnostics.some((d) => d.source === "nodefit")) {
    actions.set("Check again", {
      title: "Check again",
      kind: CodeActionKind.QuickFix,
      command: { title: "Check again", command: COMMANDS.refresh },
    });
  }
  return [...actions.values()];
}

/** The file `nodefit pin` would write: the exact pin in use, else .nvmrc. */
export function pinFileName(project: ProjectInfo | undefined): string {
  const pin = project?.pins.find((p) => p.exact);
  if (!pin) return ".nvmrc";
  return pin.source === "volta" ? "package.json" : basename(pin.file);
}

export function startServer(): void {
  const connection = createConnection(ProposedFeatures.all);
  const documents = new TextDocuments(TextDocument);
  const log = connection.console;

  let root = process.cwd();
  let settings: Settings = { notifications: "problems-only", includeDev: true, clientHandlesNotifications: false };
  let watchRegistration = false;
  let inputs: AnalyzeOptions | undefined;
  let report: Report | undefined;
  let status: StatusParams | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Findings already shown this session, by id. */
  const notified = new Set<string>();

  const manifest = () => join(root, "package.json");
  const samePath = (a: string, b: string) =>
    process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
  const uriPath = (uri: string) => {
    try {
      return fileURLToPath(uri);
    } catch {
      return undefined;
    }
  };
  const isManifest = (uri: string) => {
    const path = uriPath(uri);
    return path !== undefined && samePath(path, manifest());
  };
  /** The URI the editor uses for package.json (its own spelling, e.g. VS Code's `c%3A`), else ours. */
  const manifestUri = () => documents.all().find((d) => isManifest(d.uri))?.uri ?? pathToFileURL(manifest()).href;

  const schedule = (delay = DEBOUNCE_MS) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, delay);
  };

  /** Analyse now; a request during a run queues exactly one more. */
  const run = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await analyzeOnce();
      } while (again);
    })().finally(() => {
      running = undefined;
    });
    return running;
  };

  const analyzeOnce = async () => {
    connection.sendNotification(STATUS_NOTIFICATION, checkingStatus(status));
    try {
      const loaded = await loadInputs(root);
      const next = await analyze({ ...loaded, includeDev: settings.includeDev });
      inputs = loaded;
      report = next;
      status = statusFor(next);
      publish();
      connection.sendNotification(STATUS_NOTIFICATION, status);
      notify(next);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`nodefit could not check ${root}: ${message}`);
      status = {
        state: "error",
        text: "Node ?",
        tooltip: `nodefit could not check this project: ${message}`,
        supported: "",
        findings: [],
      };
      connection.sendNotification(STATUS_NOTIFICATION, status);
    }
  };

  const publish = () => {
    if (!report) return;
    const uri = manifestUri();
    let text = documents.get(uri)?.getText();
    if (text === undefined) {
      try {
        text = readFileSync(manifest(), "utf8");
      } catch {
        return;
      }
    }
    connection.sendDiagnostics({ uri, diagnostics: reportToDiagnostics(report, text) });
  };

  /** Editors without their own notifications (Zed) get each problem once per session. */
  const notify = (r: Report) => {
    if (settings.clientHandlesNotifications || settings.notifications === "off") return;
    const fresh = r.findings.filter(
      (f) => (settings.notifications === "all" || f.severity !== "info") && !notified.has(f.id),
    );
    for (const f of fresh) notified.add(f.id);
    for (const f of fresh.slice(0, 3)) void showFinding(f);
  };

  const showFinding = async (f: Finding) => {
    const pin = pinAction(f.fix);
    const run = f.fix?.kind === "use-node" && f.fix.command ? ` Run \`${fixText(f.fix)}\`.` : "";
    try {
      const message = `nodefit: ${f.title}. ${f.detail}${run}`;
      const actions = pin ? [{ title: pin.title }] : [];
      const w = connection.window;
      const choice =
        f.severity === "error"
          ? await w.showErrorMessage(message, ...actions)
          : f.severity === "warning"
            ? await w.showWarningMessage(message, ...actions)
            : await w.showInformationMessage(message, ...actions);
      if (pin && choice?.title === pin.title) await pinNode(pin.version);
    } catch (err) {
      log.warn(`nodefit: could not show a notification: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const pinAction = (fix: Fix | undefined) =>
    fix && (fix.kind === "pin-node" || fix.kind === "use-node")
      ? { title: `Pin Node ${fix.version}`, version: fix.version }
      : undefined;

  const pinNode = async (version: string) => {
    const project = inputs?.project ?? (await loadInputs(root)).project;
    const { file } = await writePin(project, version);
    log.info(`nodefit: pinned Node ${version} in ${file}`);
    // The watcher may not see our own write (or may not exist); check again now.
    schedule(0);
    return { file };
  };

  connection.onInitialize((params: InitializeParams): InitializeResult => {
    const folder = params.workspaceFolders?.[0]?.uri ?? params.rootUri;
    const fromUri = folder ? uriPath(folder) : undefined;
    root = fromUri ?? params.rootPath ?? process.cwd();
    settings = readSettings(params.initializationOptions, settings);
    watchRegistration = Boolean(params.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration);
    return {
      capabilities: {
        textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Incremental, save: { includeText: false } },
        hoverProvider: true,
        codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
        executeCommandProvider: { commands: [COMMANDS.pinNode, COMMANDS.refresh] },
      },
      serverInfo: { name: "nodefit" },
    };
  });

  connection.onInitialized(() => {
    if (watchRegistration) {
      void connection.client
        .register(DidChangeWatchedFilesNotification.type, {
          watchers: WATCHED.map((name) => ({ globPattern: `**/${name}` })),
        })
        .catch((err: unknown) => log.warn(`nodefit: could not watch files: ${String(err)}`));
    }
    void run();
  });

  connection.onDidChangeWatchedFiles(({ changes }) => {
    // Installs touch every package.json under node_modules; only the
    // project's own files (and workspace members') matter.
    const relevant = changes.some((c) => {
      const path = uriPath(c.uri);
      return path !== undefined && !/[\\/]node_modules[\\/]/.test(path) && WATCHED.includes(basename(path));
    });
    if (relevant) schedule();
  });

  connection.onDidChangeConfiguration(({ settings: raw }) => {
    const next = readSettings(raw, settings);
    const rerun = next.includeDev !== settings.includeDev;
    settings = next;
    if (rerun) schedule(0);
  });

  // Ranges move as the user types; the analysis itself waits for a save,
  // since it reads package.json from disk.
  documents.onDidChangeContent(({ document }) => {
    if (isManifest(document.uri)) publish();
  });
  documents.onDidSave(({ document }) => {
    if (isManifest(document.uri)) schedule();
  });
  documents.onDidOpen(({ document }) => {
    if (isManifest(document.uri)) publish();
  });

  connection.onHover(({ textDocument, position }) => {
    if (!report || !isManifest(textDocument.uri)) return null;
    const doc = documents.get(textDocument.uri);
    if (!doc) return null;
    const name = dependencyAt(doc.getText(), doc.offsetAt(position));
    if (!name) return null;
    const pkg = report.packages.find((p) => p.name === name && p.direct);
    const unresolved = report.unresolved.find((u) => u.name === name);
    let value: string | undefined;
    if (pkg) value = packageMarkdown(pkg).join("\n");
    else if (unresolved) value = `**${name}**\n\nnodefit could not look it up: ${unresolved.reason}.`;
    return value ? { contents: { kind: "markdown", value } } : null;
  });

  connection.onCodeAction(({ textDocument, context }) =>
    isManifest(textDocument.uri)
      ? codeActionsFor(context.diagnostics as Diagnostic[], pinFileName(inputs?.project))
      : [],
  );

  connection.onExecuteCommand(async ({ command, arguments: args }) => {
    if (command === COMMANDS.refresh) {
      await run();
      return null;
    }
    if (command === COMMANDS.pinNode) {
      const version = args?.[0];
      if (typeof version !== "string" || !version.trim()) {
        throw new ResponseError(-32602, 'nodefit.pinNode needs the version to pin, e.g. ["22"]');
      }
      try {
        return await pinNode(version.trim().replace(/^v/, ""));
      } catch (err) {
        throw new ResponseError(
          -32603,
          `nodefit could not pin Node ${version}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    throw new ResponseError(-32601, `unknown command ${command}`);
  });

  connection.onRequest(REPORT_REQUEST, async (): Promise<ReportResult> => {
    if (!report || running) await run();
    if (!report) throw new ResponseError(-32603, status?.tooltip ?? "nodefit could not check this project");
    return { markdown: reportToMarkdown(report), findings: report.findings };
  });

  connection.onRequest(CHECK_REQUEST, async (params: CheckParams): Promise<CheckResult> => {
    const spec = params?.spec?.trim();
    if (!spec) throw new ResponseError(-32602, 'nodefit/check needs a package, e.g. { spec: "sharp" }');
    try {
      const environment = inputs ?? (await loadEnvironment());
      const outcome = await checkPackage(spec, { ...environment, ...(inputs ? { project: inputs.project } : {}) });
      return { markdown: checkToMarkdown(outcome), severity: outcome.severity };
    } catch (err) {
      throw new ResponseError(
        -32603,
        `nodefit could not check ${spec}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  connection.onShutdown(() => {
    if (timer) clearTimeout(timer);
  });

  documents.listen(connection);
  connection.listen();
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

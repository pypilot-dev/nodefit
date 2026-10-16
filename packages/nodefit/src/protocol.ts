/**
 * What nodefit's language server says to an editor beyond standard LSP.
 *
 * Standard LSP covers most of it: diagnostics on package.json dependency
 * entries, hover on a dependency name, and code actions that run the
 * commands below. These extra messages drive the VS Code status bar and
 * report view; editors that ignore them (Zed) lose nothing essential.
 */

import type { Finding, Severity } from "./types";

/** Server → client notification whenever a check finishes. */
export const STATUS_NOTIFICATION = "nodefit/status";

export interface StatusParams {
  state: "checking" | "ok" | "warning" | "error";
  /** Short, for a status bar: "Node 24.11 ✓", "Node 18.20 ✗". */
  text: string;
  /** One or two sentences for a tooltip. */
  tooltip: string;
  /** The Node the project currently runs on, if found. */
  current?: string;
  /** The release nodefit recommends. */
  recommended?: string;
  /** Short form of every release that fits: "20.9–20.19, 22, 24". */
  supported: string;
  /** The findings worth a notification (errors and warnings). */
  findings: Finding[];
}

/** Client → server request: the full report for the workspace, as Markdown. */
export const REPORT_REQUEST = "nodefit/report";

export interface ReportResult {
  markdown: string;
  findings: Finding[];
}

/** Client → server request: can this package run here? Same input as `nodefit check`. */
export const CHECK_REQUEST = "nodefit/check";

export interface CheckParams {
  /** "sharp", "better-sqlite3@^11", "bcrypt@5.1.1". */
  spec: string;
}

export interface CheckResult {
  markdown: string;
  severity: Severity | "ok";
}

/**
 * Commands the server registers (workspace/executeCommand). Code actions
 * carry them; the VS Code extension also exposes them in the palette.
 */
export const COMMANDS = {
  /** Args: [version: string]. Writes the version into the project's pin file. */
  pinNode: "nodefit.pinNode",
  /** No args. Re-reads the project and re-runs the check. */
  refresh: "nodefit.refresh",
} as const;

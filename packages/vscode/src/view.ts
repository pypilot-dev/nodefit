/**
 * What the extension shows for a server status, kept free of `vscode` so
 * `bun test` can cover it without an extension host.
 */

import type { Finding, Fix } from "@pypilot-dev/nodefit";
import type { StatusParams } from "@pypilot-dev/nodefit/protocol";

export type NotificationMode = "problems-only" | "all" | "off";

export interface StatusBarView {
  text: string;
  tooltip: string;
  /** Which theme background to use; undefined for the default. */
  background?: "warning" | "error";
}

const ICONS: Record<StatusParams["state"], string> = {
  checking: "$(sync~spin)",
  ok: "$(check)",
  warning: "$(warning)",
  error: "$(error)",
};

export function statusBarView(status: StatusParams): StatusBarView {
  if (status.state === "checking") {
    return { text: `${ICONS.checking} nodefit`, tooltip: "nodefit: checking which Node releases this project fits…" };
  }
  // The server's text carries its own ✓/✗ for editors without icons; the
  // codicon already says that here.
  const label = status.text.replace(/\s*[✓✗✔✘]\s*$/u, "").trim() || "nodefit";
  const lines = [status.tooltip.trim()];
  const facts: string[] = [];
  if (status.current) facts.push(`Current: Node ${status.current}`);
  if (status.recommended) facts.push(`Recommended: Node ${status.recommended}`);
  if (status.supported) facts.push(`Supported: ${status.supported}`);
  if (facts.length > 0) lines.push("", ...facts);
  lines.push("", "Click to show the nodefit report.");
  return {
    text: `${ICONS[status.state]} ${label}`,
    tooltip: lines.filter((line, i) => i > 0 || line !== "").join("\n"),
    background: status.state === "ok" ? undefined : status.state,
  };
}

export type FixAction =
  | { kind: "pin-node"; label: string; version: string }
  | { kind: "use-node"; label: string; version: string; command?: string };

/** The notification button for a finding's fix, if it has one a button can apply. */
export function fixAction(fix: Fix | undefined): FixAction | undefined {
  switch (fix?.kind) {
    case "pin-node":
      return { kind: "pin-node", label: `Pin Node ${fix.version}`, version: fix.version };
    case "use-node":
      return { kind: "use-node", label: `Switch to Node ${fix.version}`, version: fix.version, command: fix.command };
    default:
      // A dependency change needs the user to pick a range; the report and
      // the code action on the package.json entry explain it.
      return undefined;
  }
}

const RANK: Record<Finding["severity"], number> = { error: 0, warning: 1, info: 2 };

/**
 * The findings to notify about: errors and warnings not shown before in this
 * session, most severe first. Marks them as shown in `seen`. A finding that
 * stays unfixed must not pop up again on every save.
 */
export function newProblems(findings: readonly Finding[], seen: Set<string>, mode: NotificationMode): Finding[] {
  if (mode === "off") return [];
  const fresh = findings.filter((f) => f.severity !== "info" && !seen.has(f.id));
  for (const f of fresh) seen.add(f.id);
  return fresh.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

/** The message for the most severe new problem, counting the rest. */
export function notificationMessage(first: Finding, others: number): string {
  const more = others > 0 ? ` (and ${others} more; see the report)` : "";
  return `nodefit: ${first.title}${more}`;
}

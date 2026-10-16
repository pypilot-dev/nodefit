import { shortVersion } from "../analyze/resolve";
import { releaseLabel } from "../cli/describe";
import type { StatusParams } from "../protocol";
import type { Report } from "../types";

/** The status-bar summary of a report. `findings` holds only what deserves a notification. */
export function statusFor(report: Report): StatusParams {
  const findings = report.findings.filter((f) => f.severity !== "info");
  const state = findings.some((f) => f.severity === "error") ? "error" : findings.length ? "warning" : "ok";
  const current = report.env.current?.version.replace(/^v/, "");
  const mark = state === "error" ? "✗" : state === "warning" ? "⚠" : "✓";
  const text = current ? `Node ${shortVersion(current)} ${mark}` : `Node ${mark}`;

  const supported = report.supported.toString();
  const advice = report.recommended ? ` nodefit recommends Node ${releaseLabel(report.recommended)}.` : "";
  let tooltip: string;
  if (state === "ok") {
    tooltip = current
      ? `Node ${current} fits every dependency (supported: ${supported}).`
      : `Every dependency fits Node ${supported}.`;
  } else {
    const first = findings[0];
    const more = findings.length > 1 ? ` (+${findings.length - 1} more)` : "";
    tooltip = `${first?.title ?? "Problems found"}${more}.${advice}`;
  }

  const status: StatusParams = { state, text, tooltip, supported, findings };
  if (current) status.current = current;
  if (report.recommended) status.recommended = report.recommended.version;
  return status;
}

export function checkingStatus(previous?: StatusParams): StatusParams {
  return {
    state: "checking",
    text: "Node …",
    tooltip: "nodefit is checking which Node releases fit this project.",
    supported: previous?.supported ?? "",
    findings: [],
    ...(previous?.current ? { current: previous.current } : {}),
    ...(previous?.recommended ? { recommended: previous.recommended } : {}),
  };
}

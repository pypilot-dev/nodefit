import type { CheckOutcome } from "../analyze/check";
import { shortVersion } from "../analyze/resolve";
import {
  currentFits,
  fixText,
  hasProblems,
  installSummary,
  notablePackages,
  packageNotes,
  pinLabel,
  plural,
  releaseLabel,
} from "../cli/describe";
import { platformLabel } from "../platform";
import type { Finding, PackageReport, Report, Severity } from "../types";

const LABEL: Record<Severity, string> = { error: "Error", warning: "Warning", info: "Info" };

/** The doctor report as Markdown, for the editor's report view. */
export function reportToMarkdown(report: Report, today?: string): string {
  const { env, project } = report;
  const out: string[] = [`# nodefit doctor`, "", `\`${report.root}\` on ${platformLabel(report.platform)}`, ""];

  out.push("## Environment", "");
  out.push(
    `- **Node**: ${env.current ? `${env.current.version.replace(/^v/, "")} (\`${env.current.path}\`)` : "not found on PATH"}`,
  );
  out.push(`- **Version managers**: ${env.managers.length ? env.managers.join(", ") : "none found"}`);
  if (env.installed.length) out.push(`- **Installed**: ${env.installed.join(", ")}`);
  out.push(`- **Node releases**: newest ${report.index.newest} (${report.index.source})`, "");

  out.push("## Project", "");
  if (project.name) out.push(`- **Name**: ${project.name}`);
  const lock = project.lockfile ? `, ${plural(project.locked.length, "locked package")}` : ", no lockfile";
  out.push(`- **Package manager**: ${project.packageManager}${lock}`);
  const direct = project.dependencies.length;
  out.push(`- **Dependencies**: ${direct} direct ${direct === 1 ? "dependency" : "dependencies"}`);
  out.push(
    `- **Node pins**: ${project.pins.length ? project.pins.map((p) => `\`${pinLabel(p)}\``).join(", ") : "none"}`,
    "",
  );

  out.push("## Compatibility", "");
  out.push(`- **Supported Node**: ${report.supported}`);
  out.push(`- **Recommended**: ${report.recommended ? releaseLabel(report.recommended) : "none"}`, "");
  const notable = notablePackages(report, today);
  if (notable.length) {
    out.push("| Package | Supported Node | Notes |", "|---|---|---|");
    for (const p of notable)
      out.push(
        `| ${cell(`${p.name} ${p.version}`)} | ${cell(p.supported.toString())} | ${cell(packageNotes(p).join(" · "))} |`,
      );
    out.push("");
  }
  const rest = report.packages.length - notable.length;
  if (rest > 0) out.push(`${plural(rest, "other package")} fit every maintained Node line.`, "");
  for (const u of report.unresolved) out.push(`- **${u.name}**: unresolved (${u.reason})`);
  if (report.unresolved.length) out.push("");

  out.push("## Findings", "");
  out.push(...findingsMarkdown(report.findings));
  if (!hasProblems(report.findings)) {
    const current =
      env.current && currentFits(report) ? ` Node ${shortVersion(env.current.version)} fits every dependency.` : "";
    out.push(`✓ Everything looks good.${current}`);
  }
  return `${out.join("\n").trimEnd()}\n`;
}

export function findingsMarkdown(findings: Finding[]): string[] {
  const out: string[] = [];
  for (const f of findings) {
    out.push(`- **${LABEL[f.severity]}: ${f.title}**  `, `  ${f.detail}`);
    if (f.fix) out.push(`  Fix: \`${fixText(f.fix)}\``);
  }
  if (out.length) out.push("");
  return out;
}

/** `nodefit check` as Markdown. */
export function checkToMarkdown(outcome: CheckOutcome): string {
  const p = outcome.package;
  const out = [`# nodefit check: ${p ? `${p.name} ${p.version}` : outcome.spec}`, ""];
  const verdict = outcome.severity === "ok" ? "✓" : `**${LABEL[outcome.severity]}:**`;
  out.push(`${verdict} ${outcome.summary}`, "");
  if (p) out.push(...packageMarkdown(p), "");
  if (outcome.suits) out.push(`Suits: ${releaseLabel(outcome.suits)}`, "");
  const extra = outcome.findings.filter((f) => !outcome.summary.includes(f.title));
  out.push(...findingsMarkdown(extra));
  return `${out.join("\n").trimEnd()}\n`;
}

/** A dependency's facts, for hovers and the check view. */
export function packageMarkdown(p: PackageReport): string[] {
  const out = [`**${p.name} ${p.version}**${p.dev ? " (dev)" : ""}`, ""];
  out.push(`- engines.node: ${p.engines ? `\`${p.engines}\`` : "any"}`);
  if (p.native && p.native.kind !== "none") out.push(`- native: ${installSummary(p)}. ${p.native.detail}`);
  out.push(`- supported Node: ${p.supported}`);
  if (p.via?.length) out.push(`- pulled in by ${p.via.join(" > ")}`);
  return out;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

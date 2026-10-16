import { basename } from "node:path";
import type { CheckOutcome } from "../analyze/check";
import { shortVersion } from "../analyze/resolve";
import { platformLabel } from "../platform";
import type { Finding, NodeVersionSet, Report, Severity } from "../types";
import type { Colors } from "./color";
import {
  currentFits,
  fixText,
  hasProblems,
  notablePackages,
  packageNotes,
  pinLabel,
  plural,
  releaseLabel,
} from "./describe";

/** Packages listed under Compatibility before the rest are summarised. */
const MAX_LISTED = 25;
const RULE = 56;

/** `nodefit doctor`, as text: Environment, Project, Compatibility, Findings. */
export function formatDoctor(report: Report, c: Colors, today?: string): string {
  const out: string[] = [];
  const field = (name: string, value: string) => out.push(`  ${name.padEnd(17)}: ${value}`);
  const { env, project } = report;

  out.push(`${c.bold(c.cyan("nodefit doctor"))} — ${report.root}`);
  field("platform", platformLabel(report.platform));
  const lock = project.lockfile
    ? `${basename(project.lockfile.path)}, ${plural(project.locked.length, "package")}`
    : "no lockfile";
  field("package manager", `${c.bold(project.packageManager)} (${lock})`);
  out.push("");

  out.push(section("Environment", c));
  if (env.current) {
    const fits = currentFits(report);
    const version = env.current.version.replace(/^v/, "");
    const shown = fits === false ? c.red(c.bold(version)) : fits ? c.green(c.bold(version)) : c.bold(version);
    field("node", `${shown} (${env.current.path})`);
  } else {
    field("node", c.yellow("not found on PATH"));
  }
  field("version managers", env.managers.length ? env.managers.join(", ") : c.yellow("none found"));
  if (env.installed.length) field("installed", env.installed.join(", "));
  field("node releases", `newest ${report.index.newest} (${report.index.source})`);
  out.push("");

  out.push(section("Project", c));
  if (project.name) field("name", c.bold(project.name));
  field("dependencies", dependencyCounts(report) || "none");
  field("node pins", project.pins.length ? project.pins.map(pinLabel).join(" · ") : c.yellow("none"));
  if (project.workspaces.length) field("workspaces", plural(project.workspaces.length, "package"));
  out.push("");

  out.push(section("Compatibility", c));
  field("supported Node", setText(report.supported, c));
  field("recommended", report.recommended ? c.cyan(c.bold(releaseLabel(report.recommended))) : c.red("none"));
  const notable = notablePackages(report, today);
  const width = Math.min(32, Math.max(0, ...notable.slice(0, MAX_LISTED).map((p) => `${p.name} ${p.version}`.length)));
  for (const p of notable.slice(0, MAX_LISTED)) {
    const notes = packageNotes(p);
    const id = `${p.name} ${p.version}`.padEnd(width);
    out.push(
      `    ${c.cyan("•")} ${c.bold(id)}  ${setText(p.supported, c)}${notes.length ? c.dim(`  ${notes.join(" · ")}`) : ""}`,
    );
  }
  const rest = report.packages.length - Math.min(notable.length, MAX_LISTED);
  if (rest > 0) {
    const more = notable.length > MAX_LISTED ? `${notable.length - MAX_LISTED} more constrained, ` : "";
    out.push(c.dim(`    + ${plural(rest, "package")} not listed (${more}see --json)`));
  }
  for (const u of report.unresolved.slice(0, 10)) {
    out.push(`    ${c.cyan("•")} ${c.bold(u.name)}  ${c.red(`unresolved (${u.reason})`)}`);
  }
  if (report.unresolved.length > 10) out.push(c.dim(`    + ${report.unresolved.length - 10} more unresolved`));
  out.push("");

  out.push(section("Findings", c));
  out.push(...findingLines(report.findings, c));
  if (!hasProblems(report.findings)) {
    const current = report.env.current;
    const note = current && currentFits(report) ? ` Node ${shortVersion(current.version)} fits every dependency.` : "";
    out.push(`  ${c.green(c.bold("✓"))} Everything looks good.${note}`);
  }
  return `${out.join("\n")}\n`;
}

/** `nodefit check <spec>`, as text. */
export function formatCheck(outcome: CheckOutcome, c: Colors): string {
  const out: string[] = [];
  const field = (name: string, value: string) => out.push(`  ${name.padEnd(17)}: ${value}`);
  const p = outcome.package;
  out.push(`${c.bold(c.cyan("nodefit check"))} — ${p ? `${p.name} ${p.version}` : outcome.spec}`);
  out.push(section("Package", c));
  field("requested", `${outcome.name}@${outcome.range}`);
  if (p) {
    field("engines.node", p.engines ?? c.dim("any"));
    field("native", p.native && p.native.kind !== "none" ? (packageNotes(p)[0] ?? p.native.kind) : "no");
    if (p.native && p.native.kind !== "none" && p.native.detail) field("evidence", p.native.detail);
    field("supported Node", setText(p.supported, c));
    if (outcome.suits) field("suits", c.cyan(releaseLabel(outcome.suits)));
  }
  field("platform", platformLabel(outcome.platform));
  if (outcome.current) field("judged against", `Node ${outcome.current}`);
  out.push("");
  out.push(section("Verdict", c));
  out.push(`  ${outcome.severity === "ok" ? c.green(c.bold("✓")) : tag(outcome.severity, c)} ${outcome.summary}`);
  const extra = outcome.findings.filter((f) => !outcome.summary.includes(f.title));
  if (extra.length) out.push("", ...findingLines(extra, c));
  return `${out.join("\n")}\n`;
}

export function findingLines(findings: Finding[], c: Colors): string[] {
  const out: string[] = [];
  for (const f of findings) {
    out.push(`  ${tag(f.severity, c)} ${c.bold(f.title)}`);
    out.push(`          ${f.detail}`);
    if (f.fix) out.push(`          ${c.dim("fix:")} ${c.cyan(fixText(f.fix))}`);
  }
  return out;
}

function tag(severity: Severity, c: Colors): string {
  if (severity === "error") return c.red(c.bold("[ERROR]"));
  if (severity === "warning") return c.yellow(c.bold("[WARN ]"));
  return c.cyan(c.bold("[INFO ]"));
}

function section(name: string, c: Colors): string {
  const head = `── ${name} `;
  return c.bold(c.cyan(head + "─".repeat(Math.max(4, RULE - head.length))));
}

function setText(set: NodeVersionSet, c: Colors): string {
  return set.isEmpty() ? c.red(c.bold("none")) : c.green(set.toString());
}

function dependencyCounts(report: Report): string {
  const counts = new Map<string, number>();
  for (const d of report.project.dependencies) counts.set(d.kind, (counts.get(d.kind) ?? 0) + 1);
  return ["prod", "dev", "optional", "peer"]
    .filter((k) => counts.get(k))
    .map((k) => `${counts.get(k)} ${k}`)
    .join(", ");
}

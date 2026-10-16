/** Phrases shared by the terminal, Markdown and editor presenters. */

import { basename } from "node:path";
import { installMode } from "../analyze/resolve";
import type { Finding, Fix, NativeKind, NodePin, NodeRelease, NodeVersionSet, PackageReport, Report } from "../types";

const KIND: Record<NativeKind, string> = {
  none: "",
  "platform-packages": "prebuilt (per-platform packages)",
  "bundled-prebuilds": "prebuilt (in the tarball)",
  "prebuild-install": "prebuilt (downloaded by prebuild-install)",
  "node-pre-gyp": "prebuilt (downloaded by node-pre-gyp)",
  "source-only": "compiles with node-gyp",
  unknown: "install script nodefit cannot classify",
};

/** How the package installs here, in a few words; "" for plain JavaScript. */
export function installSummary(p: PackageReport): string {
  if (!p.native) return "";
  const mode = installMode(p.enginesSet, p.native);
  if (mode === "none") return "no binary for this platform";
  if (mode === "source" && p.native.kind !== "source-only") return "compiles with node-gyp (no prebuilt binary here)";
  return KIND[p.native.kind];
}

/** The remarks after a package's supported range: how it installs, its engines, what pulls it in. */
export function packageNotes(p: PackageReport): string[] {
  const notes: string[] = [];
  const how = installSummary(p);
  if (how) notes.push(how);
  if (p.engines) notes.push(`engines ${p.engines}`);
  if (p.via?.length) notes.push(`via ${p.via.join(" > ")}`);
  if (p.dev) notes.push("dev");
  return notes;
}

/**
 * The packages worth a line in a report: native modules, and those that
 * leave out part of a maintained Node line. Listing all 800 packages of a
 * lockfile would bury the few that matter.
 */
export function notablePackages(report: Report, today = new Date().toISOString().slice(0, 10)): PackageReport[] {
  const named = new Set(report.findings.flatMap((f) => f.packages ?? []));
  const maintained = maintainedReleases(report, today);
  return report.packages
    .filter(
      (p) =>
        (p.native && p.native.kind !== "none") ||
        maintained.some((r) => !p.supported.has(r.version)) ||
        (named.has(p.name) && !p.direct),
    )
    .sort((a, b) => a.supported.size - b.supported.size || a.name.localeCompare(b.name));
}

/** Releases of lines still maintained; without end-of-life data, the six newest majors. */
function maintainedReleases(report: Report, today: string): NodeRelease[] {
  // A Report does not carry its index; the releases any package allows
  // stand in for it (a package without engines brings every one).
  const known = report.packages.reduce<NodeVersionSet>((acc, p) => acc.union(p.enginesSet), report.supported);
  const releases = known.releases();
  const newest = releases[0]?.major ?? 0;
  return releases.filter((r) => (r.eol ? r.eol >= today : r.major >= newest - 6));
}

export function fixText(fix: Fix): string {
  switch (fix.kind) {
    case "pin-node":
      return `nodefit pin ${fix.version}`;
    case "use-node":
      return fix.command ?? `switch to Node ${fix.version}`;
    case "change-dependency":
      return `npm install ${fix.name}@${fix.range}`;
  }
}

export function releaseLabel(r: NodeRelease): string {
  return r.lts ? `${r.version} (LTS ${r.lts})` : r.version;
}

export function pinLabel(pin: NodePin): string {
  if (pin.source === "engines") return `engines ${pin.value}`;
  if (pin.source === "devEngines") return `devEngines ${pin.value}`;
  if (pin.source === "volta") return `volta ${pin.value}`;
  return `${basename(pin.file) || pin.source} ${pin.value}`;
}

export function hasProblems(findings: Finding[]): boolean {
  return findings.some((f) => f.severity === "error" || f.severity === "warning");
}

/** Does the Node on PATH fit? Undefined when there is none or nothing fits. */
export function currentFits(report: Report): boolean | undefined {
  const current = report.env.current;
  if (!current || report.supported.isEmpty()) return undefined;
  return !report.findings.some((f) => f.id === "current-unsupported");
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

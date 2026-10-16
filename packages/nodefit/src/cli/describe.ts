/** Phrases shared by the terminal, Markdown and editor presenters. */

import { basename } from "node:path";
import { installMode } from "../analyze/resolve";
import type { Finding, Fix, NativeKind, NodePin, NodeRelease, NodeVersionSet, PackageReport, Report } from "../types";

const KIND: Record<NativeKind, string> = {
  none: "",
  "platform-packages": "prebuilt (per-platform packages)",
  "bundled-prebuilds": "prebuilt (in the tarball)",
  // Also node-sass's and re2's own downloaders, so the label says what
  // happens rather than naming one tool; the detail names the mechanism.
  "prebuild-install": "prebuilt (downloaded at install)",
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
 * The packages worth a line in a report: native modules, those that leave
 * out part of a maintained Node line, and those that set the project's
 * floor or ceiling. Listing all 800 packages of a lockfile would bury the
 * few that decide the answer.
 */
export function notablePackages(report: Report, today = new Date().toISOString().slice(0, 10)): PackageReport[] {
  const named = new Set(report.findings.flatMap((f) => f.packages ?? []));
  const known = knownReleases(report);
  const newestMajor = known[0]?.major ?? 0;
  const maintained = known.filter((r) => (r.eol ? r.eol >= today : r.major >= newestMajor - 6));
  // The releases just outside the supported set: whoever excludes them is
  // why the set starts and ends where it does.
  const edges: NodeRelease[] = [];
  const fits = report.supported.releases();
  const top = fits[0];
  const bottom = fits[fits.length - 1];
  if (top && bottom) {
    const above = known[known.findIndex((r) => r.version === top.version) - 1];
    const below = known[known.findIndex((r) => r.version === bottom.version) + 1];
    if (above) edges.push(above);
    if (below) edges.push(below);
  }
  return report.packages
    .filter(
      (p) =>
        (p.native && p.native.kind !== "none") ||
        maintained.some((r) => !p.supported.has(r.version)) ||
        edges.some((r) => !p.supported.has(r.version)) ||
        (named.has(p.name) && !p.direct),
    )
    .sort((a, b) => a.supported.size - b.supported.size || a.name.localeCompare(b.name));
}

/** Every release in the report's index, newest first. */
function knownReleases(report: Report): NodeRelease[] {
  // A Report does not carry its index; the releases any package allows
  // stand in for it (a package without engines brings every one).
  return report.packages.reduce<NodeVersionSet>((acc, p) => acc.union(p.enginesSet), report.supported).releases();
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

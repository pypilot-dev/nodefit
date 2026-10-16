import type { Finding, NodeRelease, PackageReport, Platform, ProjectInfo, Severity } from "../types";
import type { FindingHooks } from "./findings";
import { type AnalyzeOptions, analyzeWith, defaultHooks } from "./index";
import { installMode, releaseFor, shortVersion } from "./resolve";

/** The answer to "can this package run here?" (`nodefit check`, the check request). */
export interface CheckOutcome {
  /** As given: "better-sqlite3@^11". */
  spec: string;
  name: string;
  range: string;
  /** Missing when the package could not be looked up (see `reason`). */
  package?: PackageReport;
  reason?: string;
  /** The Node it was judged against: the one on PATH, else the project's pin. */
  current?: string;
  severity: Severity | "ok";
  /** One or two sentences: the verdict. */
  summary: string;
  /** The newest LTS release (else newest) the package supports here. */
  suits?: NodeRelease;
  /** The analysis findings about this package. */
  findings: Finding[];
  platform: Platform;
}

/** "sharp", "better-sqlite3@^11", "@img/sharp-win32-x64@0.34" → name and range. */
export function parseCheckSpec(spec: string): { name: string; range: string } {
  const s = spec.trim();
  const at = s.indexOf("@", s.startsWith("@") ? 1 : 0);
  if (at <= 0) return { name: s, range: "latest" };
  return { name: s.slice(0, at), range: s.slice(at + 1) || "latest" };
}

export type CheckOptions = Omit<AnalyzeOptions, "project"> & {
  /** The project it would join; its pin stands in when no Node is on PATH. */
  project?: ProjectInfo;
};

export async function checkPackage(
  spec: string,
  opts: CheckOptions,
  hooks: FindingHooks = defaultHooks(),
): Promise<CheckOutcome> {
  const { name, range } = parseCheckSpec(spec);
  // A one-dependency project: the same resolution, native check and
  // findings `doctor` uses, without the rest of the tree.
  const project: ProjectInfo = {
    root: opts.project?.root ?? process.cwd(),
    dependencies: [{ name, range, kind: "prod" }],
    locked: [],
    pins: [],
    packageManager: opts.project?.packageManager ?? "npm",
    workspaces: [],
  };
  const report = await analyzeWith({ ...opts, project, includeDev: true }, hooks);
  const pkg = report.packages[0];
  const base = { spec, name, range, platform: opts.platform };

  if (!pkg) {
    const reason = report.unresolved[0]?.reason ?? `\`${name}\` could not be resolved`;
    return { ...base, reason, severity: "error", summary: `${capitalise(reason)}.`, findings: [] };
  }

  // The verdict already says whether it fits the current Node, compiles or
  // has no binary; the one-package project's own findings (about "this
  // project") would only repeat it in misleading terms.
  const restated = /^(current-unsupported|compiles:|no-binary:|unresolved:|conflict)/;
  const findings = report.findings.filter((f) => f.packages?.includes(name) && !restated.test(f.id));
  const suits = pkg.supported.newestLts() ?? pkg.supported.newest();
  const label = `${pkg.name} ${pkg.version}`;
  const mode = installMode(pkg.enginesSet, pkg.native);
  const outcome = (severity: CheckOutcome["severity"], summary: string, current?: string): CheckOutcome => ({
    ...base,
    package: pkg,
    severity,
    summary,
    findings,
    ...(suits ? { suits } : {}),
    ...(current ? { current } : {}),
  });

  if (mode === "none") {
    return outcome("error", `${label} cannot be installed on this platform. ${pkg.native?.detail ?? ""}`.trim());
  }

  const currentVersion = opts.env.current?.version ?? pinnedVersion(opts, hooks);
  if (!currentVersion) {
    return outcome("info", `No Node.js on PATH to judge against. ${label} runs on Node ${pkg.supported}.`);
  }
  const current = currentVersion.replace(/^v/, "");
  const shown = shortVersion(current);
  const release = releaseFor(opts.index, current);
  if (!release) {
    return outcome(
      "info",
      `Node ${shown} is not in nodefit's release list yet. ${label} runs on Node ${pkg.supported}.`,
      current,
    );
  }
  const instead = suits ? ` Node ${suits.version} would suit it.` : "";

  if (!pkg.enginesSet.has(release.version)) {
    return outcome(
      "error",
      `${label} does not support this project's Node ${shown} (its engines.node is "${pkg.engines}").${instead}`,
      current,
    );
  }
  if (mode === "source") {
    return outcome(
      "warning",
      `${label} supports Node ${shown}, but it compiles with node-gyp on install, which needs Python and a C++ toolchain.`,
      current,
    );
  }
  if (!pkg.supported.has(release.version)) {
    return pkg.native?.fallsBackToSource
      ? outcome(
          "warning",
          `${label} has no prebuilt binary for Node ${shown} here, so npm would compile it with node-gyp (needs Python and a C++ toolchain).${instead}`,
          current,
        )
      : outcome("error", `${label} has no binary for Node ${shown} on this platform.${instead}`, current);
  }
  const how = mode === "prebuilt" ? " with a prebuilt binary" : "";
  return outcome("ok", `This project's Node ${shown} can install and run ${label}${how}.`, current);
}

function pinnedVersion(opts: CheckOptions, hooks: FindingHooks): string | undefined {
  const pin = opts.project?.pins.find((p) => p.exact);
  return pin ? hooks.resolveSpec(opts.index, pin.value)?.version : undefined;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

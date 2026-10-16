import { basename } from "node:path";
import semver from "semver";
import { NodeSet } from "../node/set";
import { platformLabel } from "../platform";
import type {
  Conflict,
  Finding,
  Fix,
  NodeEnvironment,
  NodeIndex,
  NodePin,
  NodeRelease,
  NodeVersionSet,
  PackageReport,
  Platform,
  ProjectInfo,
  Severity,
  VersionManager,
} from "../types";
import { installMode, pinVersion, releaseFor, shortVersion } from "./resolve";

export interface Unresolved {
  name: string;
  reason: string;
  /** Declared in package.json; transitive failures are summarised in one finding. */
  direct: boolean;
}

/** What findings need from outside the report; injectable for tests. */
export interface FindingHooks {
  resolveSpec(index: NodeIndex, spec: string): NodeRelease | undefined;
  useCommand(manager: VersionManager, version: string): string | undefined;
  /** YYYY-MM-DD, for end-of-life dates. */
  today: string;
}

export interface FindingInput {
  project: ProjectInfo;
  env: NodeEnvironment;
  index: NodeIndex;
  platform: Platform;
  packages: PackageReport[];
  supported: NodeVersionSet;
  recommended?: NodeRelease;
  conflicts: Conflict[];
  unresolved: Unresolved[];
  includeDev: boolean;
}

const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export function buildFindings(input: FindingInput, hooks: FindingHooks): Finding[] {
  const out: Finding[] = [
    ...conflictFindings(input),
    ...nodeFindings(input, hooks),
    ...pinFindings(input, hooks),
    ...nativeFindings(input, hooks),
    ...unresolvedFindings(input),
  ];
  // Stable: within a severity, the order above (most actionable first).
  return out
    .map((f, i) => ({ f, i }))
    .sort((a, b) => RANK[a.f.severity] - RANK[b.f.severity] || a.i - b.i)
    .map((x) => x.f);
}

// --------------------------------------------------------------------------

function conflictFindings({ packages, supported, conflicts, platform }: FindingInput): Finding[] {
  const out: Finding[] = [];
  const here = platformLabel(platform);

  for (const p of packages) {
    if (installMode(p.enginesSet, p.native) !== "none") continue;
    out.push({
      id: `no-binary:${p.name}`,
      severity: "error",
      title: `${p.name} ${p.version} cannot be installed on ${here}`,
      detail: `${sentence(p.native?.detail ?? "It publishes no binary for this platform.")} No Node version helps: move to a release of ${p.name} that ships a binary for ${here}, or replace it.`,
      packages: blame(p),
    });
  }

  if (!supported.isEmpty() || packages.length === 0) return out;
  const conflict = conflicts[0];
  const find = (side: Conflict["a"]) => packages.find((p) => p.name === side.name && p.version === side.version);
  const a = conflict && find(conflict.a);
  const b = conflict && find(conflict.b);
  let detail = "The project's dependencies have no Node release in common.";
  if (a && b) {
    if (a.supported.isEmpty()) {
      detail = `${label(a)} fits no Node release here${a.engines ? ` (its engines.node is "${a.engines}")` : ""}, so nothing can satisfy it and the rest of the project.`;
    } else {
      const cap = a.supported.newest() as NodeRelease;
      const oldest = b.supported.releases();
      const floor = oldest[oldest.length - 1] as NodeRelease;
      detail = semver.lt(cap.version, floor.version)
        ? `${label(a)} supports Node up to ${cap.version} (${a.supported}) but ${label(b)} needs at least Node ${floor.version} (${b.supported}), so no single release satisfies both.`
        : `${label(a)} runs on Node ${a.supported} and ${label(b)} on Node ${b.supported}, so no single release satisfies both.`;
    }
    detail += ` Move one of them to a version that fits the other.`;
  }
  out.push({
    id: "conflict",
    severity: "error",
    title: "No Node release fits every dependency",
    detail,
    packages: unique([...(a ? blame(a) : []), ...(b ? blame(b) : [])]),
  });
  return out;
}

function nodeFindings(input: FindingInput, hooks: FindingHooks): Finding[] {
  const { env, index, supported, recommended } = input;
  const out: Finding[] = [];
  const advice = recommended ? recommendation(recommended) : "";

  if (!env.current) {
    out.push({
      id: "no-node",
      severity: "warning",
      title: "No Node.js on PATH",
      detail: `nodefit could not find \`node\` on PATH, so it cannot tell whether this machine fits the project.${recommended ? ` Install Node ${pinVersion(index, recommended)}, ${advice}.` : ""}`,
      ...useFix(input, hooks, recommended),
    });
    return out;
  }

  const current = releaseFor(index, env.current.version);
  if (!current) return out;
  const shown = shortVersion(env.current.version);

  if (!supported.isEmpty() && !supported.has(current.version)) {
    const blockers = installable(input).filter((p) => !p.supported.has(current.version));
    out.push({
      id: "current-unsupported",
      severity: "error",
      title: `Node ${shown} does not fit this project`,
      detail: `Node ${env.current.version.replace(/^v/, "")} is outside what ${listPackages(blockers)} ${blockers.length === 1 ? "supports" : "support"}.${recommended ? ` Switch to Node ${pinVersion(index, recommended)}, ${advice}.` : ""}`,
      packages: unique(blockers.flatMap(blame)),
      ...useFix(input, hooks, recommended),
    });
  }

  if (current.eol && hooks.today >= current.eol) {
    const better = recommended && recommended.major !== current.major;
    out.push({
      id: "eol",
      severity: "warning",
      title: `Node ${current.major} is end-of-life`,
      detail: `Node ${current.major} stopped receiving security fixes on ${current.eol}.${better ? ` Node ${pinVersion(index, recommended)} is ${advice}.` : ""}`,
      ...(better ? useFix(input, hooks, recommended) : {}),
    });
  }
  return out;
}

function pinFindings(input: FindingInput, hooks: FindingHooks): Finding[] {
  const { project, env, index, supported, recommended } = input;
  const out: Finding[] = [];
  const exact = project.pins.filter((p) => p.exact);
  const current = env.current ? releaseFor(index, env.current.version) : undefined;
  let mismatchReported = false;

  for (const pin of exact) {
    const wants = hooks.resolveSpec(index, pin.value);
    if (!wants) continue;
    const where = pinName(pin);

    if (!supported.isEmpty() && !supported.has(wants.version)) {
      const blockers = installable(input).filter((p) => !p.supported.has(wants.version));
      out.push({
        id: `pin-unsupported:${pin.source}`,
        severity: "error",
        title: `${where} asks for Node ${pin.value}, which does not fit this project`,
        detail: `Node ${wants.version} is outside what ${listPackages(blockers)} ${blockers.length === 1 ? "supports" : "support"}.${recommended ? ` Pin Node ${pinVersion(index, recommended)} instead, ${recommendation(recommended)}.` : ""}`,
        packages: unique(blockers.flatMap(blame)),
        ...(recommended ? { fix: { kind: "pin-node", version: pinVersion(index, recommended) } as Fix } : {}),
      });
      // Telling the user to switch to a pin that cannot run the project
      // contradicts the fix above, which is to change the pin.
      continue;
    }

    if (!mismatchReported && env.current && current && current.major !== wants.major) {
      mismatchReported = true;
      const fix = useFix(input, hooks, wants);
      const command = fix.fix?.kind === "use-node" ? fix.fix.command : undefined;
      out.push({
        id: `pin-mismatch:${pin.source}`,
        severity: "warning",
        title: `This shell runs Node ${shortVersion(env.current.version)} but ${where} asks for ${pin.value}`,
        detail: `Commands run here use Node ${env.current.version.replace(/^v/, "")}, not the Node the project pins (${wants.version}).${command ? ` Switch with \`${command}\`.` : ""}`,
        ...fix,
      });
    }
  }

  if (exact.length === 0 && recommended) {
    const version = pinVersion(index, recommended);
    out.push({
      id: "no-pin",
      severity: "info",
      title: "No Node version pinned",
      detail: `Nothing in this project says which Node to use, so every machine runs whatever it has. \`nodefit pin\` writes ${version} (${recommendation(recommended)}) to .nvmrc, which nvm, fnm and most CI setups read.`,
      fix: { kind: "pin-node", version },
    });
  }

  for (const pin of project.pins) {
    if (pin.exact || !recommended) continue;
    if (NodeSet.fromRange(index, pin.value).has(recommended.version)) continue;
    const field = pin.source === "devEngines" ? "devEngines.runtime" : "engines.node";
    out.push({
      id: `engines-excludes-recommended:${pin.source}`,
      severity: "warning",
      title: `The project's ${field} ("${pin.value}") leaves out Node ${shortVersion(recommended.version)}`,
      detail: `Every dependency fits Node ${recommended.version}, but the project's own ${field} range excludes it, so npm warns (or fails, with engine-strict) on the release nodefit recommends. Widen the range to include it.`,
    });
  }
  return out;
}

function nativeFindings(input: FindingInput, hooks: FindingHooks): Finding[] {
  const { env, index, platform, recommended } = input;
  const out: Finding[] = [];
  const here = platformLabel(platform);
  const current = env.current ? releaseFor(index, env.current.version) : undefined;

  for (const p of input.packages) {
    const native = p.native;
    if (!native) continue;
    const mode = installMode(p.enginesSet, native);

    if (mode === "source") {
      // Windows has no compiler by default; elsewhere one is usually there.
      out.push({
        id: `source-build:${p.name}`,
        severity: platform.os === "win32" ? "warning" : "info",
        title: `${p.name} compiles with node-gyp on install`,
        detail: `${sentence(native.detail)} Every install of ${label(p)} on ${here} builds it from source, which needs Python and a C++ toolchain ${toolchain(platform)}.`,
        packages: blame(p),
      });
      continue;
    }

    if (
      mode === "prebuilt" &&
      native.prebuilt !== "all" &&
      native.fallsBackToSource &&
      current &&
      env.current &&
      p.enginesSet.has(current.version) &&
      !native.prebuilt.has(current.version)
    ) {
      const shown = shortVersion(env.current.version);
      const target = recommended && p.supported.has(recommended.version) ? recommended : p.supported.newestLts();
      out.push({
        id: `compiles:${p.name}`,
        severity: "warning",
        title: `npm will compile ${p.name} with node-gyp on Node ${shown}`,
        detail: `${label(p)} has no prebuilt binary for Node ${shown} on ${here}, so npm builds it from source, which needs Python and a C++ toolchain ${toolchain(platform)}. Prebuilt binaries exist for Node ${p.supported}.`,
        packages: blame(p),
        ...useFix(input, hooks, target),
      });
    }
  }
  return out;
}

function unresolvedFindings({ unresolved, project }: FindingInput): Finding[] {
  const out: Finding[] = [];
  for (const u of unresolved.filter((u) => u.direct)) {
    out.push({
      id: `unresolved:${u.name}`,
      severity: "warning",
      title: `Could not look up \`${u.name}\``,
      detail: `${sentence(capitalise(u.reason))} It is left out of the check.`,
      packages: [u.name],
    });
  }

  const transitive = unresolved.filter((u) => !u.direct);
  if (transitive.length) {
    const first = transitive[0] as Unresolved;
    out.push({
      id: "unresolved-locked",
      severity: "warning",
      title: `${transitive.length} locked ${transitive.length === 1 ? "package" : "packages"} could not be looked up`,
      detail: `${listNames(transitive.map((u) => u.name))}: ${first.reason}. ${transitive.length === 1 ? "It is" : "They are"} left out of the check.`,
    });
  }

  if (project.lockfile?.kind === "bun" && project.lockfile.path.endsWith(".lockb") && project.locked.length === 0) {
    out.push({
      id: "bun-binary-lockfile",
      severity: "info",
      title: "bun.lockb is binary, so only package.json was checked",
      detail:
        "nodefit cannot read bun's binary lockfile, so it checked the newest versions package.json allows instead of the ones locked, and no transitive packages. Run `bun install --save-text-lockfile` to write bun.lock, which nodefit reads.",
    });
  }
  return out;
}

// --------------------------------------------------------------------------

function installable(input: FindingInput): PackageReport[] {
  return input.packages.filter((p) => installMode(p.enginesSet, p.native) !== "none");
}

/** The package.json entries to underline: the direct dependency that pulls `p` in, and `p`. */
export function blame(p: PackageReport): string[] {
  if (p.direct) return [p.name];
  const root = p.via?.[0];
  return root ? [root, p.name] : [p.name];
}

function useFix({ env, index }: FindingInput, hooks: FindingHooks, release: NodeRelease | undefined): { fix?: Fix } {
  if (!release) return {};
  const version = pinVersion(index, release);
  const manager = env.managers[0];
  const command = manager ? hooks.useCommand(manager, version) : undefined;
  return { fix: command ? { kind: "use-node", version, command } : { kind: "use-node", version } };
}

function recommendation(release: NodeRelease): string {
  return release.lts !== false
    ? "the newest LTS release that fits every dependency"
    : "the newest release that fits every dependency";
}

function label(p: PackageReport): string {
  return `${p.name} ${p.version}`;
}

/** "a 1.0 (20, 22) and b 2.0 (18–22)", at most five named. */
function listPackages(packages: PackageReport[]): string {
  const named = packages.slice(0, 5).map((p) => `${label(p)} (${p.supported})`);
  const rest = packages.length - named.length;
  if (rest > 0) return `${named.join(", ")} and ${rest} more`;
  if (named.length <= 1) return named[0] ?? "its dependencies";
  return `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
}

function listNames(names: string[]): string {
  const shown = names.slice(0, 5).join(", ");
  return names.length > 5 ? `${shown} and ${names.length - 5} more` : shown;
}

function pinName(pin: NodePin): string {
  if (pin.source === "volta") return "package.json's volta field";
  if (pin.source === "engines" || pin.source === "devEngines") return `package.json's ${pin.source}`;
  return basename(pin.file) || pin.source;
}

function toolchain(platform: Platform): string {
  if (platform.os === "win32")
    return '(on Windows: Visual Studio Build Tools with the "Desktop development with C++" workload)';
  if (platform.os === "darwin") return "(on macOS: the Xcode Command Line Tools, `xcode-select --install`)";
  return "(python3, make and g++; `build-essential` on Debian and Ubuntu)";
}

function sentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function unique(names: string[]): string[] {
  return [...new Set(names)];
}

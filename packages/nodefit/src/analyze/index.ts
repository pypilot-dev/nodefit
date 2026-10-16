/**
 * Intersects everything into a Report.
 *
 * Every package the project installs narrows the Node releases it can run
 * on: its `engines.node`, and for a native module the releases it has a
 * prebuilt binary for here. The project fits the intersection.
 */

import semver from "semver";
import { analyzeNative, mayBeNative } from "../native";
import { NodeSet, resolveNodeSpec } from "../node";
import { useCommand } from "../project";
import type {
  Conflict,
  HttpClient,
  LockedPackage,
  NativeContext,
  NativeVerdict,
  NodeEnvironment,
  NodeIndex,
  NodeRelease,
  NodeVersionSet,
  PackageReport,
  Platform,
  ProjectInfo,
  RegistrySource,
  Report,
  VersionMeta,
} from "../types";
import { NotFoundError } from "../types";
import { buildFindings, type FindingHooks, type Unresolved } from "./findings";
import { installMode, installsOn, mapLimit, parseDependencySpec, pickVersion, supportedSet } from "./resolve";

export interface AnalyzeOptions {
  project: ProjectInfo;
  env: NodeEnvironment;
  index: NodeIndex;
  registry: RegistrySource;
  http: HttpClient;
  platform: Platform;
  /** Include packages only dev dependencies need (default true). */
  includeDev?: boolean;
  /** The native-module check; tests inject a fake. Defaults to native/analyzeNative. */
  native?: (meta: VersionMeta, ctx: NativeContext) => Promise<NativeVerdict>;
}

/** Registry lookups in flight at once; enough to hide latency without tripping rate limits. */
const CONCURRENCY = 16;

export async function analyze(opts: AnalyzeOptions): Promise<Report> {
  return analyzeWith(opts, defaultHooks());
}

export function defaultHooks(): FindingHooks {
  return {
    // Both come from modules that may not parse every input; a pin nodefit
    // cannot read or a manager without a command only loses that detail.
    resolveSpec: (index, spec) => {
      try {
        return resolveNodeSpec(index, spec);
      } catch {
        return undefined;
      }
    },
    useCommand: (manager, version) => {
      try {
        return useCommand(manager, version);
      } catch {
        return undefined;
      }
    },
    today: new Date().toISOString().slice(0, 10),
  };
}

/** `analyze` with the pin resolver, manager commands and date injected (tests). */
export async function analyzeWith(opts: AnalyzeOptions, hooks: FindingHooks): Promise<Report> {
  const { index, project } = opts;
  const unresolved: Unresolved[] = [];
  const candidates = project.locked.length
    ? await fromLockfile(opts, unresolved)
    : await fromPackageJson(opts, unresolved);

  const nativeCheck = opts.native ?? analyzeNative;
  const ctx: NativeContext = { registry: opts.registry, index, platform: opts.platform, http: opts.http };
  const via = project.locked.length ? viaChains(project) : new Map<string, string[]>();

  const packages = await mapLimit(candidates, CONCURRENCY, async (c): Promise<PackageReport> => {
    const engines = c.meta.engines?.node;
    const enginesSet = engines ? NodeSet.fromRange(index, engines) : NodeSet.all(index);
    const native =
      mayBeNative(c.meta) || c.meta.hasInstallScript ? await safeNative(nativeCheck, c.meta, ctx) : undefined;
    const report: PackageReport = {
      name: c.name,
      version: c.version,
      direct: c.direct,
      dev: c.dev,
      enginesSet,
      supported: supportedSet(index, enginesSet, native),
    };
    if (!c.direct && via.has(c.name)) report.via = via.get(c.name);
    if (engines) report.engines = engines;
    if (native) report.native = native;
    return report;
  });

  // A package with no binary for this platform fails on every Node, so no
  // release fixes it; it gets its own error instead of emptying the set and
  // hiding the recommendation for everything else.
  const installable = packages.filter((p) => installMode(p.enginesSet, p.native) !== "none");
  const supported = installable.reduce<NodeVersionSet>((acc, p) => acc.intersect(p.supported), NodeSet.all(index));
  const recommended = supported.newestLts() ?? supported.newest();
  const conflicts = supported.isEmpty() ? findConflicts(installable) : [];

  const findings = buildFindings(
    { ...opts, packages, supported, recommended, conflicts, unresolved, includeDev: opts.includeDev ?? true },
    hooks,
  );

  return {
    root: project.root,
    platform: opts.platform,
    index: { newest: index.releases[0]?.version ?? "unknown", source: index.source },
    env: opts.env,
    project,
    packages,
    supported,
    recommended,
    conflicts,
    unresolved: unresolved.map(({ name, reason }) => ({ name, reason })),
    findings,
  };
}

interface Candidate {
  name: string;
  version: string;
  direct: boolean;
  dev: boolean;
  meta: VersionMeta;
}

/**
 * The installed tree, as the lockfile records it. npm's lockfile carries
 * `engines` and `hasInstallScript`, so only possible native modules need
 * the registry; the other lockfiles leave those out, so every package is
 * looked up (abbreviated, cached a day).
 */
async function fromLockfile(opts: AnalyzeOptions, unresolved: Unresolved[]): Promise<Candidate[]> {
  const { project, platform } = opts;
  const includeDev = opts.includeDev ?? true;
  const npmLock = project.lockfile?.kind === "npm";
  const directNames = new Set(project.dependencies.map((d) => d.name));
  // Packages that pick a binary by os/cpu (`@esbuild/win32-x64`) are what
  // their parent (esbuild) chooses between: the parent is a native module.
  const platformSpecific = new Set(project.locked.filter((l) => l.os?.length || l.cpu?.length).map((l) => l.name));

  const kept = project.locked.filter(
    (l) =>
      (includeDev || !l.dev) &&
      // npm skips packages whose os/cpu exclude this machine, so they cannot clash.
      installsOn(l, platform) &&
      // Workspace links and git checkouts have no registry version to check.
      semver.valid(l.version) !== null,
  );

  const out = await mapLimit(kept, CONCURRENCY, async (l): Promise<Candidate | undefined> => {
    const synthesized = metaFromLock(l, platformSpecific);
    const maybeNative = mayBeNative(synthesized) || Boolean(l.hasInstallScript);
    const unknown = l.engines === undefined || l.hasInstallScript === undefined;
    let meta = synthesized;
    if (maybeNative || (!npmLock && unknown)) {
      try {
        const doc = await opts.registry.packument(l.name);
        const found = doc.versions[l.version];
        if (found) meta = { ...found, hasInstallScript: found.hasInstallScript ?? l.hasInstallScript };
        else if (!npmLock) {
          unresolved.push(missing(l, `${l.name}@${l.version} is not on the npm registry`, directNames));
          return undefined;
        }
      } catch (err) {
        // npm's lockfile already holds what the check needs; the registry only
        // adds detail, so a private or unreachable package is still checked.
        if (!npmLock) {
          unresolved.push(missing(l, reasonOf(err), directNames));
          return undefined;
        }
      }
    }
    const direct = l.path ? l.path === `node_modules/${l.name}` && directNames.has(l.name) : directNames.has(l.name);
    return { name: l.name, version: l.version, direct, dev: Boolean(l.dev), meta };
  });
  return out.filter((c): c is Candidate => c !== undefined);
}

function metaFromLock(l: LockedPackage, platformSpecific: Set<string>): VersionMeta {
  const meta: VersionMeta = { name: l.name, version: l.version };
  if (l.engines) meta.engines = l.engines;
  if (l.hasInstallScript !== undefined) meta.hasInstallScript = l.hasInstallScript;
  if (l.os) meta.os = l.os;
  if (l.cpu) meta.cpu = l.cpu;
  if (l.dependencies) {
    meta.dependencies = l.dependencies;
    const optional = Object.entries(l.dependencies).filter(([name]) => platformSpecific.has(name));
    if (optional.length) meta.optionalDependencies = Object.fromEntries(optional);
  }
  return meta;
}

function missing(l: LockedPackage, reason: string, directNames: Set<string>): Unresolved {
  return { name: l.name, reason, direct: directNames.has(l.name) };
}

/**
 * No lockfile (or only bun's binary one): resolve each direct dependency
 * the way npm would today. Transitive packages are unknown until an install
 * writes a lockfile, so only the direct ones are checked.
 */
async function fromPackageJson(opts: AnalyzeOptions, unresolved: Unresolved[]): Promise<Candidate[]> {
  const includeDev = opts.includeDev ?? true;
  const deps = new Map<string, { range: string; dev: boolean; optional: boolean }>();
  for (const d of opts.project.dependencies) {
    const seen = deps.get(d.name);
    if (seen) {
      seen.dev &&= d.kind === "dev";
      continue;
    }
    deps.set(d.name, { range: d.range, dev: d.kind === "dev", optional: d.kind === "optional" });
  }

  const wanted = [...deps].filter(([, d]) => includeDev || !d.dev);
  const out = await mapLimit(wanted, CONCURRENCY, async ([name, d]): Promise<Candidate | undefined> => {
    const spec = parseDependencySpec(name, d.range);
    if (!spec.ok) {
      unresolved.push({ name, reason: spec.reason, direct: true });
      return undefined;
    }
    try {
      const doc = await opts.registry.packument(spec.name);
      const version = pickVersion(doc, spec.range);
      const meta = version ? doc.versions[version] : undefined;
      if (!version || !meta) {
        unresolved.push({
          name,
          reason: `no published version of \`${spec.name}\` matches "${spec.range}"`,
          direct: true,
        });
        return undefined;
      }
      if (!installsOn(meta, opts.platform)) {
        // An optional dependency for another platform (fsevents) is skipped
        // by npm; anything else makes npm stop with EBADPLATFORM.
        if (!d.optional) {
          unresolved.push({
            name,
            reason: `${spec.name}@${version} does not install on this platform (it allows ${platformFields(meta)})`,
            direct: true,
          });
        }
        return undefined;
      }
      return { name, version, direct: true, dev: d.dev, meta };
    } catch (err) {
      unresolved.push({ name, reason: reasonOf(err), direct: true });
      return undefined;
    }
  });
  return out.filter((c): c is Candidate => c !== undefined);
}

function platformFields(meta: VersionMeta): string {
  const parts = [meta.os?.join("/"), meta.cpu?.join("/"), meta.libc?.join("/")].filter(Boolean);
  return parts.join(", ");
}

function reasonOf(err: unknown): string {
  if (err instanceof NotFoundError) return err.message;
  const message = err instanceof Error ? err.message : String(err);
  return `the npm registry could not be reached (${message})`;
}

async function safeNative(
  check: NonNullable<AnalyzeOptions["native"]>,
  meta: VersionMeta,
  ctx: NativeContext,
): Promise<NativeVerdict> {
  try {
    return await check(meta, ctx);
  } catch (err) {
    // The native check promises not to throw; if it does anyway, one
    // package's binaries go unchecked rather than the whole report failing.
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: "unknown",
      prebuilt: "all",
      fallsBackToSource: false,
      detail: `nodefit could not check ${meta.name}'s binaries (${message}).`,
    };
  }
}

/**
 * The shortest chain from a direct dependency to each transitive package,
 * following the lockfile's dependency edges by name. The chain excludes the
 * package itself: `via: ["sqlite3", "node-gyp"]` for `tar`.
 */
export function viaChains(project: ProjectInfo): Map<string, string[]> {
  const edges = new Map<string, Set<string>>();
  for (const l of project.locked) {
    const out = edges.get(l.name) ?? new Set<string>();
    for (const dep of Object.keys(l.dependencies ?? {})) out.add(dep);
    edges.set(l.name, out);
  }

  const parent = new Map<string, string | undefined>();
  const queue: string[] = [];
  for (const d of project.dependencies) {
    if (!parent.has(d.name)) {
      parent.set(d.name, undefined);
      queue.push(d.name);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const name = queue[i] as string;
    for (const dep of edges.get(name) ?? []) {
      if (parent.has(dep)) continue;
      parent.set(dep, name);
      queue.push(dep);
    }
  }

  const chains = new Map<string, string[]>();
  for (const [name, up] of parent) {
    if (up === undefined) continue;
    const chain: string[] = [];
    for (let p: string | undefined = up; p !== undefined; p = parent.get(p)) chain.unshift(p);
    chains.set(name, chain);
  }
  return chains;
}

/**
 * Why the intersection is empty, as PyPilot tells it: the package with the
 * lowest ceiling against the one with the highest floor. When those two
 * overlap (three or more packages clash), the first disjoint pair; when a
 * package fits no release at all, that package against the widest one.
 */
export function findConflicts(packages: PackageReport[]): Conflict[] {
  const pair = (a: PackageReport, b: PackageReport): Conflict => ({
    a: { name: a.name, version: a.version, supported: a.supported.toString() },
    b: { name: b.name, version: b.version, supported: b.supported.toString() },
  });

  const bounded = packages.filter((p) => !p.supported.isEmpty());
  const newest = (p: PackageReport) => (p.supported.newest() as NodeRelease).version;
  const oldest = (p: PackageReport) => {
    const all = p.supported.releases();
    return (all[all.length - 1] as NodeRelease).version;
  };

  if (bounded.length >= 2) {
    const lowestMax = bounded.reduce((a, b) => (semver.lt(newest(b), newest(a)) ? b : a));
    const highestMin = bounded.reduce((a, b) => (semver.gt(oldest(b), oldest(a)) ? b : a));
    if (lowestMax !== highestMin && lowestMax.supported.intersect(highestMin.supported).isEmpty()) {
      return [pair(lowestMax, highestMin)];
    }
    // Only constrained packages can clash; skipping the rest keeps this short.
    const narrow = bounded.filter((p) => p.supported.size < p.enginesSet.size || p.engines !== undefined);
    for (const [i, a] of narrow.entries()) {
      for (const b of narrow.slice(i + 1)) {
        if (a.supported.intersect(b.supported).isEmpty()) return [pair(a, b)];
      }
    }
  }

  const widest = bounded.reduce<PackageReport | undefined>(
    (a, b) => (!a || b.supported.size > a.supported.size ? b : a),
    undefined,
  );
  if (!widest) return [];
  return packages.filter((p) => p.supported.isEmpty()).map((p) => pair(p, widest));
}

import semver from "semver";
import { NodeSet } from "../node/set";
import type { NativeVerdict, NodeIndex, NodeRelease, NodeVersionSet, Packument, Platform } from "../types";

export type ParsedSpec = { ok: true; name: string; range: string } | { ok: false; reason: string };

/**
 * What a package.json entry points at, as npm reads it. Only registry specs
 * can be checked: a git URL or a local path has no published `engines` or
 * binary list to look up.
 */
export function parseDependencySpec(name: string, range: string): ParsedSpec {
  const spec = range.trim();
  if (spec.startsWith("npm:")) {
    const rest = spec.slice(4);
    // The first character of a scoped name is "@", so search after it.
    const at = rest.indexOf("@", 1);
    if (at > 0) return { ok: true, name: rest.slice(0, at), range: rest.slice(at + 1) || "latest" };
    return { ok: true, name: rest, range: "latest" };
  }
  const source = nonRegistrySource(spec);
  if (source) {
    return {
      ok: false,
      reason: `\`${name}\` comes from ${source} (${spec}), not the npm registry, so its engines and binaries cannot be looked up`,
    };
  }
  return { ok: true, name, range: spec === "" ? "latest" : spec };
}

function nonRegistrySource(spec: string): string | undefined {
  if (spec.startsWith("workspace:")) return "a workspace package";
  if (/^(file|link|portal|patch):/.test(spec) || /^(\.{1,2}|~)?\//.test(spec)) return "a local path";
  if (/^(git\+|git:|github:|gitlab:|bitbucket:|gist:)/.test(spec) || /\.git(#.*)?$/.test(spec)) {
    return "a git repository";
  }
  if (/^https?:/.test(spec)) return "a tarball URL";
  // GitHub shorthand, "user/repo#ref". Semver ranges never contain a slash.
  if (/^[\w.-]+\/[\w.-]+(#.*)?$/.test(spec)) return "a git repository";
  return undefined;
}

/**
 * The version npm would install for `range`: a dist-tag by name, else the
 * `latest` tag when it satisfies the range (npm prefers it), else the
 * highest satisfying version.
 */
export function pickVersion(doc: Packument, range: string): string | undefined {
  const tags = doc["dist-tags"] ?? {};
  const tagged = tags[range];
  if (tagged && doc.versions[tagged]) return tagged;
  const valid = semver.validRange(range, { loose: true });
  if (valid === null) return undefined;
  const latest = tags.latest;
  if (latest && doc.versions[latest] && semver.satisfies(latest, valid, { loose: true })) return latest;
  return semver.maxSatisfying(Object.keys(doc.versions), valid, { loose: true }) ?? undefined;
}

/** npm's `os`/`cpu`/`libc` fields: positive entries allow, "!x" entries exclude. */
export function installsOn(pkg: { os?: string[]; cpu?: string[]; libc?: string[] }, platform: Platform): boolean {
  return (
    allows(pkg.os, platform.os) &&
    allows(pkg.cpu, platform.arch) &&
    (platform.os !== "linux" || !platform.libc || allows(pkg.libc, platform.libc))
  );
}

function allows(list: string[] | undefined, value: string): boolean {
  if (!list || list.length === 0) return true;
  if (list.includes(`!${value}`)) return false;
  const positive = list.filter((e) => !e.startsWith("!"));
  return positive.length === 0 || positive.includes(value) || positive.includes("any");
}

/**
 * How a package installs on this platform, which decides what it does to
 * the project's set of Node releases:
 *
 *   plain     no native code, or a binary that works on every release
 *   prebuilt  a prebuilt binary for some releases; on the rest npm compiles
 *             it (fallsBackToSource) or fails
 *   source    compiled with node-gyp on every release; it narrows nothing,
 *             because a compiler is the only way in
 *   unknown   an install script nodefit cannot classify
 *   none      no binary for this platform and nothing to compile
 */
export type InstallMode = "plain" | "prebuilt" | "source" | "unknown" | "none";

export function installMode(enginesSet: NodeVersionSet, native: NativeVerdict | undefined): InstallMode {
  if (!native || native.kind === "none") return "plain";
  if (native.kind === "unknown") return "unknown";
  if (native.kind === "source-only") return "source";
  if (native.prebuilt === "all") return "prebuilt";
  if (!enginesSet.intersect(native.prebuilt).isEmpty()) return "prebuilt";
  // Prebuilt for no release the package allows: a source build if it has
  // one, so it behaves like source-only rather than emptying the project.
  return native.fallsBackToSource ? "source" : "none";
}

/** Releases on which the package installs without a compiler (or at all, for source builds). */
export function supportedSet(
  index: NodeIndex,
  enginesSet: NodeVersionSet,
  native: NativeVerdict | undefined,
): NodeVersionSet {
  const mode = installMode(enginesSet, native);
  if (mode === "none") return NodeSet.empty(index);
  if (mode === "prebuilt" && native && native.prebuilt !== "all") return enginesSet.intersect(native.prebuilt);
  return enginesSet;
}

/**
 * The index release that stands for `version`: itself, else the newest
 * release of its major line (same ABI) when the index is older than the
 * installed Node. Undefined for a line the index does not know.
 */
export function releaseFor(index: NodeIndex, version: string): NodeRelease | undefined {
  const clean = version.trim().replace(/^v/, "");
  const exact = index.releases.find((r) => r.version === clean);
  if (exact) return exact;
  const major = semver.major(semver.coerce(clean) ?? "0.0.0");
  return index.releases.find((r) => r.major === major);
}

/**
 * How to write `release` in a pin file or a `use` command: the major line
 * alone ("22") when that already selects it, the exact version otherwise.
 */
export function pinVersion(index: NodeIndex, release: NodeRelease): string {
  const newestOfLine = index.releases.find((r) => r.major === release.major);
  return newestOfLine?.version === release.version ? `${release.major}` : release.version;
}

/** "18.20" for 18.20.4: enough to tell releases apart in a sentence. */
export function shortVersion(version: string): string {
  const clean = version.trim().replace(/^v/, "");
  const parts = clean.split(".");
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : clean;
}

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

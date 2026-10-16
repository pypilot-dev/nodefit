import semver from "semver";
import { NodeSet } from "../node/set";
import { platformLabel } from "../platform";
import type { NativeContext, NativeVerdict, NodeVersionSet, VersionMeta } from "../types";
import { NotFoundError } from "../types";
import { compilerNeeds, installsOn, libcFromName, mayNameThisArch, namesAnOs, namesThisOs } from "./platforms";

/**
 * optionalDependencies that are per-platform builds of this package
 * (`@img/sharp-win32-x64`, `@esbuild/linux-arm64`, `@swc/core-win32-x64-msvc`).
 * npm installs whichever ones' `os`/`cpu`/`libc` fit and skips the rest.
 */
export function platformPackageNames(meta: VersionMeta): string[] {
  return Object.keys(meta.optionalDependencies ?? {}).filter(namesAnOs);
}

interface Candidate {
  name: string;
  version: string;
  meta: VersionMeta;
}

/**
 * Which platform package npm would install here, and the Node releases it
 * supports. The binaries themselves are Node-API addons or executables
 * (esbuild), so they work on any Node; only the platform package's own
 * `engines` can narrow that (sharp's win32-ia32 build is `^20.9.0`).
 */
export async function analyzePlatformPackages(
  meta: VersionMeta,
  ctx: NativeContext,
  installScript: string,
): Promise<NativeVerdict> {
  const names = platformPackageNames(meta);
  const label = platformLabel(ctx.platform);
  const who = `${meta.name} ${meta.version}`;
  // Names narrow the lookups to a few packuments; os/cpu then decide.
  const likely = names.filter((n) => namesThisOs(n, ctx.platform) && mayNameThisArch(n, ctx.platform));

  const resolved = await Promise.all(likely.map((n) => resolve(n, meta.optionalDependencies?.[n] ?? "*", ctx)));
  const found = resolved.filter((c): c is Candidate => c !== undefined);
  if (likely.length > 0 && found.length === 0) {
    throw new Error(`none of ${likely.join(", ")} is on the registry`);
  }
  const fitting: Candidate[] = [];
  for (const c of found) {
    if (await fits(c, ctx)) fitting.push(c);
  }

  // A package that compiles when no platform package fits says so in its
  // install script (msgpackr-extract's node-gyp-build-optional-packages);
  // sharp, esbuild and the napi-rs packages have no such fallback.
  const fallsBack =
    /\bnode-gyp-build-optional-packages\b|\bnode-gyp\s+rebuild\b/.test(installScript) &&
    !/npm_config_build_from_source/.test(installScript);
  const evidence = fitting.map((c) => `${c.name}@${c.version}`);

  if (fitting.length === 0) {
    const examples = names.slice(0, 3).join(", ") + (names.length > 3 ? ", …" : "");
    const then = fallsBack
      ? `npm compiles it with node-gyp, which needs ${compilerNeeds(ctx.platform)}`
      : "it can't run here";
    return {
      kind: "platform-packages",
      prebuilt: NodeSet.empty(ctx.index),
      fallsBackToSource: fallsBack,
      detail: `${who} ships its binary as per-platform packages (${examples}) but none for ${label}, so ${then}.`,
      evidence: names,
    };
  }

  let prebuilt: NodeVersionSet | "all" = "all";
  const narrowing: string[] = [];
  for (const c of fitting) {
    const range = c.meta.engines?.node;
    const own = meta.engines?.node;
    if (!range) continue;
    const set = NodeSet.fromRange(ctx.index, range);
    if (set.size === ctx.index.releases.length) continue;
    // Repeating the parent's own engines adds nothing the analyzer won't
    // already intersect, but it is still the platform package's truth.
    prebuilt = prebuilt === "all" ? set : prebuilt.intersect(set);
    if (range !== own) narrowing.push(`${c.name} requires Node ${range}`);
  }

  const from = fitting.map((c) => c.name).join(" and ");
  const detail =
    prebuilt === "all"
      ? `${who} installs its ${label} binary from ${from}, which works on any Node version.`
      : narrowing.length > 0
        ? `${who} installs its ${label} binary from ${from}, which works only on Node ${prebuilt} (${narrowing.join("; ")}).`
        : `${who} installs its ${label} binary from ${from}, which works on every Node version ${meta.name} supports.`;
  return { kind: "platform-packages", prebuilt, fallsBackToSource: fallsBack, detail, evidence };
}

async function resolve(name: string, range: string, ctx: NativeContext): Promise<Candidate | undefined> {
  try {
    const doc = await ctx.registry.packument(name);
    const exact = doc.versions[range];
    const version = exact ? range : semver.maxSatisfying(Object.keys(doc.versions), range, { loose: true });
    const meta = version ? doc.versions[version] : undefined;
    return meta && version ? { name, version, meta: { ...meta, name } } : undefined;
  } catch (err) {
    // An unpublished platform package is npm's problem too: it skips it.
    if (err instanceof NotFoundError) return undefined;
    throw err;
  }
}

/**
 * npm's os/cpu/libc check. Abbreviated packuments leave out `libc`, so on
 * Linux the name (`-musl`, `-gnu`) decides, else the full document.
 */
async function fits(c: Candidate, ctx: NativeContext): Promise<boolean> {
  if (!installsOn(c.meta, ctx.platform)) return false;
  if (ctx.platform.os !== "linux" || c.meta.libc) return true;
  const want = ctx.platform.libc ?? "glibc";
  const named = libcFromName(c.name);
  if (named) return named === want;
  try {
    const full = await ctx.registry.fullVersion(c.name, c.version);
    return installsOn({ libc: full.libc }, ctx.platform);
  } catch {
    return true;
  }
}

/**
 * Does a package need a native binary, and for which Node releases is one
 * prebuilt for this platform?
 *
 * The cheap questions come first: the abbreviated metadata answers most
 * packages (plain JavaScript, wrong platform, per-platform optional
 * packages). Only packages with install scripts cost a full version
 * document, and only those with binaries a file listing or a few HEAD
 * requests.
 */

import { JsonCache } from "../cache";
import { NodeSet } from "../node/set";
import { platformLabel } from "../platform";
import type { NativeContext, NativeVerdict, NodeVersionSet, VersionMeta } from "../types";
import { NotFoundError } from "../types";
import { defaultFetchBytes, type FetchBytes, listPackageFiles } from "./files";
import { analyzePlatformPackages, platformPackageNames } from "./packages";
import { compilerNeeds, installsOn } from "./platforms";
import { readBundledBinaries } from "./prebuilds";
import {
  abiCandidates,
  installArtifactPlan,
  nodePreGypPlan,
  nodeSassPlan,
  olderAbiCandidates,
  prebuildInstallPlan,
  probe,
} from "./remote";
import { classifyScript, installScript, type ScriptMechanism } from "./scripts";

export { listAllows } from "./platforms";

/**
 * Dependencies only native packages have: addon headers, binary loaders and
 * prebuilt-binary downloaders. They flag packages that load bundled binaries
 * without any install script (better-sqlite3 13, farmhash, sodium-native).
 */
const NATIVE_SIGNALS = new Set([
  "node-addon-api",
  "nan",
  "bindings",
  "node-gyp-build",
  "node-gyp-build-optional-packages",
  "require-addon",
  "load-addon",
  "prebuild-install",
  "@mapbox/node-pre-gyp",
  "node-pre-gyp",
  "napi-macros",
  "cmake-js",
  "install-artifact-from-github",
  "detect-libc",
]);

/** Cheap screen: could this package carry native code? (no network) */
export function mayBeNative(meta: VersionMeta): boolean {
  if (meta.hasInstallScript || meta.gypfile || meta.binary) return true;
  if (meta.os || meta.cpu || meta.libc) return true;
  if (platformPackageNames(meta).length > 0) return true;
  return hasNativeDependency(meta);
}

function hasNativeDependency(meta: VersionMeta): boolean {
  return Object.keys(meta.dependencies ?? {}).some((d) => NATIVE_SIGNALS.has(d));
}

export interface NativeAnalyzerOptions {
  /**
   * Where verdicts persist between runs; `false` disables it. Verdicts for a
   * published version only change with the platform and the Node index.
   */
  cache?: JsonCache | false;
  /** Raw downloads, for listing a tarball when jsDelivr can't. */
  fetchBytes?: FetchBytes;
}

export interface NativeAnalyzer {
  analyze(meta: VersionMeta, ctx: NativeContext): Promise<NativeVerdict>;
}

interface StoredVerdict {
  kind: NativeVerdict["kind"];
  prebuilt: "all" | string[];
  fallsBackToSource: boolean;
  detail: string;
  evidence?: string[];
}

/** A failed lookup: reported as "unknown", but never cached. */
interface Transient {
  verdict: NativeVerdict;
  transient: true;
}

export function createNativeAnalyzer(options: NativeAnalyzerOptions = {}): NativeAnalyzer {
  const cache = options.cache === false ? undefined : (options.cache ?? new JsonCache());
  const fetchBytes = options.fetchBytes ?? defaultFetchBytes;
  const memo = new Map<string, Promise<NativeVerdict>>();

  return {
    analyze(meta, ctx) {
      const key = cacheKey(meta, ctx);
      let pending = memo.get(key);
      if (!pending) {
        pending = (async () => {
          const stored = cache?.get<StoredVerdict>(key);
          if (stored) return revive(stored, ctx);
          const result = await classifySafely(meta, ctx, fetchBytes);
          if ("transient" in result) {
            memo.delete(key);
            return result.verdict;
          }
          cache?.set(key, store(result));
          return result;
        })();
        memo.set(key, pending);
      }
      return pending;
    },
  };
}

let shared: NativeAnalyzer | undefined;

/**
 * Classify `meta` (abbreviated metadata; fetch the full document or the file
 * list only when needed) and report which releases have a prebuilt binary
 * for `ctx.platform`. Never throws for a lookup failure: a verdict of kind
 * "unknown" with the reason in `detail` instead.
 */
export async function analyzeNative(meta: VersionMeta, ctx: NativeContext): Promise<NativeVerdict> {
  shared ??= createNativeAnalyzer();
  return shared.analyze(meta, ctx);
}

function cacheKey(meta: VersionMeta, ctx: NativeContext): string {
  const newest = ctx.index.releases[0]?.version ?? "none";
  return `native/${meta.name}@${meta.version}/${platformLabel(ctx.platform)}/node-${newest}`;
}

function store(v: NativeVerdict): StoredVerdict {
  const prebuilt = v.prebuilt === "all" ? "all" : v.prebuilt.releases().map((r) => r.version);
  return { kind: v.kind, prebuilt, fallsBackToSource: v.fallsBackToSource, detail: v.detail, evidence: v.evidence };
}

function revive(s: StoredVerdict, ctx: NativeContext): NativeVerdict {
  const prebuilt = s.prebuilt === "all" ? "all" : NodeSet.fromVersions(ctx.index, s.prebuilt);
  return { kind: s.kind, prebuilt, fallsBackToSource: s.fallsBackToSource, detail: s.detail, evidence: s.evidence };
}

async function classifySafely(
  meta: VersionMeta,
  ctx: NativeContext,
  fetchBytes: FetchBytes,
): Promise<NativeVerdict | Transient> {
  try {
    return await classify(meta, ctx, fetchBytes);
  } catch (err) {
    return { transient: true, verdict: lookupFailed(meta, ctx, reason(err)) };
  }
}

function reason(err: unknown): string {
  // NotFoundError's own message blames the package name, but here the
  // missing thing is a URL or a document.
  if (err instanceof NotFoundError) return `${err.what} was not found`;
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/\s+/g, " ").replace(/[.\s]+$/, "");
}

function who(meta: VersionMeta): string {
  return `${meta.name} ${meta.version}`;
}

function lookupFailed(meta: VersionMeta, ctx: NativeContext, why: string): NativeVerdict {
  const fallback = meta.hasInstallScript ? "; its install script may compile it from source" : "";
  return {
    kind: "unknown",
    prebuilt: "all",
    fallsBackToSource: false,
    detail: `nodefit couldn't check ${who(meta)} for prebuilt ${platformLabel(ctx.platform)} binaries (${why})${fallback}.`,
  };
}

async function classify(meta: VersionMeta, ctx: NativeContext, fetchBytes: FetchBytes): Promise<NativeVerdict> {
  const label = platformLabel(ctx.platform);

  if (!installsOn(meta, ctx.platform)) {
    const only = [...(meta.os ?? []), ...(meta.cpu ?? []), ...(meta.libc ?? [])].join("/");
    return {
      kind: "none",
      prebuilt: "all",
      fallsBackToSource: false,
      detail: `${who(meta)} is only for ${only}, so npm skips it on ${label}.`,
    };
  }

  if (!mayBeNative(meta)) return plainJs(meta);

  if (platformPackageNames(meta).length > 0) {
    // The install script, if any, only matters for what happens when no
    // platform package fits: some build from source then.
    const script = meta.hasInstallScript ? await fullScript(meta, ctx) : "";
    return analyzePlatformPackages(meta, ctx, script);
  }

  if (!meta.hasInstallScript && !meta.gypfile) {
    // Binaries can sit in the tarball with nothing run at install, and then
    // a missing one is a load error at runtime, not a compile.
    return bundled(meta, ctx, fetchBytes, { kind: "none" });
  }

  const full = await ctx.registry.fullVersion(meta.name, meta.version);
  const merged: VersionMeta = { ...meta, ...full };
  let script = installScript(full.scripts, full.gypfile);
  if (!script && meta.hasInstallScript && full.gypfile !== false) script = "node-gyp rebuild";
  const mechanism = classifyScript(script);

  switch (mechanism.kind) {
    case "none":
      return bundled(merged, ctx, fetchBytes, mechanism);
    case "harmless":
      return plainJs(meta, mechanism.script);
    case "prebuild-install": {
      const plan = prebuildInstallPlan(merged, mechanism.script, ctx.platform);
      if (!plan) return noRepo(merged, ctx, "prebuild-install");
      return remote(merged, ctx, "prebuild-install", plan, mechanism.fallback, `${plan.where}, via prebuild-install`);
    }
    case "node-pre-gyp": {
      const plan = nodePreGypPlan(merged, ctx.platform);
      if (typeof plan === "string") return cannotCheck(merged, ctx, "node-pre-gyp", plan, mechanism.fallback);
      return remote(merged, ctx, "node-pre-gyp", plan, mechanism.fallback, `${plan.where}, via node-pre-gyp`);
    }
    case "install-artifact": {
      const plan = installArtifactPlan(merged, mechanism.script, ctx.platform);
      if (!plan) return noRepo(merged, ctx, "install-from-cache");
      const where = `${plan.where}, via install-from-cache`;
      return remote(merged, ctx, "prebuild-install", { napi: false, ...plan }, mechanism.fallback, where);
    }
    case "node-gyp-build":
    case "check-then-build":
      return bundled(merged, ctx, fetchBytes, mechanism);
    case "custom": {
      const sass = nodeSassPlan(merged, ctx.platform);
      if (sass) {
        return remote(merged, ctx, "prebuild-install", { napi: false, ...sass }, true, `${sass.where}, via node-sass`);
      }
      // Worth a file listing only when something hints at native code
      // (deasync's build.js); puppeteer's browser download is not.
      if (!merged.gypfile && !hasNativeDependency(merged)) return unknownScript(meta, ctx, mechanism.script);
      return bundled(merged, ctx, fetchBytes, mechanism).catch(() => unknownScript(meta, ctx, mechanism.script));
    }
    case "compile":
      return sourceOnly(merged, ctx, mechanism.tool);
  }
}

/** The install script, or "" when the full document can't be had: it only refines the fallback. */
async function fullScript(meta: VersionMeta, ctx: NativeContext): Promise<string> {
  try {
    const full = await ctx.registry.fullVersion(meta.name, meta.version);
    return installScript(full.scripts, full.gypfile);
  } catch {
    return "";
  }
}

function plainJs(meta: VersionMeta, script?: string): NativeVerdict {
  const detail = script
    ? `${who(meta)} is plain JavaScript; its install script (\`${clip(script)}\`) builds nothing.`
    : `${who(meta)} is plain JavaScript.`;
  return { kind: "none", prebuilt: "all", fallsBackToSource: false, detail };
}

function clip(script: string): string {
  return script.length > 70 ? `${script.slice(0, 67)}...` : script;
}

/** What happens on releases without a fitting binary, as the end of a sentence. */
function otherwise(fallsBack: boolean, ctx: NativeContext): string {
  return fallsBack
    ? `npm compiles it with node-gyp, which needs ${compilerNeeds(ctx.platform)}`
    : "the install fails or the module can't load";
}

function sourceOnly(meta: VersionMeta, ctx: NativeContext, tool: "node-gyp" | "cmake-js"): NativeVerdict {
  const needs = tool === "cmake-js" ? `CMake and ${compilerNeeds(ctx.platform)}` : compilerNeeds(ctx.platform);
  return {
    kind: "source-only",
    prebuilt: NodeSet.empty(ctx.index),
    fallsBackToSource: true,
    detail: `${who(meta)} has no prebuilt binaries: npm always compiles it with ${tool}, which needs ${needs}.`,
  };
}

/** Prebuilt binaries inside the tarball, located by listing its files. */
async function bundled(
  meta: VersionMeta,
  ctx: NativeContext,
  fetchBytes: FetchBytes,
  mechanism: ScriptMechanism,
): Promise<NativeVerdict> {
  const listing = await listPackageFiles(meta, ctx.http, fetchBytes);
  const found = readBundledBinaries(listing.files, ctx.platform, ctx.index);
  const label = platformLabel(ctx.platform);
  const script = "script" in mechanism ? mechanism.script : "";
  // node-gyp-build and "check || node-gyp" scripts compile when no binary
  // fits, provided there is something to compile; so, as far as anyone
  // can tell, do custom scripts that ship binaries next to a binding.gyp
  // (deasync's build.js).
  const compiles = mechanism.kind !== "none" && (found.hasBindingGyp || /node-gyp\s+rebuild/.test(script));

  if (!found.hasBinaries) {
    if (mechanism.kind === "none") return plainJs(meta);
    if (mechanism.kind === "custom") return unknownScript(meta, ctx, script);
    if (compiles) return sourceOnly(meta, ctx, "node-gyp");
    return unknownScript(meta, ctx, script);
  }

  const evidence = found.matched.length ? found.matched : found.platforms.map((p) => `prebuilds for ${p}`);
  const loader = mechanism.kind !== "none" ? "" : " (loaded at runtime; nothing runs at install)";
  if (!found.prebuilt) {
    const has = found.platforms.length ? ` (it has ${listShort(found.platforms)})` : "";
    return {
      kind: "bundled-prebuilds",
      prebuilt: NodeSet.empty(ctx.index),
      fallsBackToSource: compiles,
      detail: `${who(meta)} bundles no prebuilt binary for ${label}${has}, so ${otherwise(compiles, ctx)}.`,
      evidence,
    };
  }
  if (found.prebuilt === "all") {
    return {
      kind: "bundled-prebuilds",
      prebuilt: "all",
      fallsBackToSource: compiles,
      detail: `${who(meta)} bundles a ${label} binary that works on any Node version (${found.matched[0]})${loader}.`,
      evidence,
    };
  }
  return {
    kind: "bundled-prebuilds",
    prebuilt: found.prebuilt,
    fallsBackToSource: compiles,
    detail:
      `${who(meta)} bundles prebuilt ${label} binaries only for Node ${found.prebuilt} (${listShort(found.matched)}); ` +
      `on other versions ${otherwise(compiles, ctx)}.`,
    evidence,
  };
}

function listShort(items: string[]): string {
  return items.length > 3 ? `${items.slice(0, 3).join(", ")}, …` : items.join(", ");
}

function unknownScript(meta: VersionMeta, ctx: NativeContext, script: string): NativeVerdict {
  return {
    kind: "unknown",
    prebuilt: "all",
    fallsBackToSource: false,
    detail:
      `${who(meta)} runs an install script nodefit can't analyse (\`${clip(script)}\`); ` +
      `if installing it fails on ${platformLabel(ctx.platform)}, check its documentation.`,
  };
}

function noRepo(meta: VersionMeta, ctx: NativeContext, tool: string): NativeVerdict {
  return cannotCheck(meta, ctx, tool, "its `repository` field doesn't point to GitHub", true);
}

function cannotCheck(
  meta: VersionMeta,
  ctx: NativeContext,
  tool: string,
  why: string,
  fallsBack: boolean,
): NativeVerdict {
  return {
    kind: "unknown",
    prebuilt: "all",
    fallsBackToSource: false,
    detail:
      `${who(meta)} downloads prebuilt binaries with ${tool}, but nodefit can't tell which exist (${why})` +
      (fallsBack ? `; where none fits, ${otherwise(true, ctx)}.` : "."),
  };
}

/** Binaries downloaded at install time: HEAD the URL each Node release would fetch. */
async function remote(
  meta: VersionMeta,
  ctx: NativeContext,
  kind: "prebuild-install" | "node-pre-gyp",
  plan: { napi: boolean; urlFor: Parameters<typeof probe>[2] },
  fallsBack: boolean,
  where: string,
): Promise<NativeVerdict> {
  // Node-API builds cost one request per N-API level, so every release is
  // probed; ABI builds cost one per line, so only the lines `engines` allows.
  const candidates = plan.napi ? ctx.index.releases : abiCandidates(ctx.index, meta.engines?.node);
  let result = await probe(ctx.index, candidates, plan.urlFor, ctx.http);
  if (!plan.napi && result.prebuilt.isEmpty()) {
    const older = await probe(ctx.index, olderAbiCandidates(ctx.index, meta.engines?.node), plan.urlFor, ctx.http);
    if (!older.prebuilt.isEmpty()) {
      result = { ...older, missing: [...result.missing, ...older.missing] };
    }
  }
  const label = platformLabel(ctx.platform);
  const evidence = [...result.found, ...result.missing.map((u) => `missing: ${u}`)];
  const prebuilt: NodeVersionSet = result.prebuilt;

  if (prebuilt.isEmpty()) {
    return {
      kind,
      prebuilt,
      fallsBackToSource: fallsBack,
      detail: `${who(meta)} has no prebuilt ${label} binary to download (${where}), so ${otherwise(fallsBack, ctx)}.`,
      evidence,
    };
  }
  const engines = meta.engines?.node ? NodeSet.fromRange(ctx.index, meta.engines.node) : NodeSet.all(ctx.index);
  const probed = NodeSet.fromVersions(
    ctx.index,
    candidates.map((r) => r.version),
  ).intersect(engines);
  const everywhere = probed.intersect(prebuilt).size === probed.size;
  const detail = everywhere
    ? `${who(meta)} downloads a prebuilt ${label} binary (${where}) for every Node version it supports.`
    : `${who(meta)} downloads prebuilt ${label} binaries only for Node ${prebuilt} (${where}); ` +
      `on other versions ${otherwise(fallsBack, ctx)}.`;
  return { kind, prebuilt, fallsBackToSource: fallsBack, detail, evidence };
}

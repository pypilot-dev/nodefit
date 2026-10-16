import { NodeSet } from "../node/set";
import type { HttpClient, NodeIndex, NodeRelease, Platform, VersionMeta } from "../types";
import { libcOf } from "./platforms";

/**
 * How far back ABI-specific binaries are probed: one HEAD request per Node
 * line, so the lines nobody should still run are skipped. Node-API builds
 * need only one request per N-API level and are always probed in full.
 */
export const ABI_LINES_PROBED = 10;
const PROBE_CONCURRENCY = 4;

/** owner/repo from a package's `repository` field, when it is on GitHub. */
export function githubRepo(repository: VersionMeta["repository"]): { owner: string; repo: string } | undefined {
  const url = typeof repository === "string" ? repository : repository?.url;
  if (!url) return undefined;
  const full = /github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?]|$)/i.exec(url);
  if (full?.[1] && full[2]) return { owner: full[1], repo: full[2] };
  const short = /^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:#.*)?$/.exec(url);
  if (short?.[1] && short[2]) return { owner: short[1], repo: short[2] };
  return undefined;
}

/** Releases to probe for an ABI-specific binary: the recent lines `engines` allows. */
export function abiCandidates(index: NodeIndex, engines: string | undefined): NodeRelease[] {
  const newest = index.releases[0]?.major ?? 0;
  let allowed = engines ? NodeSet.fromRange(index, engines) : NodeSet.all(index);
  // An `engines` range newer than the index (a stale offline snapshot)
  // would leave nothing to probe and read as "no binaries at all".
  if (allowed.isEmpty()) allowed = NodeSet.all(index);
  return allowed.releases().filter((r) => r.major > newest - ABI_LINES_PROBED);
}

/**
 * The older lines `abiCandidates` leaves out, back to Node 8. Probed only when
 * the recent lines have nothing: a legacy package (node-sass 4) has binaries
 * for old Node alone, and "works up to Node 14" is the useful answer there.
 */
export function olderAbiCandidates(index: NodeIndex, engines: string | undefined): NodeRelease[] {
  const newest = index.releases[0]?.major ?? 0;
  let allowed = engines ? NodeSet.fromRange(index, engines) : NodeSet.all(index);
  if (allowed.isEmpty()) allowed = NodeSet.all(index);
  return allowed.releases().filter((r) => r.major <= newest - ABI_LINES_PROBED && r.major >= 8);
}

/** The highest N-API build a release can load, as prebuild-install and node-pre-gyp pick it. */
export function bestNapiBuild(release: NodeRelease, napiVersions: number[]): number | undefined {
  if (release.napi === undefined) return undefined;
  const fits = napiVersions.filter((v) => v <= (release.napi as number));
  return fits.length ? Math.max(...fits) : undefined;
}

export function napiVersionsOf(meta: VersionMeta): number[] {
  const raw = (meta.binary as { napi_versions?: unknown } | undefined)?.napi_versions;
  return Array.isArray(raw) ? raw.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
}

export interface Probe {
  /** Releases present, plus the URLs that answered. */
  prebuilt: NodeSet;
  found: string[];
  missing: string[];
}

/**
 * HEAD every distinct URL `urlFor` gives the releases, a few at a time, and
 * collect the releases whose URL exists. Network errors propagate: a verdict
 * built on half the answers would be wrong in either direction.
 */
export async function probe(
  index: NodeIndex,
  releases: NodeRelease[],
  urlFor: (r: NodeRelease) => string | undefined,
  http: HttpClient,
): Promise<Probe> {
  const byUrl = new Map<string, NodeRelease[]>();
  for (const r of releases) {
    const url = urlFor(r);
    if (!url) continue;
    const group = byUrl.get(url) ?? [];
    group.push(r);
    byUrl.set(url, group);
  }
  const urls = [...byUrl.keys()];
  const exists = await mapLimit(urls, PROBE_CONCURRENCY, (u) => http.exists(u));
  const found = urls.filter((_, i) => exists[i]);
  const missing = urls.filter((_, i) => !exists[i]);
  const versions = found.flatMap((u) => (byUrl.get(u) ?? []).map((r) => r.version));
  return { prebuilt: NodeSet.fromVersions(index, versions), found, missing };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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

function expand(template: string, values: Record<string, string | number | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const v = values[key];
    return v === undefined ? whole : String(v);
  });
}

function unscoped(name: string): string {
  return name.replace(/^@[^/]+\//, "");
}

// --------------------------------------------------------------------------
// prebuild-install

export interface PrebuildInstallPlan {
  napi: boolean;
  urlFor(r: NodeRelease): string | undefined;
  where: string;
}

/**
 * prebuild-install's download URL (its util.js): GitHub releases of the
 * package's repository unless `binary.host` says otherwise. With `-r napi`
 * the "abi" slot holds the N-API build version instead of the Node ABI;
 * the platform carries "musl" on Alpine and nothing on glibc.
 */
export function prebuildInstallPlan(
  meta: VersionMeta,
  script: string,
  platform: Platform,
): PrebuildInstallPlan | undefined {
  const config = (meta as { config?: { runtime?: string } }).config;
  const napi = /(?:-r|--runtime)(?:\s+|=)napi\b/.test(script) || config?.runtime === "napi";
  const napiVersions = napiVersionsOf(meta);
  const binary = meta.binary as { host?: string; remote_path?: string; package_name?: string } | undefined;
  const fileName = "{name}-v{version}-{runtime}-v{abi}-{platform}{libc}-{arch}.tar.gz";

  let template: string;
  let where: string;
  if (typeof binary?.host === "string") {
    template = [binary.host, binary.remote_path, binary.package_name ?? fileName]
      .map((p) => p?.replace(/^\.\/|^\/|\/$/g, ""))
      .filter(Boolean)
      .join("/");
    where = new URL(binary.host).host;
  } else {
    const repo = githubRepo(meta.repository);
    if (!repo) return undefined;
    template = `https://github.com/${repo.owner}/${repo.repo}/releases/download/v{version}/${fileName}`;
    where = "GitHub release assets";
  }

  const libc = libcOf(platform) === "musl" ? "musl" : "";
  return {
    napi,
    where,
    urlFor(r) {
      const abi = napi ? bestNapiBuild(r, napiVersions.length ? napiVersions : [r.napi ?? 0]) : r.abi;
      if (abi === undefined || abi === 0) return undefined;
      return expand(template, {
        name: unscoped(meta.name),
        package_name: unscoped(meta.name),
        version: meta.version,
        abi,
        node_abi: r.abi,
        runtime: napi ? "napi" : "node",
        platform: platform.os,
        arch: platform.arch,
        libc,
        configuration: "Release",
        tag_prefix: "v",
      });
    },
  };
}

// --------------------------------------------------------------------------
// node-pre-gyp

export interface NodePreGypPlan {
  napi: boolean;
  urlFor(r: NodeRelease): string | undefined;
  where: string;
}

/**
 * node-pre-gyp's hosted_tarball (lib/util/versioning.js): host + remote_path
 * + package_name, each a template. Returns a reason string when the
 * template needs something nodefit can't know here (the glibc version).
 */
export function nodePreGypPlan(meta: VersionMeta, platform: Platform): NodePreGypPlan | string {
  const binary = (meta.binary ?? {}) as Record<string, unknown>;
  const hostField = binary.host ?? binary.production_host;
  const host =
    typeof hostField === "string"
      ? hostField
      : typeof (hostField as { endpoint?: unknown })?.endpoint === "string"
        ? ((hostField as { endpoint: string }).endpoint as string)
        : undefined;
  if (!host) return "its `binary` field names no download host";
  const moduleName = typeof binary.module_name === "string" ? binary.module_name : meta.name;
  const remotePath = typeof binary.remote_path === "string" ? binary.remote_path : "";
  const packageName =
    typeof binary.package_name === "string"
      ? binary.package_name
      : "{module_name}-v{version}-{node_abi}-{platform}-{arch}.tar.gz";
  const all = `${host} ${remotePath} ${packageName}`;
  if (platform.os === "linux" && all.includes("{libc_version}")) {
    return "its download URL includes the glibc version, which nodefit doesn't detect";
  }

  const napiVersions = napiVersionsOf(meta);
  const napi = napiVersions.length > 0;
  const libc = libcOf(platform) ?? "unknown";
  const [major, minor, patch] = meta.version.split(/[.+-]/);

  return {
    napi,
    where: safeHost(host),
    urlFor(r) {
      const napiBuild = napi ? bestNapiBuild(r, napiVersions) : undefined;
      if (napi && napiBuild === undefined) return undefined;
      const values = {
        name: meta.name,
        module_name: moduleName,
        version: meta.version,
        major,
        minor,
        patch,
        configuration: "Release",
        runtime: "node",
        node_abi: `node-v${r.abi}`,
        node_abi_napi: napi ? "napi" : `node-v${r.abi}`,
        napi_version: r.napi,
        napi_build_version: napiBuild ?? "",
        node_napi_label: napiBuild ? `napi-v${napiBuild}` : `node-v${r.abi}`,
        platform: platform.os,
        target_platform: platform.os,
        arch: platform.arch,
        target_arch: platform.arch,
        libc,
        libc_version: "unknown",
        toolset: "",
      };
      const base = withSlash(expand(host, values));
      const path = withSlash(
        expand(remotePath, values)
          .replace(/^(\.\/)+/, "")
          .replace(/^\/+/, ""),
      );
      try {
        return new URL(expand(packageName, values), new URL(path === "/" ? "" : path, base)).href;
      } catch {
        return undefined;
      }
    },
  };
}

function withSlash(s: string): string {
  return s.endsWith("/") ? s : `${s}/`;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// --------------------------------------------------------------------------
// node-sass

/**
 * node-sass downloads `<platform>-<arch>-<abi>_binding.node` from its
 * `nodeSassConfig.binarySite` in scripts/install.js, and its postinstall
 * compiles with node-gyp when that fails. Long deprecated, but still in many
 * older projects, where it is the classic node-gyp failure on a newer Node.
 */
export function nodeSassPlan(meta: VersionMeta, platform: Platform) {
  const config = (meta as { nodeSassConfig?: { binarySite?: unknown } }).nodeSassConfig;
  const site = typeof config?.binarySite === "string" ? config.binarySite : undefined;
  if (meta.name !== "node-sass" && !site) return undefined;
  const base = (site ?? "https://github.com/sass/node-sass/releases/download").replace(/\/+$/, "");
  const os = platform.os === "linux" && libcOf(platform) === "musl" ? "linux_musl" : platform.os;
  return {
    where: "GitHub release assets",
    urlFor(r: NodeRelease) {
      return `${base}/v${meta.version}/${os}-${platform.arch}-${r.abi}_binding.node`;
    },
  };
}

// --------------------------------------------------------------------------
// install-artifact-from-github (re2)

/**
 * install-artifact-from-github's asset (bin/install-from-cache.js): the
 * release tagged with the bare version, file `<platform>[-musl]-<arch>-<abi>`
 * plus ".br" or ".gz"; probing ".br" is enough because it publishes both.
 */
export function installArtifactPlan(meta: VersionMeta, script: string, platform: Platform) {
  const repo = githubRepo(meta.repository);
  if (!repo) return undefined;
  const arg = (name: string) => new RegExp(`--${name}\\s+(\\S+)`).exec(script)?.[1]?.replace(/^["']|["']$/g, "") ?? "";
  const prefix = arg("prefix");
  const suffix = arg("suffix");
  const napiLevel = arg("napi");
  const os = libcOf(platform) === "musl" ? `${platform.os}-musl` : platform.os;
  return {
    where: "GitHub release assets",
    urlFor(r: NodeRelease) {
      const slot = napiLevel ? `napi-v${napiLevel}` : r.abi;
      return `https://github.com/${repo.owner}/${repo.repo}/releases/download/${meta.version}/${prefix}${os}-${platform.arch}-${slot}${suffix}.br`;
    },
  };
}

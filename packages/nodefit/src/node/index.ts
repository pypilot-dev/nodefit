/**
 * Node.js releases and sets of them.
 */

import semver from "semver";
import snapshot from "../../data/node-releases.json" with { type: "json" };
import { JsonCache } from "../cache";
import { createHttpClient } from "../http";
import type { HttpClient, NodeIndex, NodeRelease } from "../types";
import {
  type CompactIndex,
  compactReleases,
  compactSchedule,
  expand,
  INDEX_URL,
  isCompactIndex,
  type RawRelease,
  type RawSchedule,
  SCHEDULE_URL,
} from "./releases";

export { napiVersion } from "./napi";
export { NodeSet } from "./set";

const DAY = 24 * 60 * 60 * 1000;
const CACHE_KEY = "node-index";

export interface LoadIndexOptions {
  http?: HttpClient;
  /** Never touch the network: cache, else the bundled snapshot. */
  offline?: boolean;
  /** Where the index is cached; defaults to nodefit's cache directory. */
  cache?: JsonCache;
}

/**
 * Every final Node release with its ABI and N-API version: from
 * nodejs.org/dist/index.json (cached a day), else the cache at any age, else
 * the snapshot shipped in data/node-releases.json.
 */
export async function loadNodeIndex(opts: LoadIndexOptions = {}): Promise<NodeIndex> {
  const cache = opts.cache ?? new JsonCache();
  const fresh = cache.get<unknown>(CACHE_KEY, DAY);
  if (isCompactIndex(fresh)) return build(fresh, "cache");

  const stale = cache.get<unknown>(CACHE_KEY);
  const cached = isCompactIndex(stale) ? stale : undefined;
  const bundled = snapshot as unknown as CompactIndex;

  if (!opts.offline) {
    const http = opts.http ?? createHttpClient();
    // The schedule only adds end-of-life dates, so its failure must not cost
    // the index; past lines' dates never change, so older ones do instead.
    const [index, schedule] = await Promise.allSettled([
      http.getJson<RawRelease[]>(INDEX_URL),
      http.getJson<RawSchedule>(SCHEDULE_URL),
    ]);
    const releases = index.status === "fulfilled" && Array.isArray(index.value) ? compactReleases(index.value) : [];
    if (releases.length > 0) {
      const eol =
        schedule.status === "fulfilled" && schedule.value && typeof schedule.value === "object"
          ? compactSchedule(schedule.value)
          : {};
      const compact: CompactIndex = {
        fetchedAt: new Date().toISOString(),
        releases,
        eol: { ...bundled.eol, ...cached?.eol, ...eol },
      };
      cache.set(CACHE_KEY, compact);
      return build(compact, "network");
    }
  }

  // An old cache can still be newer than the snapshot of an updated nodefit.
  if (cached && cached.fetchedAt > bundled.fetchedAt) return build(cached, "cache");
  return build(bundled, "bundled");
}

function build(compact: CompactIndex, source: NodeIndex["source"]): NodeIndex {
  return { releases: expand(compact), source, fetchedAt: compact.fetchedAt };
}

/** The release for a version string ("v22.11.0" or "22.11.0"), if in the index. */
export function findRelease(index: NodeIndex, version: string): NodeRelease | undefined {
  const wanted = version.trim().replace(/^v/, "");
  return index.releases.find((r) => r.version === wanted);
}

/**
 * Resolve what a pin file says ("22", "lts/jod", "lts/*", "node", ">=20") to
 * the newest matching release, as nvm/fnm/volta would.
 */
export function resolveNodeSpec(index: NodeIndex, spec: string): NodeRelease | undefined {
  // .nvmrc allows comments; nvm strips them before reading the version.
  const s = (spec.split("#")[0] ?? "").trim().toLowerCase();
  if (s === "") return undefined;
  const newest = index.releases[0];

  if (s === "node" || s === "latest" || s === "current" || s === "stable") return newest;
  // nvm/fnm write "lts/*"; volta and mise accept "lts"; fnm "lts-latest".
  if (s === "lts/*" || s === "lts" || s === "lts-latest") return ltsLines(index)[0];

  const lts = /^lts\/(.+)$/.exec(s)?.[1];
  if (lts !== undefined) {
    const back = /^-(\d+)$/.exec(lts)?.[1];
    if (back !== undefined) return ltsLines(index)[Number(back)];
    return index.releases.find((r) => r.lts !== false && r.lts.toLowerCase() === lts);
  }

  // A partial version ("22", "v22.11") means its newest release, the way
  // every version manager reads it; semver would agree, but this is exact.
  const partial = /^v?(\d+(?:\.\d+){0,2})$/.exec(s)?.[1];
  if (partial !== undefined) {
    return index.releases.find((r) => r.version === partial || r.version.startsWith(`${partial}.`));
  }

  const range = semver.validRange(s, { loose: true });
  if (range === null) return undefined;
  return index.releases.find((r) => semver.satisfies(r.version, range, { loose: true }));
}

/** The newest release of each LTS line, newest line first: what "lts/*" and "lts/-1" pick from. */
export function ltsLines(index: NodeIndex): NodeRelease[] {
  const seen = new Set<number>();
  const out: NodeRelease[] = [];
  for (const r of index.releases) {
    if (r.lts === false || seen.has(r.major)) continue;
    seen.add(r.major);
    out.push(r);
  }
  return out;
}

/**
 * True once the release's line no longer gets fixes, security ones
 * included. False when the index has no end-of-life date for the line:
 * crying wolf over a missing date would be worse than staying quiet.
 */
export function isEndOfLife(release: NodeRelease, today: Date = new Date()): boolean {
  return release.eol !== undefined && today.toISOString().slice(0, 10) >= release.eol;
}

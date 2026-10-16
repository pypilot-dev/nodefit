import type { NodeRelease } from "../types";
import { napiVersion } from "./napi";

export const INDEX_URL = "https://nodejs.org/dist/index.json";
export const SCHEDULE_URL = "https://raw.githubusercontent.com/nodejs/Release/main/schedule.json";

/** One entry of index.json (the fields nodefit reads). */
export interface RawRelease {
  version: string;
  date: string;
  modules?: string;
  lts: string | false;
}

/** Node's release schedule, keyed "v22", "v0.12". */
export type RawSchedule = Record<string, { start?: string; lts?: string; maintenance?: string; end?: string }>;

/** `[version, abi, lts, date]`: index.json minus everything nodefit never reads. */
export type CompactRelease = [version: string, abi: number, lts: string | false, date: string];

/**
 * The form both the disk cache and the bundled snapshot take. index.json is
 * over 300 kB, mostly file lists; this keeps a tenth of it. N-API levels are
 * not stored: they come from the matrix in napi.ts, so fixing that table
 * fixes old caches and snapshots too.
 */
export interface CompactIndex {
  fetchedAt: string;
  /** Newest first. */
  releases: CompactRelease[];
  /** End of life by major line: { "22": "2027-04-30" }. */
  eol: Record<string, string>;
}

/**
 * Lines before 4 are 0.x and io.js: `major` cannot tell 0.10 from 0.12, and
 * no dependency a project installs today still supports them.
 */
const OLDEST_MAJOR = 4;

const FINAL = /^v?(\d+)\.\d+\.\d+$/;

export function compactReleases(raw: RawRelease[]): CompactRelease[] {
  const out: CompactRelease[] = [];
  for (const r of raw) {
    const m = FINAL.exec(r.version);
    // Without `modules` there is no ABI to match binaries against.
    if (!m || !r.modules || Number(m[1]) < OLDEST_MAJOR) continue;
    const abi = Number(r.modules);
    if (!Number.isInteger(abi)) continue;
    out.push([r.version.replace(/^v/, ""), abi, r.lts || false, r.date]);
  }
  return out.sort((a, b) => compareVersions(b[0], a[0]));
}

export function compactSchedule(raw: RawSchedule): Record<string, string> {
  const eol: Record<string, string> = {};
  for (const [line, dates] of Object.entries(raw)) {
    const m = /^v(\d+)$/.exec(line);
    if (m?.[1] && dates.end) eol[m[1]] = dates.end;
  }
  return eol;
}

export function expand(compact: CompactIndex): NodeRelease[] {
  return compact.releases.map(([version, abi, lts, date]) => {
    const major = Number(version.split(".")[0]);
    const release: NodeRelease = { version, major, abi, lts, date };
    const napi = napiVersion(version);
    if (napi !== undefined) release.napi = napi;
    const eol = compact.eol[major];
    if (eol) release.eol = eol;
    return release;
  });
}

/** True for something shaped like a CompactIndex; caches outlive the code that wrote them. */
export function isCompactIndex(value: unknown): value is CompactIndex {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<CompactIndex>;
  return (
    typeof v.fetchedAt === "string" &&
    typeof v.eol === "object" &&
    v.eol !== null &&
    Array.isArray(v.releases) &&
    v.releases.length > 0 &&
    v.releases.every((r) => Array.isArray(r) && r.length === 4 && typeof r[0] === "string" && typeof r[1] === "number")
  );
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

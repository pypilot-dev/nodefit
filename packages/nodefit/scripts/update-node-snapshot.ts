/**
 * Regenerates data/node-releases.json, the Node release index nodefit falls
 * back to when it has neither network nor cache. Run before a release so a
 * fresh install offline still knows recent Node versions:
 *
 *   bun run scripts/update-node-snapshot.ts
 */

import { join } from "node:path";
import {
  type CompactIndex,
  compactReleases,
  compactSchedule,
  INDEX_URL,
  type RawRelease,
  type RawSchedule,
  SCHEDULE_URL,
} from "../src/node/releases";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return (await res.json()) as T;
}

const [raw, schedule] = await Promise.all([getJson<RawRelease[]>(INDEX_URL), getJson<RawSchedule>(SCHEDULE_URL)]);
const snapshot: CompactIndex = {
  fetchedAt: new Date().toISOString(),
  releases: compactReleases(raw),
  eol: compactSchedule(schedule),
};

// One release per line keeps diffs of this file readable.
const lines = [
  "{",
  `"fetchedAt": ${JSON.stringify(snapshot.fetchedAt)},`,
  `"eol": ${JSON.stringify(snapshot.eol)},`,
  '"releases": [',
  snapshot.releases.map((r) => JSON.stringify(r)).join(",\n"),
  "]",
  "}",
  "",
];
const out = join(import.meta.dir, "..", "data", "node-releases.json");
await Bun.write(out, lines.join("\n"));
console.log(`Wrote ${snapshot.releases.length} releases (newest ${snapshot.releases[0]?.[0]}) to ${out}`);

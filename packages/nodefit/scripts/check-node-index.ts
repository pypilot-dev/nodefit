/**
 * Live sanity check of the Node release index, which `bun test` cannot do
 * because tests are offline. Uses a throwaway cache so the answer really
 * comes from the network:
 *
 *   bun run scripts/check-node-index.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonCache } from "../src/cache";
import { isEndOfLife, loadNodeIndex, ltsLines, resolveNodeSpec } from "../src/node/index";

const dir = mkdtempSync(join(tmpdir(), "nodefit-check-"));
try {
  const index = await loadNodeIndex({ cache: new JsonCache(dir) });
  const newest = index.releases[0];
  console.log(`source: ${index.source}, ${index.releases.length} releases, fetched ${index.fetchedAt}`);
  console.log("newest:", newest);
  console.log("lts/*:", resolveNodeSpec(index, "lts/*")?.version, "lts/-1:", resolveNodeSpec(index, "lts/-1")?.version);
  console.log(
    "LTS lines:",
    ltsLines(index)
      .map((r) => `${r.major} ${r.lts}${isEndOfLife(r) ? " (EOL)" : ""}`)
      .join(", "),
  );
  if (index.source !== "network") process.exit(1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

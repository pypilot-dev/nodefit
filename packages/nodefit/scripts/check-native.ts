/**
 * Live sanity check for native/: classify real packages on this machine's
 * platform against the real registry, jsDelivr and GitHub. Not a test (it
 * needs the network); run it after changing native/ and compare with what
 * `npm install` does.
 *
 *   bun scripts/check-native.ts [name[@version] ...]
 */

import { createHttpClient } from "../src/http";
import { createNativeAnalyzer } from "../src/native";
import { currentPlatform, platformLabel } from "../src/platform";
import { Registry } from "../src/registry/client";
import type { NodeIndex, NodeRelease } from "../src/types";

const DEFAULT = [
  "sharp",
  "esbuild",
  "@swc/core",
  "lightningcss",
  "better-sqlite3",
  "better-sqlite3@12.4.1",
  "sqlite3",
  "bcrypt",
  "bcrypt@5.1.1",
  "argon2",
  "bufferutil",
  "classic-level",
  "isolated-vm",
  "canvas",
  "canvas@2.11.2",
  "keytar",
  "kerberos",
  "re2",
  "libxmljs2",
  "node-pty",
  "deasync",
  "farmhash",
  "msgpackr-extract",
  "cpu-features",
  "unix-dgram",
  "fsevents",
  "core-js",
  "puppeteer",
  "lodash",
];

// nodejs.org's index has no N-API column; these are the levels each line
// ends up with, which is all prebuild-install's choice depends on.
const NAPI_BY_MAJOR: Record<number, number> = { 14: 8, 15: 8, 16: 8, 17: 8, 18: 9, 19: 9, 20: 9, 21: 9 };

async function liveIndex(): Promise<NodeIndex> {
  const res = await fetch("https://nodejs.org/dist/index.json");
  const rows = (await res.json()) as { version: string; modules?: string; lts: string | false; date: string }[];
  const releases: NodeRelease[] = rows
    .filter((r) => r.modules)
    .map((r) => {
      const version = r.version.replace(/^v/, "");
      const major = Number(version.split(".")[0]);
      return {
        version,
        major,
        abi: Number(r.modules),
        napi: major >= 22 ? 10 : NAPI_BY_MAJOR[major],
        lts: r.lts,
        date: r.date,
      };
    })
    .filter((r) => r.major >= 14);
  return { releases, source: "network", fetchedAt: new Date().toISOString() };
}

const http = createHttpClient();
const registry = new Registry(http);
const index = await liveIndex();
const platform = currentPlatform();
const analyzer = createNativeAnalyzer({ cache: false });
const specs = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT;

console.log(`platform ${platformLabel(platform)}, newest Node ${index.releases[0]?.version}\n`);
for (const spec of specs) {
  const at = spec.lastIndexOf("@");
  const [name, wanted] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, undefined];
  const doc = await registry.packument(name);
  const version = wanted ?? doc["dist-tags"].latest ?? "";
  const meta = doc.versions[version];
  if (!meta) {
    console.log(`${spec}: no such version`);
    continue;
  }
  const started = Date.now();
  const v = await analyzer.analyze(meta, { registry, index, platform, http });
  const prebuilt = v.prebuilt === "all" ? "all" : v.prebuilt.toString();
  console.log(
    `${name}@${version}  [${v.kind}]  prebuilt=${prebuilt}  source=${v.fallsBackToSource}  (${Date.now() - started} ms)`,
  );
  console.log(`  ${v.detail}\n`);
}

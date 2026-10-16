import { analyzeWith } from "../src/analyze";
import type { FindingHooks } from "../src/analyze/findings";
import { NodeSet } from "../src/node/set";
import { FixtureRegistry } from "../src/registry/fixture";
import type { HttpClient, NativeVerdict, Report, VersionMeta } from "../src/types";
import { testIndex } from "./helpers";

export const index = testIndex();

export const hooks: FindingHooks = {
  resolveSpec: (i, spec) => i.releases.find((r) => r.version === spec) ?? i.releases.find((r) => `${r.major}` === spec),
  useCommand: (manager, version) => `${manager} use ${version}`,
  today: "2026-10-16",
};

export const offline: HttpClient = {
  getJson: () => Promise.reject(new Error("no network in tests")),
  getText: () => Promise.reject(new Error("no network in tests")),
  exists: () => Promise.reject(new Error("no network in tests")),
};

/** The package.json the sample report was made from, as an editor would hold it. */
export const PACKAGE_JSON = `{
  "name": "shop",
  "engines": { "node": ">=18" },
  "dependencies": {
    "better-sqlite3": "^12.4.1",
    "express": "^5.1.0"
  },
  "devDependencies": {
    "vite": "^7.1.0"
  }
}
`;

/**
 * A project on Node 18.20 whose better-sqlite3 has binaries for 20 and 22
 * only, and whose vite (via a transitive rollup) needs 20.19+.
 */
export function sampleReport(current = "18.20.4"): Promise<Report> {
  return analyzeWith(
    {
      project: {
        root: "/work/shop",
        name: "shop",
        dependencies: [
          { name: "better-sqlite3", range: "^12.4.1", kind: "prod" },
          { name: "express", range: "^5.1.0", kind: "prod" },
          { name: "vite", range: "^7.1.0", kind: "dev" },
        ],
        lockfile: { kind: "npm", path: "/work/shop/package-lock.json" },
        locked: [
          { name: "better-sqlite3", version: "12.4.1", hasInstallScript: true, engines: { node: ">=18" } },
          { name: "express", version: "5.1.0", engines: { node: ">= 18" } },
          { name: "vite", version: "7.1.0", dev: true, dependencies: { rollup: "^4" } },
          { name: "rollup", version: "4.50.0", dev: true, engines: { node: ">=20.19.0" } },
        ],
        pins: [{ source: "engines", file: "/work/shop/package.json", value: ">=18", exact: false }],
        packageManager: "npm",
        workspaces: [],
      },
      env: { current: { version: current, path: "/usr/bin/node" }, managers: ["fnm"], installed: ["18.20.4"] },
      index,
      registry: new FixtureRegistry(),
      http: offline,
      platform: { os: "linux", arch: "x64", libc: "glibc" },
      native: async (meta: VersionMeta): Promise<NativeVerdict> =>
        meta.name === "better-sqlite3"
          ? {
              kind: "prebuild-install",
              prebuilt: NodeSet.fromAbis(index, [115, 127]),
              fallsBackToSource: true,
              detail: "prebuild-install downloads binaries for Node 20 and 22 from the GitHub release",
            }
          : { kind: "none", prebuilt: "all", fallsBackToSource: false, detail: "" },
    },
    hooks,
  );
}

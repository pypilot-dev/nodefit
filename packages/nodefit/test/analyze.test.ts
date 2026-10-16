import { describe, expect, test } from "bun:test";
import { type AnalyzeOptions, analyzeWith, viaChains } from "../src/analyze";
import { checkPackage, parseCheckSpec } from "../src/analyze/check";
import type { FindingHooks } from "../src/analyze/findings";
import { parseDependencySpec } from "../src/analyze/resolve";
import { NodeSet } from "../src/node/set";
import { FixtureRegistry } from "../src/registry/fixture";
import type {
  HttpClient,
  LockedPackage,
  NativeVerdict,
  NodeEnvironment,
  NodeIndex,
  ProjectInfo,
  Report,
  VersionMeta,
} from "../src/types";
import { testIndex } from "./helpers";

const index = testIndex();

const hooks: FindingHooks = {
  // Enough of nvm's reading for tests: an exact version, else the newest of a major.
  resolveSpec: (i, spec) => i.releases.find((r) => r.version === spec) ?? i.releases.find((r) => `${r.major}` === spec),
  useCommand: (manager, version) => `${manager} use ${version}`,
  today: "2026-10-16",
};

const offline: HttpClient = {
  getJson: () => Promise.reject(new Error("no network in tests")),
  getText: () => Promise.reject(new Error("no network in tests")),
  exists: () => Promise.reject(new Error("no network in tests")),
};

function project(over: Partial<ProjectInfo> = {}): ProjectInfo {
  return { root: "/app", dependencies: [], locked: [], pins: [], packageManager: "npm", workspaces: [], ...over };
}

function env(version?: string): NodeEnvironment {
  return { ...(version ? { current: { version, path: "/usr/bin/node" } } : {}), managers: ["fnm"], installed: [] };
}

type Verdicts = Record<string, (index: NodeIndex) => NativeVerdict>;

function run(
  over: Partial<AnalyzeOptions> & { verdicts?: Verdicts; hooks?: Partial<FindingHooks> } = {},
): Promise<Report> {
  const verdicts = over.verdicts ?? {};
  return analyzeWith(
    {
      project: project(),
      env: env("22.21.1"),
      index,
      registry: new FixtureRegistry(),
      http: offline,
      platform: { os: "win32", arch: "x64" },
      native: async (meta: VersionMeta) => {
        const make = verdicts[meta.name];
        if (!make) return { kind: "none", prebuilt: "all", fallsBackToSource: false, detail: "plain JavaScript" };
        return make(index);
      },
      ...over,
    },
    { ...hooks, ...over.hooks },
  );
}

const ids = (r: Report) => r.findings.map((f) => f.id);
const finding = (r: Report, id: string) => r.findings.find((f) => f.id === id);

const prebuiltFor =
  (abis: number[], fallsBackToSource = true) =>
  (i: NodeIndex): NativeVerdict => ({
    kind: "prebuild-install",
    prebuilt: NodeSet.fromAbis(i, abis),
    fallsBackToSource,
    detail: "prebuild-install downloads binaries from the GitHub release",
  });

describe("analyze from package.json", () => {
  test("engines ranges intersect and the newest LTS is recommended", async () => {
    const registry = new FixtureRegistry()
      .add("a", [{ version: "1.0.0", engines: { node: ">=20" } }])
      .add("b", [{ version: "2.0.0", engines: { node: "<23" } }]);
    const r = await run({
      registry,
      project: project({
        dependencies: [
          { name: "a", range: "^1", kind: "prod" },
          { name: "b", range: "*", kind: "dev" },
        ],
      }),
      env: env("18.20.4"),
    });
    expect(r.supported.toString()).toBe("20–22");
    expect(r.recommended?.version).toBe("22.21.1");
    const f = finding(r, "current-unsupported");
    expect(f?.severity).toBe("error");
    expect(f?.title).toBe("Node 18.20 does not fit this project");
    expect(f?.detail).toContain("a 1.0.0 (20–24)");
    expect(f?.packages).toEqual(["a"]);
    expect(f?.fix).toEqual({ kind: "use-node", version: "22", command: "fnm use 22" });
  });

  test("dist-tags, aliases and the latest tag are honoured", async () => {
    const registry = new FixtureRegistry()
      .addPackument({
        name: "tagged",
        "dist-tags": { latest: "1.0.0", next: "2.0.0-beta.1" },
        versions: {
          "1.0.0": { name: "tagged", version: "1.0.0" },
          "1.5.0": { name: "tagged", version: "1.5.0" },
          "2.0.0-beta.1": { name: "tagged", version: "2.0.0-beta.1", engines: { node: ">=22" } },
        },
      })
      .add("real", [{ version: "3.1.0" }]);
    const r = await run({
      registry,
      project: project({
        dependencies: [
          { name: "tagged", range: "next", kind: "prod" },
          { name: "alias", range: "npm:real@^3", kind: "prod" },
        ],
      }),
    });
    expect(r.packages.map((p) => `${p.name}@${p.version}`).sort()).toEqual(["alias@3.1.0", "tagged@2.0.0-beta.1"]);
    expect(r.supported.toString()).toBe("22–24");
  });

  test("non-registry specs and unknown names are unresolved, with a reason", async () => {
    const r = await run({
      project: project({
        dependencies: [
          { name: "local", range: "file:../local", kind: "prod" },
          { name: "forked", range: "github:me/forked#main", kind: "prod" },
          { name: "typo-pkg", range: "^1", kind: "prod" },
        ],
      }),
    });
    expect(r.unresolved.map((u) => u.name).sort()).toEqual(["forked", "local", "typo-pkg"]);
    expect(r.unresolved.find((u) => u.name === "typo-pkg")?.reason).toContain("is not on the npm registry");
    expect(finding(r, "unresolved:forked")?.detail).toContain("a git repository");
    expect(parseDependencySpec("x", "workspace:*")).toMatchObject({ ok: false });
    expect(parseDependencySpec("x", "npm:@scope/y@2")).toEqual({ ok: true, name: "@scope/y", range: "2" });
  });

  test("an optional dependency for another platform is skipped", async () => {
    const registry = new FixtureRegistry().add("fsevents", [{ version: "2.3.3", os: ["darwin"] }]);
    const r = await run({
      registry,
      project: project({ dependencies: [{ name: "fsevents", range: "^2", kind: "optional" }] }),
    });
    expect(r.packages).toEqual([]);
    expect(r.unresolved).toEqual([]);
  });
});

describe("native modules", () => {
  const lock = (over: Partial<LockedPackage>[]): ProjectInfo =>
    project({
      dependencies: [{ name: "better-sqlite3", range: "^12", kind: "prod" }],
      lockfile: { kind: "npm", path: "/app/package-lock.json" },
      locked: over.map((o) => ({ name: "x", version: "1.0.0", ...o })),
    });

  test("prebuilt binaries narrow the set, and a source fallback is a warning", async () => {
    const r = await run({
      project: lock([{ name: "better-sqlite3", version: "12.4.1", hasInstallScript: true, engines: { node: ">=18" } }]),
      env: env("18.20.4"),
      verdicts: { "better-sqlite3": prebuiltFor([115, 127]) },
    });
    expect(r.packages[0]?.supported.toString()).toBe("20, 22");
    expect(r.recommended?.version).toBe("22.21.1");
    expect(ids(r)).toContain("current-unsupported");
    const f = finding(r, "compiles:better-sqlite3");
    expect(f?.severity).toBe("warning");
    expect(f?.title).toBe("npm will compile better-sqlite3 with node-gyp on Node 18.20");
    expect(f?.detail).toContain("Prebuilt binaries exist for Node 20, 22");
    expect(f?.fix).toMatchObject({ kind: "use-node", version: "22" });
  });

  test("a source-only package does not empty the set", async () => {
    const r = await run({
      project: lock([{ name: "bcrypt", version: "5.1.1", hasInstallScript: true }]),
      verdicts: {
        bcrypt: () => ({
          kind: "source-only",
          prebuilt: "all",
          fallsBackToSource: true,
          detail: "binding.gyp and no prebuilds",
        }),
      },
    });
    expect(r.supported.toString()).toBe("any");
    expect(finding(r, "source-build:bcrypt")?.severity).toBe("warning");
    expect(finding(r, "source-build:bcrypt")?.detail).toContain("Visual Studio Build Tools");
  });

  test("prebuilds only for releases its engines exclude count as a source build", async () => {
    const r = await run({
      project: lock([{ name: "old", version: "1.0.0", hasInstallScript: true, engines: { node: ">=20" } }]),
      verdicts: { old: prebuiltFor([93]) },
    });
    expect(r.supported.toString()).toBe("20–24");
    expect(ids(r)).toContain("source-build:old");
  });

  test("no binary for the platform is its own error, not a conflict", async () => {
    const r = await run({
      project: lock([
        { name: "winless", version: "1.0.0", hasInstallScript: true },
        { name: "a", version: "1.0.0", engines: { node: ">=22" } },
      ]),
      verdicts: { winless: prebuiltFor([], false) },
    });
    expect(finding(r, "no-binary:winless")?.severity).toBe("error");
    expect(r.supported.toString()).toBe("22–24");
    expect(r.conflicts).toEqual([]);
  });

  test("a parent of os/cpu-specific packages is checked as native", async () => {
    const seen: string[] = [];
    const r = await analyzeWith(
      {
        project: lock([
          {
            name: "esbuild",
            version: "0.25.0",
            dependencies: { "@esbuild/win32-x64": "0.25.0", "@esbuild/linux-x64": "0.25.0" },
          },
          { name: "@esbuild/win32-x64", version: "0.25.0", os: ["win32"], cpu: ["x64"], optional: true },
          { name: "@esbuild/linux-x64", version: "0.25.0", os: ["linux"], cpu: ["x64"], optional: true },
        ]),
        env: env("22.21.1"),
        index,
        registry: new FixtureRegistry(),
        http: offline,
        platform: { os: "win32", arch: "x64" },
        native: async (meta) => {
          seen.push(meta.name);
          return {
            kind: "platform-packages",
            prebuilt: "all",
            fallsBackToSource: false,
            detail: "per-platform packages",
          };
        },
      },
      hooks,
    );
    // The binary package itself is screened too; the Linux one never is.
    expect(seen.sort()).toEqual(["@esbuild/win32-x64", "esbuild"]);
    // npm never installs the Linux binary on Windows, so it cannot clash.
    expect(r.packages.map((p) => p.name).sort()).toEqual(["@esbuild/win32-x64", "esbuild"]);
  });
});

describe("conflicts and chains", () => {
  test("disjoint packages are named with their ranges", async () => {
    const r = await run({
      project: project({
        dependencies: [
          { name: "legacy", range: "*", kind: "prod" },
          { name: "modern", range: "*", kind: "prod" },
          { name: "free", range: "*", kind: "prod" },
        ],
        lockfile: { kind: "npm", path: "/app/package-lock.json" },
        locked: [
          { name: "legacy", version: "1.0.0", engines: { node: "<17" } },
          { name: "modern", version: "2.0.0", engines: { node: ">=20.9" } },
          { name: "free", version: "3.0.0" },
        ],
      }),
    });
    expect(r.supported.isEmpty()).toBe(true);
    expect(r.recommended).toBeUndefined();
    expect(r.conflicts).toEqual([
      {
        a: { name: "legacy", version: "1.0.0", supported: "16" },
        b: { name: "modern", version: "2.0.0", supported: "20.9+, 21–24" },
      },
    ]);
    const f = finding(r, "conflict");
    expect(f?.detail).toContain("legacy 1.0.0 supports Node up to 16.20.2");
    expect(f?.detail).toContain("modern 2.0.0 needs at least Node 20.9.0");
    expect(f?.packages).toEqual(["legacy", "modern"]);
    // An empty set has nothing to compare the current Node against.
    expect(ids(r)).not.toContain("current-unsupported");
  });

  test("transitive packages carry the shortest chain from a direct dependency", async () => {
    const p = project({
      dependencies: [{ name: "sqlite3", range: "^5", kind: "prod" }],
      lockfile: { kind: "npm", path: "/app/package-lock.json" },
      locked: [
        { name: "sqlite3", version: "5.1.7", dependencies: { "node-gyp": "^8", tar: "^6" } },
        { name: "node-gyp", version: "8.4.1", dependencies: { tar: "^6" }, engines: { node: ">= 10.12.0" } },
        { name: "tar", version: "6.2.1", path: "node_modules/tar", engines: { node: ">=22" } },
      ],
    });
    expect(viaChains(p).get("tar")).toEqual(["sqlite3"]);
    expect(viaChains(p).get("node-gyp")).toEqual(["sqlite3"]);

    const r = await run({ project: p, env: env("20.19.5") });
    expect(r.packages.find((x) => x.name === "tar")?.via).toEqual(["sqlite3"]);
    expect(r.packages.find((x) => x.name === "sqlite3")?.direct).toBe(true);
    expect(finding(r, "current-unsupported")?.packages).toEqual(["sqlite3", "tar"]);
  });

  test("dev-only packages are left out with includeDev false", async () => {
    const p = project({
      dependencies: [{ name: "vite", range: "^7", kind: "dev" }],
      lockfile: { kind: "npm", path: "/app/package-lock.json" },
      locked: [{ name: "vite", version: "7.1.0", dev: true, engines: { node: "^20.19.0 || >=22.12.0" } }],
    });
    expect((await run({ project: p })).supported.toString()).toBe("20.19.5+, 22.21.1+, 23–24");
    expect((await run({ project: p, includeDev: false })).supported.toString()).toBe("any");
  });

  test("lockfiles without engines are completed from the registry", async () => {
    const registry = new FixtureRegistry().add("needs22", [{ version: "1.0.0", engines: { node: ">=22" } }]);
    const r = await run({
      registry,
      project: project({
        dependencies: [{ name: "needs22", range: "^1", kind: "prod" }],
        lockfile: { kind: "pnpm", path: "/app/pnpm-lock.yaml" },
        locked: [
          { name: "needs22", version: "1.0.0" },
          { name: "private-thing", version: "1.0.0" },
        ],
      }),
    });
    expect(r.supported.toString()).toBe("22–24");
    expect(finding(r, "unresolved-locked")?.title).toBe("1 locked package could not be looked up");
  });
});

describe("pins and the environment", () => {
  const pinned = (value: string, extra: Partial<ProjectInfo> = {}) =>
    project({
      dependencies: [{ name: "a", range: "*", kind: "prod" }],
      lockfile: { kind: "npm", path: "/app/package-lock.json" },
      locked: [{ name: "a", version: "1.0.0", engines: { node: ">=20" } }],
      pins: [{ source: ".nvmrc", file: "/app/.nvmrc", value, exact: true }],
      ...extra,
    });

  test("a pin outside the supported set is an error with a pin fix", async () => {
    const r = await run({ project: pinned("18"), env: env("18.20.4") });
    const f = finding(r, "pin-unsupported:.nvmrc");
    expect(f?.severity).toBe("error");
    expect(f?.title).toBe(".nvmrc asks for Node 18, which does not fit this project");
    expect(f?.fix).toEqual({ kind: "pin-node", version: "24" });
  });

  test("a pin that does not fit is not also offered as the Node to switch to", async () => {
    // The shell runs a fitting Node; only the pin is wrong.
    const r = await run({ project: pinned("16"), env: env("24.11.0") });
    expect(finding(r, "pin-unsupported:.nvmrc")?.fix).toEqual({ kind: "pin-node", version: "24" });
    expect(finding(r, "pin-mismatch:.nvmrc")).toBeUndefined();
  });

  test("a shell on another major than the pin is a warning", async () => {
    const r = await run({ project: pinned("22"), env: env("20.19.5") });
    const f = finding(r, "pin-mismatch:.nvmrc");
    expect(f?.title).toBe("This shell runs Node 20.19 but .nvmrc asks for 22");
    expect(f?.fix).toEqual({ kind: "use-node", version: "22", command: "fnm use 22" });
    expect(r.findings.filter((x) => x.severity === "error")).toEqual([]);
  });

  test("no exact pin suggests one; a project engines range excluding the recommendation warns", async () => {
    const r = await run({
      project: pinned("x", { pins: [{ source: "engines", file: "/app/package.json", value: "<22", exact: false }] }),
    });
    expect(finding(r, "no-pin")?.fix).toEqual({ kind: "pin-node", version: "24" });
    expect(finding(r, "engines-excludes-recommended:engines")?.severity).toBe("warning");
  });

  test("all good means no errors or warnings", async () => {
    const r = await run({ project: pinned("24"), env: env("24.11.0") });
    expect(r.findings).toEqual([]);
  });

  test("no node on PATH and an end-of-life Node are warnings", async () => {
    expect(finding(await run({ env: env() }), "no-node")?.severity).toBe("warning");
    const eolIndex: NodeIndex = {
      ...index,
      releases: index.releases.map((r) => (r.major === 18 ? { ...r, eol: "2025-04-30" } : r)),
    };
    const r = await run({ index: eolIndex, env: env("18.20.4") });
    expect(finding(r, "eol")?.title).toBe("Node 18 is end-of-life");
    expect(finding(r, "eol")?.fix).toMatchObject({ kind: "use-node", version: "24" });
  });

  test("bun.lockb alone says how to make it readable", async () => {
    const r = await run({ project: project({ lockfile: { kind: "bun", path: "/app/bun.lockb" } }) });
    expect(finding(r, "bun-binary-lockfile")?.detail).toContain("bun install --save-text-lockfile");
  });
});

describe("check", () => {
  const registry = new FixtureRegistry()
    .add("sqlite", [
      { version: "11.0.0", hasInstallScript: true, engines: { node: ">=18" } },
      { version: "12.0.0", hasInstallScript: true, engines: { node: ">=20" } },
    ])
    .add("plain", [{ version: "1.0.0" }]);
  const opts = (version?: string) => ({
    env: env(version),
    index,
    registry,
    http: offline,
    platform: { os: "linux", arch: "x64", libc: "glibc" } as const,
    native: async (meta: VersionMeta): Promise<NativeVerdict> =>
      meta.name === "sqlite"
        ? prebuiltFor([108, 115, 127])(index)
        : { kind: "none", prebuilt: "all", fallsBackToSource: false, detail: "" },
  });

  test("specs split on the version's @, not a scope's", () => {
    expect(parseCheckSpec("@img/sharp@0.34")).toEqual({ name: "@img/sharp", range: "0.34" });
    expect(parseCheckSpec("sharp")).toEqual({ name: "sharp", range: "latest" });
  });

  test("verdicts against the current Node", async () => {
    expect((await checkPackage("sqlite@^11", opts("22.21.1"), hooks)).severity).toBe("ok");
    const old = await checkPackage("sqlite", opts("18.20.4"), hooks);
    expect(old.severity).toBe("error");
    expect(old.summary).toContain('engines.node is ">=20"');
    expect(old.suits?.version).toBe("22.21.1");
    const gap = await checkPackage("sqlite@11.0.0", opts("24.11.0"), hooks);
    expect(gap.severity).toBe("warning");
    expect(gap.summary).toContain("npm would compile it with node-gyp");
    expect((await checkPackage("nope", opts("22.21.1"), hooks)).severity).toBe("error");
  });
});

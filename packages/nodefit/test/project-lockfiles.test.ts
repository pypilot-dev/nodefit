import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readProject } from "../src/project/index";
import { parseBunLock } from "../src/project/lockfile/bun";
import { parseNpmLock } from "../src/project/lockfile/npm";
import { parsePnpmLock } from "../src/project/lockfile/pnpm";
import { parseYarnLock } from "../src/project/lockfile/yarn";
import type { LockedPackage, LockfileKind, PackageManager } from "../src/types";

const fixture = (name: string) => join(import.meta.dir, "fixtures", "projects", name);

const find = (locked: LockedPackage[], name: string, version?: string) =>
  locked.find((p) => p.name === name && (version === undefined || p.version === version));

/**
 * The lock-* fixtures are one project locked by each package manager
 * (generated, not hand-written): bufferutil (native, pulls node-gyp-build),
 * is-odd (nests is-number@6), react + use-sync-external-store (a peer),
 * a file: dependency on ./local (which needs ms), dev is-number@7 and
 * @types/semver, optional fsevents.
 */
const LOCKS: [string, LockfileKind, PackageManager][] = [
  ["lock-npm", "npm", "npm"],
  ["lock-npm-v1", "npm", "npm"],
  ["lock-bun", "bun", "bun"],
  ["lock-pnpm9", "pnpm", "pnpm"],
  ["lock-pnpm6", "pnpm", "pnpm"],
  ["lock-yarn-classic", "yarn-classic", "yarn"],
  ["lock-yarn-berry", "yarn-berry", "yarn"],
];

describe("every lockfile format yields the same packages", () => {
  for (const [dir, kind, manager] of LOCKS) {
    test(dir, async () => {
      const project = await readProject(fixture(dir));
      expect(project.lockfile?.kind).toBe(kind);
      expect(project.packageManager).toBe(manager);
      const { locked } = project;
      const keys = locked.map((p) => `${p.name}@${p.version}`);
      // Yarn berry also locks the node-gyp it injects for native packages.
      for (const key of [
        "@types/semver@7.7.0",
        "bufferutil@4.0.9",
        "fsevents@2.3.3",
        "is-number@6.0.0",
        "is-number@7.0.0",
        "is-odd@3.0.1",
        "left-pad@1.3.0",
        "ms@2.1.3",
        "node-gyp-build@4.8.4",
        "react@19.1.0",
        "use-sync-external-store@1.5.0",
      ]) {
        expect(keys).toContain(key);
      }
      if (kind !== "yarn-berry") expect(locked).toHaveLength(11);
      // Deduplicated, and the file: package itself is not a registry package.
      expect(new Set(keys).size).toBe(keys.length);
      expect(find(locked, "local")).toBeUndefined();

      expect(find(locked, "is-number", "7.0.0")?.dev).toBe(true);
      expect(find(locked, "@types/semver")?.dev).toBe(true);
      expect(find(locked, "is-number", "6.0.0")?.dev).toBeFalsy();
      expect(find(locked, "ms")?.dev).toBeFalsy();
      expect(find(locked, "node-gyp-build")?.dev).toBeFalsy();
      expect(find(locked, "fsevents")?.optional).toBe(true);
      expect(find(locked, "bufferutil")?.optional).toBeFalsy();
      expect(find(locked, "is-odd")?.dependencies?.["is-number"]).toMatch(/6\.0\.0$/);
    });
  }

  test("engines, os and install scripts, where the format records them", async () => {
    const npm = (await readProject(fixture("lock-npm"))).locked;
    expect(find(npm, "bufferutil")).toMatchObject({
      path: "node_modules/bufferutil",
      engines: { node: ">=6.14.2" },
      hasInstallScript: true,
    });
    expect(find(npm, "is-number", "6.0.0")?.path).toBe("node_modules/is-odd/node_modules/is-number");
    expect(find(npm, "fsevents")?.os).toEqual(["darwin"]);

    const pnpm6 = (await readProject(fixture("lock-pnpm6"))).locked;
    expect(find(pnpm6, "bufferutil")?.hasInstallScript).toBe(true);
    const pnpm9 = (await readProject(fixture("lock-pnpm9"))).locked;
    expect(find(pnpm9, "fsevents")).toMatchObject({
      os: ["darwin"],
      engines: { node: "^8.16.0 || ^10.6.0 || >=11.0.0" },
    });
    // The peer suffix in "use-sync-external-store@1.5.0(react@19.1.0)" is not part of the version.
    expect(find(pnpm9, "use-sync-external-store")?.dependencies).toEqual({ react: "19.1.0" });

    const bun = (await readProject(fixture("lock-bun"))).locked;
    expect(find(bun, "fsevents")?.os).toEqual(["darwin"]);
    expect(find(bun, "is-number", "6.0.0")?.path).toBe("node_modules/is-odd/node_modules/is-number");

    const berry = (await readProject(fixture("lock-yarn-berry"))).locked;
    expect(find(berry, "fsevents")).toMatchObject({ os: ["darwin"], hasInstallScript: true });
    expect(find(berry, "bufferutil")?.dependencies?.["node-gyp-build"]).toBe("^4.3.0");
    expect(find(berry, "left-pad")?.hasInstallScript).toBeUndefined();
  });
});

describe("workspaces", () => {
  for (const [dir, kind] of [
    ["ws-npm", "npm"],
    ["ws-bun", "bun"],
    ["ws-pnpm", "pnpm"],
    ["ws-yarn-berry", "yarn-berry"],
  ] as const) {
    test(dir, async () => {
      const project = await readProject(fixture(dir));
      expect(project.lockfile?.kind).toBe(kind);
      expect(project.workspaces).toEqual([fixture(join(dir, "packages", "a")), fixture(join(dir, "packages", "b"))]);
      const keys = project.locked.map((p) => `${p.name}@${p.version}`).sort();
      // Workspace packages (a, b) and the file: package are links, not registry packages.
      expect(keys).toEqual(["is-number@6.0.0", "is-number@7.0.0", "is-odd@3.0.1", "left-pad@1.3.0", "ms@2.1.3"]);
      // Needed by a workspace's production dependencies, so not dev.
      expect(find(project.locked, "is-number", "7.0.0")?.dev).toBeFalsy();
      expect(find(project.locked, "left-pad")?.dev).toBe(true);
    });
  }
});

describe("npm edge cases", () => {
  test("legacy engines arrays and strings become objects", () => {
    const locked = parseNpmLock(
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "root" },
          "node_modules/old": { version: "1.0.0", engines: ["node >= 0.8.0"] },
          "node_modules/older": { version: "1.0.0", engines: "node >=0.6" },
          "node_modules/any": { version: "1.0.0", engines: ["node"] },
        },
      }),
    );
    expect(find(locked, "old")?.engines).toEqual({ node: ">= 0.8.0" });
    expect(find(locked, "older")?.engines).toEqual({ node: ">=0.6" });
    expect(find(locked, "any")?.engines).toEqual({ node: "*" });
  });

  test("aliases, git, links and devOptional", () => {
    const locked = parseNpmLock(
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "node_modules/my-react": {
            name: "react",
            version: "18.3.1",
            resolved: "https://registry.npmjs.org/react/-/react-18.3.1.tgz",
          },
          "node_modules/from-git": { version: "1.0.0", resolved: "git+ssh://git@github.com/a/b.git#abc" },
          "node_modules/linked": { resolved: "packages/linked", link: true },
          "packages/linked": { version: "1.0.0" },
          "node_modules/both": { version: "2.0.0", devOptional: true },
          "node_modules/a/node_modules/both": { version: "2.0.0", dev: true },
        },
      }),
    );
    expect(locked.map((p) => p.name).sort()).toEqual(["both", "react"]);
    expect(find(locked, "react")?.path).toBe("node_modules/my-react");
    // One copy is needed outside dev, so the merged entry is not dev-only.
    expect(find(locked, "both")?.dev).toBe(false);
  });

  test("v1 aliases and git dependencies", () => {
    const locked = parseNpmLock(
      JSON.stringify({
        lockfileVersion: 1,
        dependencies: {
          "my-react": { version: "npm:react@18.3.1", resolved: "https://registry.npmjs.org/react/-/react-18.3.1.tgz" },
          "from-git": {
            version: "github:a/b#abc",
            requires: { ms: "^2.0.0" },
            dependencies: { ms: { version: "2.1.3", dev: true } },
          },
        },
      }),
    );
    expect(locked).toEqual([
      { name: "ms", version: "2.1.3", path: "node_modules/from-git/node_modules/ms", dev: true },
      { name: "react", version: "18.3.1", path: "node_modules/my-react" },
    ]);
  });

  test("a corrupt lockfile is reported with its path", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "nodefit-"));
    writeFileSync(join(dir, "package.json"), "{}");
    writeFileSync(join(dir, "package-lock.json"), "{ nope");
    expect(readProject(dir)).rejects.toThrow("package-lock.json");
  });
});

describe("bun edge cases", () => {
  test("git and workspace entries are skipped but their dependencies kept", () => {
    const locked = parseBunLock(`{
      "lockfileVersion": 1,
      "workspaces": { "": { "name": "root", "devDependencies": { "lib": "github:a/lib" } } },
      "packages": {
        "lib": ["lib@github:a/lib#abc123", { "dependencies": { "ms": "^2.1.0" } }, "a-lib-abc123"],
        "ms": ["ms@2.1.3", "", {}, "sha512-x"],
        "@s/pkg": ["@s/pkg@1.0.0", "", { "os": ["linux"], "cpu": ["x64"] }, "sha512-y"],
        "@s/pkg/ms": ["ms@2.0.0", "", {}, "sha512-z"],
      },
    }`);
    expect(locked.map((p) => `${p.name}@${p.version}`)).toEqual(["@s/pkg@1.0.0", "ms@2.0.0", "ms@2.1.3"]);
    expect(find(locked, "ms", "2.1.3")?.dev).toBe(true);
    expect(find(locked, "ms", "2.0.0")?.path).toBe("node_modules/@s/pkg/node_modules/ms");
    expect(find(locked, "@s/pkg")).toMatchObject({ os: ["linux"], cpu: ["x64"] });
    // Not reached from the project: the lockfile can't say whether it's dev.
    expect(find(locked, "@s/pkg")?.dev).toBeUndefined();
  });

  test("bun.lockb is recorded but can't be read", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "nodefit-"));
    writeFileSync(join(dir, "package.json"), '{ "dependencies": { "ms": "^2" } }');
    writeFileSync(join(dir, "bun.lockb"), new Uint8Array([0x23, 0x21, 0x2f, 0x00, 0xff]));
    const project = await readProject(dir);
    expect(project.lockfile).toEqual({ kind: "bun", path: join(dir, "bun.lockb") });
    expect(project.packageManager).toBe("bun");
    expect(project.locked).toEqual([]);
  });
});

describe("pnpm edge cases", () => {
  test("v5 keys", () => {
    const locked = parsePnpmLock(`lockfileVersion: 5.4
packages:
  /@babel/core/7.0.0_supports-color@8.0.0:
    resolution: {integrity: sha512-x}
    engines: {node: '>=6.9.0'}
    dev: true
  /ms/2.1.3:
    resolution: {integrity: sha512-y}
    dev: false
  github.com/a/b/abc:
    resolution: {tarball: https://codeload.github.com/a/b/tar.gz/abc}
    name: b
    version: 1.0.0
`);
    expect(locked).toEqual([
      { name: "@babel/core", version: "7.0.0", dev: true, engines: { node: ">=6.9.0" } },
      { name: "ms", version: "2.1.3", dev: false },
    ]);
  });

  test("v9 aliases resolve to the real package", () => {
    const locked = parsePnpmLock(`lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      my-ms:
        specifier: npm:ms@2.1.3
        version: ms@2.1.3
packages:
  ms@2.1.3:
    resolution: {integrity: sha512-y}
snapshots:
  ms@2.1.3: {}
`);
    expect(locked).toEqual([{ name: "ms", version: "2.1.3", dev: false, optional: false }]);
  });
});

describe("yarn edge cases", () => {
  test("classic: aliases, git and quoted names", () => {
    const locked = parseYarnLock(
      `# yarn lockfile v1


"@s/a@^1.0.0", "@s/a@^1.1.0":
  version "1.2.0"
  resolved "https://registry.yarnpkg.com/@s/a/-/a-1.2.0.tgz#abc"
  dependencies:
    "@s/b" "^2.0.0"
  optionalDependencies:
    fsevents "^2.3.3"

"@s/b@^2.0.0":
  version "2.0.1"
  resolved "https://registry.yarnpkg.com/@s/b/-/b-2.0.1.tgz#def"

"my-ms@npm:ms@^2.1.0":
  version "2.1.3"
  resolved "https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz#123"

"lib@github:a/lib":
  version "0.0.1"
  resolved "https://codeload.github.com/a/lib/tar.gz/abc"

fsevents@^2.3.3:
  version "2.3.3"
  resolved "https://registry.yarnpkg.com/fsevents/-/fsevents-2.3.3.tgz#456"
`,
      [
        { name: "@s/a", range: "^1.0.0", kind: "prod" },
        { name: "my-ms", range: "npm:ms@^2.1.0", kind: "dev" },
      ],
    );
    expect(locked.map((p) => `${p.name}@${p.version}`)).toEqual([
      "@s/a@1.2.0",
      "@s/b@2.0.1",
      "fsevents@2.3.3",
      "ms@2.1.3",
    ]);
    expect(find(locked, "@s/a")?.dependencies).toEqual({ "@s/b": "^2.0.0", fsevents: "^2.3.3" });
    expect(find(locked, "fsevents")?.optional).toBe(true);
    expect(find(locked, "ms")?.dev).toBe(true);
  });

  test("berry: patch, portal and aliased entries", () => {
    const locked = parseYarnLock(
      `__metadata:
  version: 8
  cacheKey: 10c0

"root@workspace:.":
  version: 0.0.0-use.local
  resolution: "root@workspace:."
  dependencies:
    resolve: "patch:resolve@npm%3A^1.22.0#~builtin<compat/resolve>"
    tool: "portal:./tool"
  languageName: unknown
  linkType: soft

"resolve@npm:^1.22.0":
  version: 1.22.8
  resolution: "resolve@npm:1.22.8"
  conditions: os=linux & cpu=x64
  languageName: node
  linkType: hard

"resolve@patch:resolve@npm%3A^1.22.0#~builtin<compat/resolve>":
  version: 1.22.8
  resolution: "resolve@patch:resolve@npm%3A1.22.8#~builtin<compat/resolve>::version=1.22.8&hash=c3c19d"
  languageName: node
  linkType: hard

"tool@portal:./tool::locator=root%40workspace%3A.":
  version: 0.0.0-use.local
  resolution: "tool@portal:./tool::locator=root%40workspace%3A."
  dependencies:
    my-ms: "npm:ms@^2.1.0"
  languageName: node
  linkType: soft

"my-ms@npm:ms@^2.1.0":
  version: 2.1.3
  resolution: "ms@npm:2.1.3"
  languageName: node
  linkType: hard
`,
      [
        { name: "resolve", range: "patch:resolve@npm%3A^1.22.0#~builtin<compat/resolve>", kind: "dev" },
        { name: "tool", range: "portal:./tool", kind: "prod" },
      ],
    );
    expect(locked).toEqual([
      { name: "ms", version: "2.1.3", dev: false, optional: false },
      { name: "resolve", version: "1.22.8", os: ["linux"], cpu: ["x64"], dev: true, optional: false },
    ]);
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { JsonCache } from "../src/cache";
import { createNativeAnalyzer, mayBeNative } from "../src/native";
import { listTarGz } from "../src/native/files";
import { installsOn, listAllows } from "../src/native/platforms";
import { readBundledBinaries } from "../src/native/prebuilds";
import { githubRepo } from "../src/native/remote";
import { classifyScript, installScript } from "../src/native/scripts";
import { FixtureRegistry } from "../src/registry/fixture";
import type { NativeContext } from "../src/types";
import { testIndex } from "./helpers";
import { ALPINE, fakeHttp, fixtureRegistry, LINUX, WIN } from "./native-fixtures";

const index = testIndex();

describe("install scripts", () => {
  test.each([
    ["prebuild-install -r napi || node-gyp rebuild", "prebuild-install"],
    ["node-pre-gyp install --fallback-to-build", "node-pre-gyp"],
    ["install-from-cache --artifact build/Release/re2.node || node-gyp -j max rebuild", "install-artifact"],
    ["cross-env ZERO_AR_DATE=1 node-gyp-build", "node-gyp-build"],
    ["node-gyp-build-optional-packages", "node-gyp-build"],
    ["node scripts/prebuild.js || node-gyp rebuild", "check-then-build"],
    ["node buildcheck.js > buildcheck.gypi && node-gyp rebuild", "compile"],
    ["cmake-js compile", "compile"],
    [`node -e "try{require('./postinstall')}catch(e){}"`, "harmless"],
    ["is-ci || husky install", "harmless"],
    ["patch-package", "harmless"],
    ["opencollective-postinstall || exit 0", "harmless"],
    ["husky && node-gyp rebuild", "compile"],
    ["node install.mjs", "custom"],
    ["", "none"],
  ])("%s → %s", (script, kind) => {
    expect(classifyScript(script).kind).toBe(kind as ReturnType<typeof classifyScript>["kind"]);
  });

  test("fallbacks: `||` after a downloader, --fallback-to-build for node-pre-gyp", () => {
    expect(classifyScript("prebuild-install || npm run build")).toMatchObject({ fallback: true });
    expect(classifyScript("prebuild-install")).toMatchObject({ fallback: false });
    expect(classifyScript("node-pre-gyp install --fallback-to-build")).toMatchObject({ fallback: true });
  });

  test("preinstall, install and postinstall run in order; a gypfile alone means node-gyp rebuild", () => {
    expect(installScript({ postinstall: "b", install: "a", test: "x" }, undefined)).toBe("a && b");
    expect(installScript({}, true)).toBe("node-gyp rebuild");
    expect(installScript(undefined, false)).toBe("");
  });
});

describe("npm's os/cpu/libc check", () => {
  test("lists, negations and libc", () => {
    expect(listAllows(["darwin"], "win32")).toBe(false);
    expect(listAllows(["!win32"], "linux")).toBe(true);
    expect(listAllows(["!win32"], "win32")).toBe(false);
    expect(listAllows(undefined, "win32")).toBe(true);
    expect(installsOn({ os: ["linux"], cpu: ["x64"], libc: ["musl"] }, ALPINE)).toBe(true);
    expect(installsOn({ os: ["linux"], cpu: ["x64"], libc: ["musl"] }, LINUX)).toBe(false);
    expect(installsOn({ libc: ["glibc"] }, WIN)).toBe(false);
  });
});

describe("bundled binary layouts", () => {
  const read = (files: string[], platform = WIN) => readBundledBinaries(files, platform, index);

  test("prebuildify tags: napi, abi, electron ignored, uv", () => {
    expect(read(["prebuilds/win32-x64/node.napi.node"]).prebuilt).toBe("all");
    const abi = read(["prebuilds/win32-x64/node.abi115.node", "prebuilds/win32-x64/electron.abi116.node"]);
    expect(abi.prebuilt === "all" ? "all" : abi.prebuilt?.toString()).toBe("20");
    expect(read(["prebuilds/win32-x64/node.napi.uv1.node"]).prebuilt).toBe("all");
    expect(read(["prebuilds/win32-x64/electron.napi.node"]).prebuilt).toBeUndefined();
    expect(read(["prebuilds/win32-x64/x.node", "binding.gyp"]).hasBindingGyp).toBe(true);
  });

  test("musl binaries never stand in for glibc, nor the reverse", () => {
    const files = ["prebuilds/linux-x64/x.musl.node"];
    expect(read(files, LINUX).prebuilt).toBeUndefined();
    expect(read(files, ALPINE).prebuilt).toBe("all");
    expect(read(["prebuilds/linux-x64/x.node"], ALPINE).prebuilt).toBe("all");
  });

  test("other layouts: platform words, Node majors in the path", () => {
    expect(read(["lib/binding/win32-x64/addon.node"]).prebuilt).toBe("all");
    expect(read(["lib/binding/linux-arm64/addon.node"]).prebuilt).toBeUndefined();
    const majors = read(["bin/win32-x64-node-20/a.node", "bin/win32-x64-node-22/a.node"]).prebuilt;
    expect(majors === "all" ? "all" : majors?.toString()).toBe("20, 22");
    expect(read(["test/fixture.js"]).hasBinaries).toBe(false);
  });
});

describe("tarball listing", () => {
  test("ustar names, prefixes, pax and GNU long names, package/ stripped", () => {
    const longName = `package/${"d/".repeat(60)}x.node`;
    const tgz = tgzOf([
      { name: "package/package.json" },
      { name: "package/prebuilds/win32-x64/a.node" },
      { name: "PaxHeader", type: "x", body: paxRecord("path", longName) },
      { name: "ignored-short-name" },
      { name: "././@LongLink", type: "L", body: `package/${"e/".repeat(60)}y.node\0` },
      { name: "ignored-too" },
      { name: "package/dir", type: "5" },
    ]);
    expect(listTarGz(tgz)).toEqual([
      "package.json",
      "prebuilds/win32-x64/a.node",
      `${"d/".repeat(60)}x.node`,
      `${"e/".repeat(60)}y.node`,
    ]);
  });

  test("the analyzer lists the tarball when jsDelivr can't", async () => {
    const registry = new FixtureRegistry().add("tiny-native", [
      {
        version: "1.0.0",
        hasInstallScript: true,
        dist: { tarball: "https://registry.example/tiny-native-1.0.0.tgz", unpackedSize: 4096 },
      },
    ]);
    registry.addFull({
      name: "tiny-native",
      version: "1.0.0",
      scripts: { install: "node-gyp-build" },
      dist: { tarball: "https://registry.example/tiny-native-1.0.0.tgz", unpackedSize: 4096 },
    });
    const tgz = tgzOf([{ name: "package/binding.gyp" }, { name: "package/prebuilds/win32-x64/node.abi127.node" }]);
    const analyzer = createNativeAnalyzer({ cache: false, fetchBytes: async () => tgz });
    const ctx: NativeContext = { registry, index, platform: WIN, http: fakeHttp({ json: {} }) };
    const meta = (await registry.packument("tiny-native")).versions["1.0.0"];
    if (!meta) throw new Error("fixture");
    const v = await analyzer.analyze(meta, ctx);
    expect(v.kind).toBe("bundled-prebuilds");
    expect(v.prebuilt === "all" ? "all" : v.prebuilt.toString()).toBe("22");
    expect(v.fallsBackToSource).toBe(true);
  });
});

describe("repository URLs", () => {
  test.each([
    ["git+https://github.com/TryGhost/node-sqlite3.git", "TryGhost/node-sqlite3"],
    ["git://github.com/WiseLibs/better-sqlite3.git", "WiseLibs/better-sqlite3"],
    ["git+ssh://git@github.com/kriszyp/msgpackr-extract.git", "kriszyp/msgpackr-extract"],
    ["https://github.com/node.js/node.bcrypt.js", "node.js/node.bcrypt.js"],
    ["github:uhop/node-re2", "uhop/node-re2"],
    ["uhop/node-re2", "uhop/node-re2"],
  ])("%s", (url, expected) => {
    const repo = githubRepo({ type: "git", url });
    expect(repo && `${repo.owner}/${repo.repo}`).toBe(expected);
  });

  test("not GitHub", () => {
    expect(githubRepo("https://gitlab.com/a/b.git")).toBeUndefined();
  });
});

describe("mayBeNative", () => {
  test("screens without the network", () => {
    expect(mayBeNative({ name: "lodash", version: "1.0.0", dependencies: { "lodash.get": "1" } })).toBe(false);
    expect(mayBeNative({ name: "x", version: "1.0.0", hasInstallScript: true })).toBe(true);
    expect(mayBeNative({ name: "x", version: "1.0.0", dependencies: { "node-addon-api": "8" } })).toBe(true);
    expect(mayBeNative({ name: "x", version: "1.0.0", optionalDependencies: { "x-win32-x64": "1" } })).toBe(true);
    // An optional dependency that is not a platform build is no hint.
    expect(mayBeNative({ name: "x", version: "1.0.0", optionalDependencies: { chokidar: "4" } })).toBe(false);
  });
});

describe("verdict cache", () => {
  test("a verdict is stored per version, platform and index, and reused offline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nodefit-native-"));
    try {
      const cache = new JsonCache(dir);
      const registry = fixtureRegistry();
      const meta = (await registry.packument("better-sqlite3")).versions["12.4.1"];
      if (!meta) throw new Error("fixture");
      const live: NativeContext = { registry, index, platform: WIN, http: fakeHttp() };
      const first = await createNativeAnalyzer({ cache }).analyze(meta, live);

      const offline = fakeHttp({ down: () => true });
      const ctx: NativeContext = { ...live, http: offline };
      const again = await createNativeAnalyzer({ cache }).analyze(meta, ctx);
      expect(again.kind).toBe(first.kind);
      expect(again.detail).toBe(first.detail);
      expect(again.prebuilt === "all" ? "all" : again.prebuilt.toString()).toBe(
        first.prebuilt === "all" ? "all" : first.prebuilt.toString(),
      );
      expect(offline.calls).toEqual([]);

      // Another platform is another question.
      const other = await createNativeAnalyzer({ cache }).analyze(meta, { ...ctx, platform: LINUX });
      expect(other.kind).toBe("unknown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("lookup failures are not stored", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nodefit-native-"));
    try {
      const cache = new JsonCache(dir);
      const registry = fixtureRegistry();
      const meta = (await registry.packument("keytar")).versions["7.9.0"];
      if (!meta) throw new Error("fixture");
      const down: NativeContext = { registry, index, platform: WIN, http: fakeHttp({ down: () => true }) };
      expect((await createNativeAnalyzer({ cache }).analyze(meta, down)).kind).toBe("unknown");
      const up: NativeContext = { ...down, http: fakeHttp() };
      expect((await createNativeAnalyzer({ cache }).analyze(meta, up)).kind).toBe("prebuild-install");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --------------------------------------------------------------------------
// A minimal tar writer, enough to exercise the reader.

interface Entry {
  name: string;
  type?: string;
  body?: string;
}

function tgzOf(entries: Entry[]): Uint8Array {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.body ?? "");
    const header = Buffer.alloc(512);
    header.write(e.name.slice(0, 100), 0, "utf8");
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
    header.write(e.type ?? "0", 156, "ascii");
    header.write("ustar\0", 257, "ascii");
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function paxRecord(key: string, value: string): string {
  const content = ` ${key}=${value}\n`;
  let len = content.length + 1;
  while (`${len}${content}`.length !== len) len = `${len}${content}`.length;
  return `${len}${content}`;
}

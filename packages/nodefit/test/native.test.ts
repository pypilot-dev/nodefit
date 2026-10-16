import { describe, expect, test } from "bun:test";
import type { NativeVerdict, NodeVersionSet } from "../src/types";
import { ALPINE, fakeHttp, fixtureRegistry, LINUX, MAC_ARM, RECORDED_ASSETS, setup, WIN } from "./native-fixtures";

function versions(v: NativeVerdict): string {
  return v.prebuilt === "all" ? "all" : v.prebuilt.toString();
}

function majors(set: NodeVersionSet | "all"): number[] {
  if (set === "all") throw new Error("expected a set");
  return [...new Set(set.releases().map((r) => r.major))].sort((a, b) => a - b);
}

describe("platform-packages", () => {
  test("sharp: the win32-x64 package, Node-API, narrowed only by its own engines", async () => {
    const v = await setup(WIN).run("sharp", "0.35.5");
    expect(v.kind).toBe("platform-packages");
    expect(versions(v)).toBe("20.9+, 21–24");
    expect(v.fallsBackToSource).toBe(false);
    expect(v.evidence).toEqual(["@img/sharp-win32-x64@0.35.5"]);
    expect(v.detail).toContain("@img/sharp-win32-x64");
  });

  test("sharp on win32-ia32: that build requires ^20.9.0, narrower than sharp's own engines", async () => {
    const v = await setup({ os: "win32", arch: "ia32" }).run("sharp", "0.35.5");
    expect(versions(v)).toBe("20.9+");
    expect(v.detail).toContain("@img/sharp-win32-ia32 requires Node ^20.9.0");
  });

  test("glibc and musl pick different packages; libc comes from the name or the full document", async () => {
    const glibc = await setup(LINUX).run("sharp", "0.35.5");
    expect(glibc.evidence).toEqual(["@img/sharp-linux-x64@0.35.5", "@img/sharp-libvips-linux-x64@1.3.4"]);
    const musl = await setup(ALPINE).run("sharp", "0.35.5");
    expect(musl.evidence).toEqual(["@img/sharp-linuxmusl-x64@0.35.5", "@img/sharp-libvips-linuxmusl-x64@1.3.4"]);
    const swc = await setup(ALPINE).run("@swc/core", "1.16.18");
    expect(swc.evidence).toEqual(["@swc/core-linux-x64-musl@1.16.18"]);
    expect(swc.prebuilt).toBe("all");
  });

  test("esbuild's Go binary works on any Node its package allows", async () => {
    const v = await setup(WIN).run("esbuild", "0.28.2");
    expect(v.kind).toBe("platform-packages");
    expect(v.evidence).toEqual(["@esbuild/win32-x64@0.28.2"]);
    expect(v.fallsBackToSource).toBe(false);
  });

  test("no package for this architecture: empty, and no compile fallback for napi-rs builds", async () => {
    const v = await setup({ os: "linux", arch: "riscv64", libc: "glibc" }).run("@swc/core", "1.16.18");
    expect(v.kind).toBe("platform-packages");
    expect(versions(v)).toBe("none");
    expect(v.fallsBackToSource).toBe(false);
    expect(v.detail).toContain("none for linux-riscv64");
  });

  test("msgpackr-extract compiles with node-gyp-build-optional-packages when no package fits", async () => {
    const fits = await setup(WIN).run("msgpackr-extract", "3.0.4");
    expect(fits.evidence).toEqual(["@msgpackr-extract/msgpackr-extract-win32-x64@3.0.4"]);
    const none = await setup({ os: "linux", arch: "riscv64", libc: "glibc" }).run("msgpackr-extract", "3.0.4");
    expect(versions(none)).toBe("none");
    expect(none.fallsBackToSource).toBe(true);
    expect(none.detail).toContain("python3, make and g++");
  });

  test("only packuments whose names fit the platform are fetched", async () => {
    const s = setup(WIN);
    const seen: string[] = [];
    const packument = s.registry.packument.bind(s.registry);
    s.registry.packument = (name) => {
      seen.push(name);
      return packument(name);
    };
    await s.run("sharp", "0.35.5");
    expect(seen.sort()).toEqual(["@img/sharp-win32-x64", "sharp"]);
  });
});

describe("bundled-prebuilds", () => {
  test("prebuildify Node-API binaries: any Node, compiles elsewhere (bcrypt 6)", async () => {
    const v = await setup(WIN).run("bcrypt", "6.0.0");
    expect(v.kind).toBe("bundled-prebuilds");
    expect(v.prebuilt).toBe("all");
    expect(v.fallsBackToSource).toBe(true);
    expect(v.evidence).toEqual(["prebuilds/win32-x64/bcrypt.node"]);
    const musl = await setup(ALPINE).run("bcrypt", "6.0.0");
    expect(musl.evidence).toEqual(["prebuilds/linux-x64/bcrypt.musl.node"]);
  });

  test("node-gyp-build calls Windows 'glibc', so argon2's win32 glibc build loads", async () => {
    const v = await setup(WIN).run("argon2", "0.45.1");
    expect(v.prebuilt).toBe("all");
    expect(v.evidence).toEqual(["prebuilds/win32-x64/argon2.glibc.node"]);
  });

  test("no binary for this platform: empty, compiled from binding.gyp", async () => {
    const v = await setup({ os: "darwin", arch: "x64" }).run("argon2", "0.45.1");
    expect(versions(v)).toBe("none");
    expect(v.fallsBackToSource).toBe(true);
    expect(v.detail).toContain("Xcode Command Line Tools");
    expect(v.detail).toContain("darwin-arm64");
  });

  test("ABI-tagged binaries narrow to those Node lines (isolated-vm)", async () => {
    const v = await setup(WIN).run("isolated-vm", "7.0.1");
    expect(majors(v.prebuilt)).toEqual([24]);
    expect(v.fallsBackToSource).toBe(true);
    expect(v.detail).toContain("only for Node 24");
  });

  test("multi-arch directories and armv tags (classic-level)", async () => {
    expect((await setup(MAC_ARM).run("classic-level", "3.0.0")).prebuilt).toBe("all");
    const arm64 = await setup({ os: "linux", arch: "arm64", libc: "glibc" }).run("classic-level", "3.0.0");
    expect(arm64.evidence).toEqual(["prebuilds/linux-arm64/classic-level.armv8.node"]);
    const winArm = await setup({ os: "win32", arch: "arm64" }).run("classic-level", "3.0.0");
    expect(versions(winArm)).toBe("none");
  });

  test("binaries with no install script load at runtime; a missing one can't compile (better-sqlite3 13)", async () => {
    const v = await setup(WIN).run("better-sqlite3", "13.0.3");
    expect(v.kind).toBe("bundled-prebuilds");
    expect(v.prebuilt).toBe("all");
    expect(v.fallsBackToSource).toBe(false);
    expect((await setup(ALPINE).run("better-sqlite3", "13.0.3")).evidence).toEqual(["prebuilds/linuxmusl-x64.node"]);
    const bsd = await setup({ os: "freebsd", arch: "x64" }).run("better-sqlite3", "13.0.3");
    expect(versions(bsd)).toBe("none");
    expect(bsd.fallsBackToSource).toBe(false);
  });

  test("other layouts by path words: farmhash's build/, deasync's per-major bin/", async () => {
    const farm = await setup(ALPINE).run("farmhash", "5.0.1");
    expect(farm.evidence).toEqual(["build/farmhash-linuxmusl-x64.node"]);
    const deasync = await setup(WIN).run("deasync", "0.1.32");
    expect(deasync.kind).toBe("bundled-prebuilds");
    expect(majors(deasync.prebuilt)).toEqual([16, 18, 20, 21, 22, 24]);
    expect(deasync.fallsBackToSource).toBe(true);
  });

  test("`check || node-gyp rebuild` with no binary for the platform compiles (node-pty on Linux)", async () => {
    expect((await setup(WIN).run("node-pty", "1.1.0")).prebuilt).toBe("all");
    const linux = await setup(LINUX).run("node-pty", "1.1.0");
    expect(versions(linux)).toBe("none");
    expect(linux.fallsBackToSource).toBe(true);
  });
});

describe("prebuild-install", () => {
  test("ABI assets on GitHub releases, probed per Node line that engines allows (better-sqlite3 12)", async () => {
    const s = setup(WIN);
    const v = await s.run("better-sqlite3", "12.4.1");
    expect(v.kind).toBe("prebuild-install");
    expect(majors(v.prebuilt)).toEqual([20, 22, 23, 24]);
    expect(v.fallsBackToSource).toBe(true);
    expect(v.detail).toContain("every Node version it supports");
    // engines is 20.x || 22.x || 23.x || 24.x: Node 16, 18 and 21 are not probed.
    expect(s.http.calls.filter((u) => u.startsWith("https://github.com"))).toHaveLength(4);
  });

  test("a missing line narrows and names the compile fallback", async () => {
    const assets = RECORDED_ASSETS.filter((u) => !u.includes("node-v131"));
    const v = await setup(WIN, fakeHttp({ exists: assets })).run("better-sqlite3", "12.4.1");
    expect(majors(v.prebuilt)).toEqual([20, 22, 24]);
    expect(v.detail).toContain("only for Node 20, 22, 24");
    expect(v.detail).toContain("Visual Studio Build Tools");
  });

  test("libxmljs2 publishes only Node 22 and 24", async () => {
    const v = await setup(WIN).run("libxmljs2", "0.37.0");
    expect(majors(v.prebuilt)).toEqual([22, 24]);
  });

  test("`-r napi` probes one asset per N-API level, musl as linuxmusl (sqlite3)", async () => {
    const s = setup(WIN);
    const v = await s.run("sqlite3", "6.0.1");
    expect(versions(v)).toBe("any");
    expect(s.http.calls.filter((u) => u.startsWith("https://github.com"))).toEqual([
      "https://github.com/TryGhost/node-sqlite3/releases/download/v6.0.1/sqlite3-v6.0.1-napi-v6-win32-x64.tar.gz",
    ]);
    expect(versions(await setup(ALPINE).run("sqlite3", "6.0.1"))).toBe("any");
    const arm = await setup({ os: "linux", arch: "arm64", libc: "glibc" }).run("sqlite3", "6.0.1");
    expect(versions(arm)).toBe("none");
    expect(arm.fallsBackToSource).toBe(true);
  });

  test("package.json config.runtime = napi counts like -r napi (keytar)", async () => {
    expect(versions(await setup(WIN).run("keytar", "7.9.0"))).toBe("any");
  });

  test("install-artifact-from-github (re2): bare version tag, <platform>-<arch>-<abi>.br", async () => {
    const v = await setup(WIN).run("re2", "1.27.0");
    expect(v.kind).toBe("prebuild-install");
    expect(majors(v.prebuilt)).toEqual([22, 24]);
    expect(v.detail).toContain("install-from-cache");
    expect(majors((await setup(ALPINE).run("re2", "1.27.0")).prebuilt)).toEqual([22, 24]);
  });
});

describe("node-pre-gyp", () => {
  test("binary.host templates with {node_abi} and {libc} (canvas 2)", async () => {
    const v = await setup(WIN).run("canvas", "2.11.2");
    expect(v.kind).toBe("node-pre-gyp");
    expect(majors(v.prebuilt)).toEqual([16, 18, 20, 21]);
    expect(v.fallsBackToSource).toBe(true);
    expect(v.evidence).toContain(
      "https://github.com/Automattic/node-canvas/releases/download/v2.11.2/canvas-v2.11.2-node-v93-win32-unknown-x64.tar.gz",
    );
  });

  test("napi_versions builds and libc (bcrypt 5)", async () => {
    expect(versions(await setup(WIN).run("bcrypt", "5.1.1"))).toBe("any");
    expect(versions(await setup(ALPINE).run("bcrypt", "5.1.1"))).toBe("any");
    const glibc = await setup(LINUX).run("bcrypt", "5.1.1");
    expect(versions(glibc)).toBe("none");
    expect(glibc.fallsBackToSource).toBe(true);
  });

  test("{libc_version} can't be known on Linux: unknown, not a guess (@discordjs/opus)", async () => {
    const linux = await setup(LINUX).run("@discordjs/opus", "0.10.0");
    expect(linux.kind).toBe("unknown");
    expect(linux.detail).toContain("glibc version");
    const win = await setup(WIN).run("@discordjs/opus", "0.10.0");
    expect(majors(win.prebuilt)).toEqual([22]);
  });
});

describe("source-only, unknown and none", () => {
  test("node-gyp rebuild with no prebuilt mechanism always compiles, and says what that needs", async () => {
    const win = await setup(WIN).run("cpu-features", "0.0.10");
    expect(win.kind).toBe("source-only");
    expect(versions(win)).toBe("none");
    expect(win.fallsBackToSource).toBe(true);
    expect(win.detail).toContain('"Desktop development with C++"');
    expect((await setup(MAC_ARM).run("cpu-features", "0.0.10")).detail).toContain("Xcode");
    expect((await setup(LINUX).run("cpu-features", "0.0.10")).detail).toContain("python3, make and g++");
  });

  test("an install script nodefit can't read is unknown but doesn't narrow", async () => {
    const v = await setup(WIN).run("puppeteer", "25.14.0");
    expect(v.kind).toBe("unknown");
    expect(v.prebuilt).toBe("all");
    expect(v.fallsBackToSource).toBe(false);
    expect(v.detail).toContain("node install.mjs");
  });

  test("known harmless install scripts and plain JavaScript are none", async () => {
    const coreJs = await setup(WIN).run("core-js", "3.50.0");
    expect(coreJs.kind).toBe("none");
    expect(coreJs.prebuilt).toBe("all");
    const s = setup(WIN);
    expect((await s.run("lodash", "4.18.1")).kind).toBe("none");
    expect(s.http.calls).toEqual([]);
  });

  test("a package for another OS is skipped by npm, without any lookup (fsevents)", async () => {
    const s = setup(WIN);
    const v = await s.run("fsevents", "2.3.3");
    expect(v.kind).toBe("none");
    expect(v.detail).toContain("only for darwin");
    expect(s.http.calls).toEqual([]);
  });
});

describe("lookup failures never throw", () => {
  test("jsDelivr unreachable and the tarball too big to fetch", async () => {
    const http = fakeHttp({ down: (u) => u.includes("jsdelivr") });
    const v = await setup(WIN, http).run("better-sqlite3", "13.0.3");
    expect(v.kind).toBe("unknown");
    expect(v.prebuilt).toBe("all");
    expect(v.detail).toContain("ENOTFOUND data.jsdelivr.com");
  });

  test("GitHub unreachable while probing release assets", async () => {
    const http = fakeHttp({ down: (u) => u.includes("github.com") });
    const v = await setup(WIN, http).run("sqlite3", "6.0.1");
    expect(v.kind).toBe("unknown");
    expect(v.detail).toContain("couldn't check sqlite3 6.0.1");
    expect(v.detail).toContain("may compile it from source");
  });

  test("full version document missing, and platform packages unpublished", async () => {
    const registry = fixtureRegistry();
    registry.add("ghost", [{ version: "1.0.0", hasInstallScript: true }]);
    registry.fullVersion = async () => {
      throw new Error("registry.npmjs.org timed out");
    };
    const s = setup(WIN, fakeHttp(), registry);
    const v = await s.run("ghost", "1.0.0");
    expect(v.kind).toBe("unknown");
    expect(v.detail).toContain("timed out");

    const orphans = fixtureRegistry().add("orphan", [
      { version: "1.0.0", optionalDependencies: { "orphan-win32-x64": "1.0.0", "orphan-linux-x64": "1.0.0" } },
    ]);
    const o = await setup(WIN, fakeHttp(), orphans).run("orphan", "1.0.0");
    expect(o.kind).toBe("unknown");
    expect(o.detail).toContain("orphan-win32-x64");
  });

  test("a failed lookup is retried, not remembered", async () => {
    let down = true;
    const http = fakeHttp({ down: (u) => down && u.includes("github.com") });
    const s = setup(WIN, http);
    expect((await s.run("keytar", "7.9.0")).kind).toBe("unknown");
    down = false;
    expect((await s.run("keytar", "7.9.0")).kind).toBe("prebuild-install");
  });
});

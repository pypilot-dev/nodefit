import { describe, expect, test } from "bun:test";
import { createNativeAnalyzer } from "../src/native";
import { FixtureRegistry } from "../src/registry/fixture";
import type { HttpClient, NativeContext, NodeIndex } from "../src/types";
import { testIndex } from "./helpers";

/**
 * node-sass downloads `<platform>-<arch>-<abi>_binding.node` itself
 * (scripts/install.js) and compiles when that fails. 4.14.1 has binaries for
 * Node 8–14 only: nothing on the recent lines, so the older ones are probed.
 * Metadata and asset names as recorded from the registry and GitHub on
 * 2026-10-16.
 */
const SITE = "https://github.com/sass/node-sass/releases/download";

function index(): NodeIndex {
  const base = testIndex();
  // The shared test index starts at Node 16; node-sass 4 stops at 14.
  base.releases.push({ version: "14.21.3", major: 14, abi: 83, napi: 8, lts: "Fermium", date: "2023-02-16" });
  return base;
}

function registry(): FixtureRegistry {
  const meta = {
    version: "4.14.1",
    engines: { node: ">=0.10.0" },
    hasInstallScript: true,
    dependencies: { "node-gyp": "^3.8.0", nan: "^2.13.2" },
  };
  return new FixtureRegistry().add("node-sass", [meta]).addFull({
    name: "node-sass",
    ...meta,
    gypfile: true,
    scripts: { install: "node scripts/install.js", postinstall: "node scripts/build.js" },
    nodeSassConfig: { binarySite: SITE },
  } as never);
}

function http(existing: string[]): HttpClient & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    getJson: async (url) => {
      throw new Error(`unexpected request: ${url}`);
    },
    getText: async (url) => {
      throw new Error(`unexpected request: ${url}`);
    },
    exists: async (url) => {
      asked.push(url);
      return existing.includes(url);
    },
  };
}

describe("node-sass", () => {
  test("binaries for old Node only are found by probing the older lines", async () => {
    const fake = http([`${SITE}/v4.14.1/win32-x64-83_binding.node`]);
    const ctx: NativeContext = {
      registry: registry(),
      index: index(),
      platform: { os: "win32", arch: "x64" },
      http: fake,
    };
    const meta = (await ctx.registry.packument("node-sass")).versions["4.14.1"];
    const v = await createNativeAnalyzer({ cache: false }).analyze(meta as never, ctx);

    expect(v.prebuilt === "all" ? "all" : v.prebuilt.toString()).toBe("14");
    expect(v.fallsBackToSource).toBe(true);
    expect(v.detail).toContain("via node-sass");
    // Recent lines first (none found), then the older ones.
    expect(fake.asked).toContain(`${SITE}/v4.14.1/win32-x64-137_binding.node`);
    expect(fake.asked).toContain(`${SITE}/v4.14.1/win32-x64-83_binding.node`);
  });

  test("Alpine binaries are named linux_musl", async () => {
    const fake = http([`${SITE}/v4.14.1/linux_musl-x64-83_binding.node`]);
    const ctx: NativeContext = {
      registry: registry(),
      index: index(),
      platform: { os: "linux", arch: "x64", libc: "musl" },
      http: fake,
    };
    const meta = (await ctx.registry.packument("node-sass")).versions["4.14.1"];
    const v = await createNativeAnalyzer({ cache: false }).analyze(meta as never, ctx);
    expect(v.prebuilt === "all" ? "all" : v.prebuilt.toString()).toBe("14");
  });
});

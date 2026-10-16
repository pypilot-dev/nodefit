import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createNativeAnalyzer } from "../src/native";
import { FixtureRegistry } from "../src/registry/fixture";
import type { HttpClient, NativeContext, NodeIndex, Packument, Platform, VersionMeta } from "../src/types";
import { NotFoundError } from "../src/types";
import { testIndex } from "./helpers";

/**
 * Recorded on 2026-10-16 from registry.npmjs.org (abbreviated packuments and
 * full version documents, trimmed to the fields native/ reads) and from
 * data.jsdelivr.com (file trees trimmed to binaries and binding.gyp).
 */
const DIR = join(import.meta.dir, "fixtures", "native");

function readJson<T>(...parts: string[]): T {
  return JSON.parse(readFileSync(join(DIR, ...parts), "utf8")) as T;
}

export function fixtureRegistry(): FixtureRegistry {
  const registry = new FixtureRegistry();
  for (const f of readdirSync(join(DIR, "packuments"))) registry.addPackument(readJson<Packument>("packuments", f));
  for (const f of readdirSync(join(DIR, "full"))) registry.addFull(readJson<VersionMeta>("full", f));
  return registry;
}

/** jsDelivr listing URL → recorded response. */
export function jsdelivrResponses(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of readdirSync(join(DIR, "jsdelivr"))) {
    const spec = f.replace(/\.json$/, "").replace("__", "/");
    out[`https://data.jsdelivr.com/v1/packages/npm/${spec}`] = readJson("jsdelivr", f);
  }
  return out;
}

export const RECORDED_ASSETS: string[] = readJson<{ exists: string[] }>("assets.json").exists;

export interface FakeHttp extends HttpClient {
  /** Every URL requested, in order. */
  calls: string[];
}

/**
 * An HttpClient that answers from fixtures: JSON by URL, `exists()` from a
 * set, and a network error for any URL `down` matches.
 */
export function fakeHttp(
  opts: { json?: Record<string, unknown>; exists?: Iterable<string>; down?: (url: string) => boolean } = {},
): FakeHttp {
  const json = opts.json ?? jsdelivrResponses();
  const exists = new Set(opts.exists ?? RECORDED_ASSETS);
  const calls: string[] = [];
  const check = (url: string) => {
    calls.push(url);
    if (opts.down?.(url)) throw new Error(`fetch failed: getaddrinfo ENOTFOUND ${new URL(url).host}`);
  };
  return {
    calls,
    async getJson<T>(url: string): Promise<T> {
      check(url);
      if (!(url in json)) throw new NotFoundError(url);
      return json[url] as T;
    },
    async getText(url: string): Promise<string> {
      check(url);
      throw new NotFoundError(url);
    },
    async exists(url: string): Promise<boolean> {
      check(url);
      return exists.has(url);
    },
  };
}

export const WIN: Platform = { os: "win32", arch: "x64" };
export const LINUX: Platform = { os: "linux", arch: "x64", libc: "glibc" };
export const ALPINE: Platform = { os: "linux", arch: "x64", libc: "musl" };
export const MAC_ARM: Platform = { os: "darwin", arch: "arm64" };

export interface Setup {
  ctx: NativeContext;
  http: FakeHttp;
  index: NodeIndex;
  registry: FixtureRegistry;
  /** Analyze a recorded package version (abbreviated metadata, as the analyzer gets it). */
  run(name: string, version: string): ReturnType<ReturnType<typeof createNativeAnalyzer>["analyze"]>;
}

export function setup(
  platform: Platform = WIN,
  http: FakeHttp = fakeHttp(),
  registry: FixtureRegistry = fixtureRegistry(),
): Setup {
  const index = testIndex();
  const ctx: NativeContext = { registry, index, platform, http };
  const analyzer = createNativeAnalyzer({
    cache: false,
    fetchBytes: async (url) => {
      throw new Error(`no network in tests: ${url}`);
    },
  });
  return {
    ctx,
    http,
    index,
    registry,
    async run(name, version) {
      const meta = (await registry.packument(name)).versions[version];
      if (!meta) throw new Error(`no fixture for ${name}@${version}`);
      return analyzer.analyze(meta, ctx);
    },
  };
}

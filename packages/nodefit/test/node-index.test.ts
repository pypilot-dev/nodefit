import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import snapshot from "../data/node-releases.json" with { type: "json" };
import { JsonCache } from "../src/cache";
import {
  findRelease,
  isEndOfLife,
  loadNodeIndex,
  ltsLines,
  NodeSet,
  napiVersion,
  resolveNodeSpec,
} from "../src/node/index";
import type { HttpClient, NodeIndex } from "../src/types";
import indexJson from "./fixtures/node/index.json" with { type: "json" };
import scheduleJson from "./fixtures/node/schedule.json" with { type: "json" };

const INDEX_URL = "https://nodejs.org/dist/index.json";
const SCHEDULE_URL = "https://raw.githubusercontent.com/nodejs/Release/main/schedule.json";

/** Answers from recorded responses; a URL mapped to an Error fails like a network error. */
function fakeHttp(responses: Record<string, unknown>): HttpClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getJson<T>(url: string): Promise<T> {
      calls.push(url);
      const body = responses[url];
      if (body === undefined || body instanceof Error) throw body ?? new Error(`unexpected ${url}`);
      return structuredClone(body) as T;
    },
    async getText(url: string): Promise<string> {
      throw new Error(`unexpected ${url}`);
    },
    async exists(url: string): Promise<boolean> {
      throw new Error(`unexpected ${url}`);
    },
  };
}

const online = () => fakeHttp({ [INDEX_URL]: indexJson, [SCHEDULE_URL]: scheduleJson });
const down = () => fakeHttp({ [INDEX_URL]: new Error("ECONNRESET"), [SCHEDULE_URL]: new Error("ECONNRESET") });

let dir: string;
let cache: JsonCache;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nodefit-node-"));
  cache = new JsonCache(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Backdate the cached index so it counts as stale. */
function age(days: number): void {
  const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  utimesSync(join(dir, "node-index.json"), when, when);
}

describe("loadNodeIndex", () => {
  test("parses index.json: final releases from Node 4 on, newest first", async () => {
    const index = await loadNodeIndex({ http: online(), cache });
    expect(index.source).toBe("network");
    const versions = index.releases.map((r) => r.version);
    expect(versions[0]).toBe("26.12.0");
    expect(versions.at(-1)).toBe("4.0.0");
    // 0.x lines and entries without `modules` are dropped.
    expect(versions).not.toContain("0.12.18");
    expect(versions).not.toContain("0.1.104");
    expect(findRelease(index, "v22.14.0")).toEqual({
      version: "22.14.0",
      major: 22,
      abi: 127,
      lts: "Jod",
      date: "2025-02-11",
      napi: 10,
      eol: "2027-04-30",
    });
    expect(findRelease(index, "26.12.0")?.lts).toBe(false);
  });

  test("N-API levels follow the version matrix, per line", async () => {
    const index = await loadNodeIndex({ http: online(), cache });
    const napi = (v: string) => findRelease(index, v)?.napi;
    expect(napi("22.13.1")).toBe(9);
    expect(napi("22.14.0")).toBe(10);
    expect(napi("23.5.0")).toBe(9);
    expect(napi("23.6.0")).toBe(10);
    expect(napi("20.2.0")).toBe(8);
    expect(napi("20.3.0")).toBe(9);
    expect(napi("18.16.1")).toBe(8);
    expect(napi("18.17.0")).toBe(9);
    expect(napi("16.20.2")).toBe(8);
    expect(napi("4.0.0")).toBeUndefined();
    // Lines newer than the matrix keep its highest version.
    expect(napi("26.12.0")).toBe(10);
    expect(NodeSet.fromNapi(index, 10).toString()).toBe("22.14+, 23.6+, 24–26");
  });

  test("napiVersion covers lines the matrix skips and pre-N-API releases", () => {
    expect(napiVersion("19.9.0")).toBe(8);
    expect(napiVersion("11.0.0")).toBe(3);
    expect(napiVersion("11.8.0")).toBe(4);
    expect(napiVersion("9.5.0")).toBe(2);
    expect(napiVersion("8.11.2")).toBe(3);
    expect(napiVersion("8.5.0")).toBeUndefined();
    expect(napiVersion("6.14.2")).toBe(3);
    expect(napiVersion("6.14.1")).toBeUndefined();
    expect(napiVersion("v99.0.0")).toBe(10);
  });

  test("the running Node agrees with the matrix", () => {
    expect(napiVersion(process.versions.node)).toBe(Number(process.versions.napi));
  });

  test("end-of-life dates come from the schedule", async () => {
    const index = await loadNodeIndex({ http: online(), cache });
    const r = (v: string) => {
      const release = findRelease(index, v);
      if (!release) throw new Error(`${v} missing from the index`);
      return release;
    };
    expect(r("18.17.0").eol).toBe("2025-04-30");
    expect(r("24.0.0").eol).toBe("2028-04-30");
    const today = new Date("2026-10-16T12:00:00Z");
    expect(isEndOfLife(r("18.17.0"), today)).toBe(true);
    expect(isEndOfLife(r("22.14.0"), today)).toBe(false);
    expect(isEndOfLife({ ...r("22.14.0"), eol: undefined }, today)).toBe(false);
  });

  test("a failed schedule still yields the index, with end-of-life dates from the snapshot", async () => {
    const http = fakeHttp({ [INDEX_URL]: indexJson, [SCHEDULE_URL]: new Error("HTTP 503") });
    const index = await loadNodeIndex({ http, cache });
    expect(index.source).toBe("network");
    expect(index.releases).toHaveLength(14);
    expect(findRelease(index, "20.3.0")?.eol).toBe("2026-04-30");
  });

  test("a fresh cache is used without touching the network", async () => {
    await loadNodeIndex({ http: online(), cache });
    const http = down();
    const index = await loadNodeIndex({ http, cache });
    expect(index.source).toBe("cache");
    expect(index.releases[0]?.version).toBe("26.12.0");
    expect(http.calls).toHaveLength(0);
  });

  test("a stale cache is refreshed from the network", async () => {
    await loadNodeIndex({ http: online(), cache });
    age(2);
    const http = online();
    expect((await loadNodeIndex({ http, cache })).source).toBe("network");
    expect(http.calls).toContain(INDEX_URL);
  });

  test("when the network fails, a stale cache beats an older snapshot", async () => {
    const first = await loadNodeIndex({ http: online(), cache });
    age(30);
    const index = await loadNodeIndex({ http: down(), cache });
    expect(index.source).toBe("cache");
    expect(index.fetchedAt).toBe(first.fetchedAt);
  });

  test("a cache older than the snapshot gives way to it", async () => {
    cache.set("node-index", {
      fetchedAt: "2020-01-01T00:00:00.000Z",
      releases: [["13.0.0", 79, false, "2019-10-22"]],
      eol: {},
    });
    age(2);
    const index = await loadNodeIndex({ http: down(), cache });
    expect(index.source).toBe("bundled");
  });

  test("without network or cache, the bundled snapshot", async () => {
    const index = await loadNodeIndex({ http: down(), cache });
    expect(index.source).toBe("bundled");
    expect(index.fetchedAt).toBe(snapshot.fetchedAt);
    expect(index.releases.length).toBeGreaterThan(500);
    expect(findRelease(index, "22.11.0")).toMatchObject({ abi: 127, lts: "Jod", napi: 9, eol: "2027-04-30" });
    expect(index.releases.every((r) => r.major >= 4)).toBe(true);
  });

  test("offline never touches the network", async () => {
    const http = online();
    expect((await loadNodeIndex({ http, offline: true, cache })).source).toBe("bundled");
    await loadNodeIndex({ http, cache });
    age(30);
    expect((await loadNodeIndex({ http: down(), offline: true, cache })).source).toBe("cache");
    expect(http.calls).toHaveLength(2);
  });

  test("a malformed cache is ignored", async () => {
    cache.set("node-index", [{ version: "v22.0.0" }]);
    const http = online();
    expect((await loadNodeIndex({ http, cache })).source).toBe("network");
  });
});

describe("resolveNodeSpec", () => {
  let index: NodeIndex;
  beforeEach(async () => {
    index = await loadNodeIndex({ http: online(), cache });
  });
  const resolve = (spec: string) => resolveNodeSpec(index, spec)?.version;

  test("partial and exact versions pick the newest match", () => {
    expect(resolve("22")).toBe("22.23.3");
    expect(resolve("v22")).toBe("22.23.3");
    expect(resolve("22.13")).toBe("22.13.1");
    expect(resolve("22.14.0")).toBe("22.14.0");
    expect(resolve("v20.2.0")).toBe("20.2.0");
    // "2" must not match 22 or 24 by prefix.
    expect(resolve("2")).toBeUndefined();
    expect(resolve("22.15")).toBeUndefined();
  });

  test("aliases for the newest release", () => {
    for (const alias of ["node", "latest", "current", "stable", "NODE"]) expect(resolve(alias)).toBe("26.12.0");
  });

  test("LTS aliases", () => {
    expect(resolve("lts/*")).toBe("24.22.0");
    expect(resolve("lts")).toBe("24.22.0");
    expect(resolve("lts/jod")).toBe("22.23.3");
    expect(resolve("lts/Hydrogen")).toBe("18.17.0");
    expect(resolve("lts/-1")).toBe("22.23.3");
    expect(resolve("lts/-2")).toBe("18.17.0");
    expect(resolve("lts/-9")).toBeUndefined();
    expect(resolve("lts/argon")).toBeUndefined();
    expect(ltsLines(index).map((r) => r.major)).toEqual([24, 22, 18, 16]);
  });

  test("semver ranges", () => {
    expect(resolve(">=20")).toBe("26.12.0");
    expect(resolve("^22")).toBe("22.23.3");
    expect(resolve("20.x")).toBe("20.3.0");
    expect(resolve(">=18 <20")).toBe("18.17.0");
    expect(resolve("^18.17.0 || ^20.3.0")).toBe("20.3.0");
    expect(resolve(">=30")).toBeUndefined();
  });

  test("whitespace and comments, as .nvmrc allows", () => {
    expect(resolve("  22\n")).toBe("22.23.3");
    expect(resolve("22 # pinned for sharp")).toBe("22.23.3");
    expect(resolve("lts/jod # LTS")).toBe("22.23.3");
  });

  test("what nodefit cannot resolve", () => {
    for (const spec of ["system", "iojs", "", "   ", "# only a comment", "banana", "lts/"]) {
      expect(resolve(spec)).toBeUndefined();
    }
  });
});

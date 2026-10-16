import { describe, expect, test } from "bun:test";
import { NodeSet } from "../src/node/set";
import { testIndex } from "./helpers";

const index = testIndex();

describe("NodeSet", () => {
  test("engines ranges follow npm's semver reading", () => {
    const set = NodeSet.fromRange(index, ">=20.9.0");
    expect(set.has("20.0.0")).toBe(false);
    expect(set.has("20.9.0")).toBe(true);
    expect(set.has("v24.11.0")).toBe(true);
    expect(NodeSet.fromRange(index, "^18.17.0 || >=20.5").has("18.0.0")).toBe(false);
  });

  test("an unparseable range constrains nothing, as npm treats it", () => {
    expect(NodeSet.fromRange(index, "not a range").size).toBe(index.releases.length);
  });

  test("ABI and N-API filters", () => {
    expect(NodeSet.fromAbis(index, [115, 127]).toString()).toBe("20, 22");
    expect(NodeSet.fromNapi(index, 10).toString()).toBe("22–24");
  });

  test("newest and newest LTS", () => {
    const set = NodeSet.fromRange(index, "<24");
    expect(set.newest()?.version).toBe("23.11.1");
    expect(set.newestLts()?.version).toBe("22.21.1");
  });

  test("toString summarises whole lines, runs and partial lines", () => {
    expect(NodeSet.all(index).toString()).toBe("any");
    expect(NodeSet.empty(index).toString()).toBe("none");
    expect(NodeSet.fromRange(index, ">=20.9.0").toString()).toBe("20.9+, 21–24");
    expect(NodeSet.fromRange(index, ">=18 <20.10").toString()).toBe("18, 20.0–20.9");
    expect(NodeSet.fromVersions(index, ["22.11.0"]).toString()).toBe("22.11.0");
  });

  test("intersect and union", () => {
    const a = NodeSet.fromRange(index, ">=20");
    const b = NodeSet.fromAbis(index, [108, 115]);
    expect(a.intersect(b).toString()).toBe("20");
    // The test index has no Node 17 or 19, so these lines are adjacent.
    expect(NodeSet.fromAbis(index, [93]).union(b).toString()).toBe("16–20");
  });
});

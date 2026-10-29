import { describe, expect, test } from "bun:test";
import { checkPackage } from "../src/analyze/check";
import { colorEnabled, colors } from "../src/cli/color";
import { formatCheck, formatDoctor } from "../src/cli/doctor";
import { toJson } from "../src/cli/json";
import { parseArgs } from "../src/cli/main";
import { FixtureRegistry } from "../src/registry/fixture";
import { hooks, index, offline, sampleReport } from "./analyze-fixture";

const plain = colors(false);

describe("doctor text", () => {
  test("sections, the verdict and the packages that narrow the set", async () => {
    const text = formatDoctor(await sampleReport(), plain, "2026-10-16");
    for (const line of [
      "nodefit doctor: /work/shop",
      "  platform         : linux-x64",
      "  package manager  : npm (package-lock.json, 4 packages)",
      "── Environment ──",
      "  node             : 18.20.4 (/usr/bin/node)",
      "  version managers : fnm",
      "── Project ──",
      "  dependencies     : 2 prod, 1 dev",
      "  node pins        : engines >=18",
      "  supported Node   : 20.19.5+, 22",
      "  recommended      : 22.21.1 (LTS Jod)",
      "[ERROR] Node 18.20 does not fit this project",
      "fix: fnm use 22",
      "[WARN ] npm will compile better-sqlite3 with node-gyp on Node 18.20",
    ]) {
      expect(text).toContain(line);
    }
    expect(text).toMatch(/• better-sqlite3 12\.4\.1 +20, 22 +prebuilt \(downloaded at install\)/);
    expect(text).toMatch(/• rollup 4\.50\.0 +20\.19\.5\+, 21–24 +engines >=20\.19\.0 · via vite · dev/);
    // express fits every maintained line, so it is summarised, not listed.
    expect(text).not.toContain("• express");
    expect(text).toContain("+ 2 packages not listed");
    expect(text).not.toContain("\x1b[");
  });

  test("a healthy project ends with a check mark", async () => {
    const text = formatDoctor(await sampleReport("22.21.1"), plain, "2026-10-16");
    expect(text).toContain("✓ Everything looks good. Node 22.21 fits every dependency.");
    expect(text).not.toContain("[ERROR]");
  });

  test("colour codes only when enabled", async () => {
    expect(formatDoctor(await sampleReport(), colors(true))).toContain("\x1b[31m");
    expect(colorEnabled({ isTTY: true }, { NO_COLOR: "1" })).toBe(false);
    expect(colorEnabled({ isTTY: true }, {})).toBe(true);
    expect(colorEnabled({ isTTY: false }, {})).toBe(false);
    expect(colorEnabled({ isTTY: false }, { FORCE_COLOR: "1" })).toBe(true);
  });
});

describe("json", () => {
  test("sets become a summary and a version list", async () => {
    const json = JSON.parse(toJson(await sampleReport()));
    expect(json.supported.summary).toBe("20.19.5+, 22");
    expect(json.supported.versions).toEqual(["22.21.1", "22.11.0", "22.0.0", "20.19.5"]);
    expect(json.packages[0].enginesSet.summary).toBeString();
    expect(json.findings[0].id).toBe("current-unsupported");
  });
});

describe("check text", () => {
  test("verdict line and package details", async () => {
    const registry = new FixtureRegistry().add("left-pad", [{ version: "1.3.0", engines: { node: ">=20" } }]);
    const outcome = await checkPackage(
      "left-pad",
      {
        env: { current: { version: "18.20.4", path: "/usr/bin/node" }, managers: [], installed: [] },
        index,
        registry,
        http: offline,
        platform: { os: "darwin", arch: "arm64" },
      },
      hooks,
    );
    const text = formatCheck(outcome, plain);
    expect(text).toContain("nodefit check: left-pad 1.3.0");
    expect(text).toContain("  engines.node     : >=20");
    expect(text).toContain(
      '[ERROR] left-pad 1.3.0 does not support this project\'s Node 18.20 (its engines.node is ">=20").',
    );
  });
});

describe("arguments", () => {
  test("commands, flags and positionals", () => {
    expect(parseArgs(["doctor", "--path", "app", "--json", "--prod"])).toMatchObject({
      command: "doctor",
      path: "app",
      json: true,
      prod: true,
    });
    expect(parseArgs(["check", "sharp@^0.34", "--path=x"])).toMatchObject({ positional: ["sharp@^0.34"], path: "x" });
    expect(parseArgs(["lsp", "--stdio"]).command).toBe("lsp");
    expect(() => parseArgs(["doctor", "--bogus"])).toThrow("unknown option --bogus");
  });
});

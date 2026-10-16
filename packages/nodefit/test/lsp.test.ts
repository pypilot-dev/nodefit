import { describe, expect, test } from "bun:test";
import { checkPackage } from "../src/analyze/check";
import { dependencyAt, reportToDiagnostics } from "../src/lsp/diagnostics";
import { checkToMarkdown, reportToMarkdown } from "../src/lsp/markdown";
import { codeActionsFor, pinFileName, readSettings, type Settings } from "../src/lsp/server";
import { statusFor } from "../src/lsp/status";
import { COMMANDS } from "../src/protocol";
import { FixtureRegistry } from "../src/registry/fixture";
import { hooks, index, offline, PACKAGE_JSON, sampleReport } from "./analyze-fixture";

/** The text a range covers, to assert on names rather than numbers. */
function slice(
  text: string,
  range: { start: { line: number; character: number }; end: { line: number; character: number } },
) {
  const lines = text.split("\n");
  expect(range.start.line).toBe(range.end.line);
  return lines[range.start.line]?.slice(range.start.character, range.end.character);
}

describe("diagnostics", () => {
  test("findings land on the dependency entries they name", async () => {
    const diagnostics = reportToDiagnostics(await sampleReport(), PACKAGE_JSON);
    const on = diagnostics.map((d) => `${d.code}@${slice(PACKAGE_JSON, d.range)}`);
    expect(on).toEqual([
      'current-unsupported@"better-sqlite3"',
      // rollup is transitive: its direct dependency, vite, carries it.
      'current-unsupported@"vite"',
      'compiles:better-sqlite3@"better-sqlite3"',
    ]);
    const first = diagnostics[0];
    expect(first?.severity).toBe(1);
    expect(first?.source).toBe("nodefit");
    expect(first?.message.split("\n")[0]).toBe("Node 18.20 does not fit this project");
    expect(first?.data.fix).toEqual({ kind: "use-node", version: "22", command: "fnm use 22" });
    expect(first?.range.start).toEqual({ line: 4, character: 4 });
  });

  test("project-wide findings stay out of the file; engines findings go on the range", async () => {
    const report = await sampleReport("22.21.1");
    expect(reportToDiagnostics(report, PACKAGE_JSON)).toEqual([]);
    report.findings.push({ id: "engines-excludes-recommended:engines", severity: "warning", title: "t", detail: "d" });
    const [d] = reportToDiagnostics(report, PACKAGE_JSON);
    expect(slice(PACKAGE_JSON, d?.range as never)).toBe('">=18"');
  });

  test("broken JSON yields no diagnostics rather than wrong ones", async () => {
    expect(reportToDiagnostics(await sampleReport(), "")).toEqual([]);
  });

  test("the dependency under the cursor, on its name or its range", () => {
    const name = PACKAGE_JSON.indexOf("express") + 2;
    const range = PACKAGE_JSON.indexOf("^5.1.0") + 1;
    expect(dependencyAt(PACKAGE_JSON, name)).toBe("express");
    expect(dependencyAt(PACKAGE_JSON, range)).toBe("express");
    expect(dependencyAt(PACKAGE_JSON, PACKAGE_JSON.indexOf("shop"))).toBeUndefined();
  });
});

describe("code actions and settings", () => {
  test("pin fixes become one action per version, plus check again", async () => {
    const diagnostics = reportToDiagnostics(await sampleReport(), PACKAGE_JSON);
    const actions = codeActionsFor(diagnostics, ".nvmrc");
    expect(actions.map((a) => a.title)).toEqual(["Pin Node 22 in .nvmrc", "Check again"]);
    expect(actions[0]?.command).toEqual({
      title: "Pin Node 22 in .nvmrc",
      command: COMMANDS.pinNode,
      arguments: ["22"],
    });
    expect(actions[0]?.diagnostics?.length).toBe(3);
    expect(actions[1]?.command?.command).toBe(COMMANDS.refresh);
  });

  test("the pin file is the exact pin in use, else .nvmrc", async () => {
    const report = await sampleReport();
    expect(pinFileName(report.project)).toBe(".nvmrc");
    report.project.pins.push({ source: ".node-version", file: "/work/shop/.node-version", value: "22", exact: true });
    expect(pinFileName(report.project)).toBe(".node-version");
  });

  test("settings from initializationOptions and from VS Code's section", () => {
    const base: Settings = { notifications: "problems-only", includeDev: true, clientHandlesNotifications: false };
    expect(readSettings({ clientHandlesNotifications: true, notifications: "off", includeDev: false }, base)).toEqual({
      notifications: "off",
      includeDev: false,
      clientHandlesNotifications: true,
    });
    expect(readSettings({ nodefit: { includeDevDependencies: false, notifications: "all" } }, base)).toEqual({
      ...base,
      includeDev: false,
      notifications: "all",
    });
    expect(readSettings(null, base)).toEqual(base);
    expect(readSettings({ notifications: "loud" }, base)).toEqual(base);
  });
});

describe("status and Markdown", () => {
  test("status carries errors and warnings only", async () => {
    const status = statusFor(await sampleReport());
    expect(status.state).toBe("error");
    expect(status.text).toBe("Node 18.20 ✗");
    expect(status.current).toBe("18.20.4");
    expect(status.recommended).toBe("22.21.1");
    expect(status.supported).toBe("20.19.5+, 22");
    expect(status.findings.map((f) => f.severity)).toEqual(["error", "warning"]);
    expect(status.tooltip).toContain("Node 18.20 does not fit this project (+1 more).");

    const ok = statusFor(await sampleReport("22.21.1"));
    expect(ok.state).toBe("ok");
    expect(ok.text).toBe("Node 22.21 ✓");
    expect(ok.tooltip).toBe("Node 22.21.1 fits every dependency (supported: 20.19.5+, 22).");
  });

  test("the report reads as Markdown", async () => {
    const md = reportToMarkdown(await sampleReport(), "2026-10-16");
    expect(md).toStartWith("# nodefit doctor\n");
    expect(md).toContain("## Compatibility");
    expect(md).toContain("- **Recommended**: 22.21.1 (LTS Jod)");
    expect(md).toContain("| better-sqlite3 12.4.1 | 20, 22 | prebuilt (downloaded at install) · engines >=18 |");
    expect(md).toContain("- **Error: Node 18.20 does not fit this project**");
    expect(md).toContain("  Fix: `fnm use 22`");
    expect(md).toContain("- **Dependencies**: 3 direct dependencies");
  });

  test("a check reads as Markdown", async () => {
    const outcome = await checkPackage(
      "left-pad@1",
      {
        env: { managers: [], installed: [] },
        index,
        registry: new FixtureRegistry().add("left-pad", [{ version: "1.3.0" }]),
        http: offline,
        platform: { os: "linux", arch: "x64" },
      },
      hooks,
    );
    const md = checkToMarkdown(outcome);
    expect(outcome.severity).toBe("info");
    expect(md).toContain("# nodefit check: left-pad 1.3.0");
    expect(md).toContain("- supported Node: any");
  });
});

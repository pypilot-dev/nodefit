import { describe, expect, test } from "bun:test";
import type { Finding } from "@pypilot-dev/nodefit";
import type { StatusParams } from "@pypilot-dev/nodefit/protocol";
import { fixAction, newProblems, notificationMessage, statusBarView } from "../src/view";

const status = (over: Partial<StatusParams>): StatusParams => ({
  state: "ok",
  text: "Node 24.11 ✓",
  tooltip: "Every dependency runs on Node 24.11.",
  supported: "20.9–20.19, 22, 24",
  findings: [],
  ...over,
});

const finding = (id: string, severity: Finding["severity"], fix?: Finding["fix"]): Finding => ({
  id,
  severity,
  title: `${id} title`,
  detail: `${id} detail`,
  fix,
});

describe("statusBarView", () => {
  test("spins while checking", () => {
    expect(statusBarView(status({ state: "checking" })).text).toBe("$(sync~spin) nodefit");
  });

  test("swaps the server's tick for a codicon", () => {
    const view = statusBarView(status({}));
    expect(view.text).toBe("$(check) Node 24.11");
    expect(view.background).toBeUndefined();
  });

  test("marks problems and lists the versions in the tooltip", () => {
    const view = statusBarView(
      status({ state: "error", text: "Node 18.20 ✗", current: "18.20.4", recommended: "22.11.0" }),
    );
    expect(view.text).toBe("$(error) Node 18.20");
    expect(view.background).toBe("error");
    expect(view.tooltip).toContain("Current: Node 18.20.4");
    expect(view.tooltip).toContain("Recommended: Node 22.11.0");
    expect(view.tooltip).toContain("Supported: 20.9–20.19, 22, 24");
  });

  test("falls back to the name when the server sends no text", () => {
    expect(statusBarView(status({ state: "warning", text: "" })).text).toBe("$(warning) nodefit");
  });
});

describe("fixAction", () => {
  test("labels the buttons", () => {
    expect(fixAction({ kind: "pin-node", version: "22" })?.label).toBe("Pin Node 22");
    expect(fixAction({ kind: "use-node", version: "22.11.0", command: "nvm use 22" })).toEqual({
      kind: "use-node",
      label: "Switch to Node 22.11.0",
      version: "22.11.0",
      command: "nvm use 22",
    });
  });

  test("has no button for a dependency change or no fix", () => {
    expect(fixAction({ kind: "change-dependency", name: "sharp", range: "^0.33" })).toBeUndefined();
    expect(fixAction(undefined)).toBeUndefined();
  });
});

describe("newProblems", () => {
  test("notifies once per finding, errors first, never about info", () => {
    const seen = new Set<string>();
    const findings = [finding("w", "warning"), finding("i", "info"), finding("e", "error")];
    expect(newProblems(findings, seen, "problems-only").map((f) => f.id)).toEqual(["e", "w"]);
    expect(newProblems(findings, seen, "problems-only")).toEqual([]);
    expect(newProblems([...findings, finding("w2", "warning")], seen, "all").map((f) => f.id)).toEqual(["w2"]);
  });

  test("stays silent when off, without marking anything seen", () => {
    const seen = new Set<string>();
    expect(newProblems([finding("e", "error")], seen, "off")).toEqual([]);
    expect(seen.size).toBe(0);
  });
});

test("notificationMessage counts the rest", () => {
  expect(notificationMessage(finding("e", "error"), 0)).toBe("nodefit: e title");
  expect(notificationMessage(finding("e", "error"), 2)).toBe("nodefit: e title (and 2 more; see the report)");
});

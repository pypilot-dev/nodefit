import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readProject, writePin } from "../src/project/index";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "nodefit-pin-"));
  mkdirSync(join(root, ".git"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const read = (root: string, name: string) => readFileSync(join(root, name), "utf8");

async function pin(root: string, version: string) {
  return writePin(await readProject(root), version);
}

describe("writePin", () => {
  test("creates .nvmrc when the project has no exact pin, leaving engines alone", async () => {
    const pkg = '{\n  "engines": { "node": ">=20" }\n}\n';
    const root = tree({ "package.json": pkg });
    const result = await pin(root, "22.11.0");
    expect(result).toEqual({
      file: join(root, ".nvmrc"),
      pin: { source: ".nvmrc", file: join(root, ".nvmrc"), value: "22.11.0", exact: true },
    });
    expect(read(root, ".nvmrc")).toBe("22.11.0\n");
    expect(read(root, "package.json")).toBe(pkg);
  });

  test("updates .nvmrc in place, keeping comments, CRLF and the v prefix", async () => {
    const root = tree({ "package.json": "{}", ".nvmrc": "# pinned for CI\r\nv20.18.0\r\n", ".node-version": "20\n" });
    const result = await pin(root, "22.11.0");
    expect(result.pin.value).toBe("v22.11.0");
    expect(read(root, ".nvmrc")).toBe("# pinned for CI\r\nv22.11.0\r\n");
    // Only the most specific pin is rewritten.
    expect(read(root, ".node-version")).toBe("20\n");
  });

  test(".node-version without a trailing newline stays that way", async () => {
    const root = tree({ "package.json": "{}", ".node-version": "20" });
    await pin(root, "v22.11.0");
    expect(read(root, ".node-version")).toBe("22.11.0");
  });

  test("volta: only volta.node changes; tabs, CRLF, key order and the BOM survive", async () => {
    const pkg =
      '﻿{\r\n\t"name": "x",\r\n\t"volta": {\r\n\t\t"node": "20.18.0",\r\n\t\t"npm": "10.8.2"\r\n\t},\r\n\t"engines": {\r\n\t\t"node": ">=20"\r\n\t}\r\n}\r\n';
    const root = tree({ "package.json": pkg, "mise.toml": '[tools]\nnode = "20"\n' });
    const result = await pin(root, "22.11.0");
    expect(result.pin).toMatchObject({ source: "volta", value: "22.11.0" });
    expect(read(root, "package.json")).toBe(pkg.replace('"20.18.0"', '"22.11.0"'));
    expect(read(root, "mise.toml")).toBe('[tools]\nnode = "20"\n');
  });

  test(".tool-versions keeps the other tools", async () => {
    const root = tree({ "package.json": "{}", ".tool-versions": "python 3.12.1\r\nnodejs 20.18.0\r\nruby 3.3.0\r\n" });
    await pin(root, "22.11.0");
    expect(read(root, ".tool-versions")).toBe("python 3.12.1\r\nnodejs 22.11.0\r\nruby 3.3.0\r\n");
  });

  test("mise.toml: string and list forms", async () => {
    const root = tree({ "package.json": "{}", "mise.toml": '[env]\nX = "1"\n\n[tools]\nnode = ["20", "18"] # main\n' });
    await pin(root, "22.11.0");
    expect(read(root, "mise.toml")).toBe('[env]\nX = "1"\n\n[tools]\nnode = ["22.11.0", "18"] # main\n');
  });

  test("never writes to a pin in a parent directory", async () => {
    const root = tree({ ".nvmrc": "20\n", "app/package.json": "{}" });
    const app = join(root, "app");
    const project = await readProject(app);
    expect(project.pins.map((p) => p.file)).toEqual([join(root, ".nvmrc")]);
    const result = await writePin(project, "22.11.0");
    expect(result.file).toBe(join(app, ".nvmrc"));
    expect(read(root, ".nvmrc")).toBe("20\n");
    expect(read(app, ".nvmrc")).toBe("22.11.0\n");
  });

  test("an .nvmrc with only comments gains the version below them", async () => {
    const root = tree({ "package.json": "{}", ".nvmrc": "# set by nodefit\r\n" });
    await pin(root, "22.11.0");
    expect(read(root, ".nvmrc")).toBe("# set by nodefit\r\n22.11.0\r\n");
  });

  test("devEngines alone is a range, not a pin to rewrite", async () => {
    const pkg = JSON.stringify({ devEngines: { runtime: { name: "node", version: "^22" } } }, null, 2);
    const root = tree({ "package.json": pkg });
    await pin(root, "22.11.0");
    expect(read(root, "package.json")).toBe(pkg);
    expect(existsSync(join(root, ".nvmrc"))).toBe(true);
  });
});

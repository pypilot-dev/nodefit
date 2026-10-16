import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readProject } from "../src/project/index";
import { miseNode, toolVersionsNode } from "../src/project/pins";

/**
 * A project in a fresh temp directory. It gets a `.git` so that pin files
 * above it (a developer's ~/.nvmrc) can't leak into the test, unless
 * `repo: false`.
 */
function tree(files: Record<string, string>, opts: { repo?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "nodefit-project-"));
  if (opts.repo !== false) mkdirSync(join(root, ".git"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

describe("package.json", () => {
  test("missing or invalid package.json throws a clear error", async () => {
    expect(readProject(tree({}))).rejects.toThrow("no package.json");
    expect(readProject(tree({ "package.json": "{ nope" }))).rejects.toThrow("not valid JSON");
    expect(readProject(tree({ "package.json": "[]" }))).rejects.toThrow("JSON object");
  });

  test("a byte-order mark is ignored", async () => {
    const root = tree({ "package.json": `﻿${json({ name: "bom" })}` });
    expect((await readProject(root)).name).toBe("bom");
  });

  test("dependencies by kind, the way npm resolves duplicates", async () => {
    const root = tree({
      "package.json": json({
        name: "kinds",
        dependencies: { a: "^1", both: "^2", prodDev: "^3" },
        devDependencies: { d: "^4", prodDev: "^3", peerDev: "*" },
        optionalDependencies: { both: "^2", o: "^5" },
        peerDependencies: { p: ">=1", peerDev: "^6" },
      }),
    });
    const project = await readProject(root);
    const kinds = Object.fromEntries(project.dependencies.map((d) => [d.name, d.kind]));
    expect(kinds).toEqual({
      a: "prod",
      both: "optional",
      prodDev: "prod",
      d: "dev",
      peerDev: "dev",
      o: "optional",
      p: "peer",
    });
    expect(project.dependencies.find((d) => d.name === "p")?.range).toBe(">=1");
    expect(project).toMatchObject({ root, packageManager: "npm", locked: [], workspaces: [], pins: [] });
    expect(project.lockfile).toBeUndefined();
  });
});

describe("workspaces", () => {
  const pkg = (name: string) => json({ name });

  test("globs: *, ** and negation; directories without package.json are ignored", async () => {
    const root = tree({
      "package.json": json({ workspaces: ["packages/*", "apps/**", "!packages/legacy", "tools/cli/"] }),
      "packages/a/package.json": pkg("a"),
      "packages/legacy/package.json": pkg("legacy"),
      "packages/notes/README.md": "not a package",
      "apps/web/package.json": pkg("web"),
      "apps/mobile/ios/package.json": pkg("ios"),
      "apps/web/node_modules/dep/package.json": pkg("dep"),
      "tools/cli/package.json": pkg("cli"),
    });
    const { workspaces } = await readProject(root);
    expect(workspaces).toEqual(
      ["apps/mobile/ios", "apps/web", "packages/a", "tools/cli"].map((p) => join(root, ...p.split("/"))),
    );
  });

  test("the object form and pnpm-workspace.yaml", async () => {
    const yarn = tree({
      "package.json": json({ workspaces: { packages: ["pkgs/*"], nohoist: ["**/x"] } }),
      "pkgs/x/package.json": pkg("x"),
    });
    expect((await readProject(yarn)).workspaces).toEqual([join(yarn, "pkgs", "x")]);
    const pnpm = tree({
      "package.json": pkg("root"),
      "pnpm-workspace.yaml": "packages:\n  - 'libs/*'\n  - '!libs/skip'\n",
      "libs/one/package.json": pkg("one"),
      "libs/skip/package.json": pkg("skip"),
    });
    expect((await readProject(pnpm)).workspaces).toEqual([join(pnpm, "libs", "one")]);
  });
});

describe("package manager and lockfile choice", () => {
  test("the packageManager field picks the lockfile", async () => {
    const root = tree({
      "package.json": json({ packageManager: "pnpm@9.12.0+sha512.abc" }),
      "package-lock.json": json({ lockfileVersion: 3, packages: {} }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });
    const project = await readProject(root);
    expect(project.packageManager).toBe("pnpm");
    expect(project.packageManagerSpec).toBe("pnpm@9.12.0+sha512.abc");
    expect(project.lockfile).toEqual({ kind: "pnpm", path: join(root, "pnpm-lock.yaml") });
  });

  test("a declared manager without its lockfile still reports the one present", async () => {
    const root = tree({
      "package.json": json({ packageManager: "yarn@4.5.0" }),
      "package-lock.json": json({ lockfileVersion: 3, packages: {} }),
    });
    const project = await readProject(root);
    expect(project.packageManager).toBe("yarn");
    expect(project.lockfile?.kind).toBe("npm");
  });

  test("without the field, lockfile presence decides; shrinkwrap beats package-lock", async () => {
    const lock = json({ lockfileVersion: 3, packages: {} });
    const npm = tree({ "package.json": "{}", "package-lock.json": lock, "npm-shrinkwrap.json": lock });
    expect((await readProject(npm)).lockfile?.path).toBe(join(npm, "npm-shrinkwrap.json"));
    const both = tree({ "package.json": "{}", "package-lock.json": lock, "yarn.lock": "# yarn lockfile v1\n" });
    expect(await readProject(both)).toMatchObject({ packageManager: "yarn", lockfile: { kind: "yarn-classic" } });
    const berry = tree({ "package.json": "{}", "yarn.lock": "__metadata:\n  version: 8\n" });
    expect((await readProject(berry)).lockfile?.kind).toBe("yarn-berry");
  });
});

describe("Node pins", () => {
  test("every pin file, with comments and whitespace stripped", async () => {
    const root = tree({
      "package.json": json({
        volta: { node: "22.11.0", npm: "10.9.0" },
        engines: { node: ">=20.9.0", npm: ">=10" },
        devEngines: { runtime: { name: "node", version: "22.11.0", onFail: "error" } },
      }),
      ".nvmrc": "# the team's Node\n\n  v22.11.0  \n",
      ".node-version": "22\r\n",
      ".tool-versions": "python 3.12.1\nnodejs 22.11.0 20.18.0 # main first\n",
      "mise.toml": '[env]\nnode = "not this"\n\n[tools]\npython = "3.12"\nnode = "22"\n',
    });
    const pins = (await readProject(root)).pins;
    const file = (name: string) => join(root, name);
    expect(pins).toEqual([
      { source: ".nvmrc", file: file(".nvmrc"), value: "v22.11.0", exact: true },
      { source: ".node-version", file: file(".node-version"), value: "22", exact: true },
      { source: ".tool-versions", file: file(".tool-versions"), value: "22.11.0", exact: true },
      { source: "mise.toml", file: file("mise.toml"), value: "22", exact: true },
      { source: "volta", file: file("package.json"), value: "22.11.0", exact: true },
      { source: "engines", file: file("package.json"), value: ">=20.9.0", exact: false },
      { source: "devEngines", file: file("package.json"), value: "22.11.0", exact: true },
    ]);
  });

  test("devEngines arrays and ranges", async () => {
    const root = tree({
      "package.json": json({
        devEngines: {
          runtime: [
            { name: "bun", version: "1.1.0" },
            { name: "node", version: "^22.11.0" },
          ],
        },
      }),
    });
    expect((await readProject(root)).pins).toEqual([
      { source: "devEngines", file: join(root, "package.json"), value: "^22.11.0", exact: false },
    ]);
  });

  test("pin files in parent directories count, up to the repository root", async () => {
    const top = tree({ ".nvmrc": "18\n", "repo/.node-version": "20\n", "repo/.nvmrc": "22\n" }, { repo: false });
    mkdirSync(join(top, "repo", ".git"));
    const app = join(top, "repo", "apps", "web");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "package.json"), "{}");
    writeFileSync(join(app, ".node-version"), "24\n");
    const pins = (await readProject(app)).pins;
    // Nearest first, one of each file; ~/.nvmrc-style files above the repo are ignored.
    expect(pins.map((p) => [p.source, p.value, p.file])).toEqual([
      [".node-version", "24", join(app, ".node-version")],
      [".nvmrc", "22", join(top, "repo", ".nvmrc")],
    ]);
  });

  test("a .git file (worktrees, submodules) also marks the repository root", async () => {
    const top = tree({ ".nvmrc": "18\n", "wt/.git": "gitdir: elsewhere\n", "wt/package.json": "{}" }, { repo: false });
    expect((await readProject(join(top, "wt"))).pins).toEqual([]);
  });

  test("mise.toml forms", () => {
    expect(miseNode('[tools]\nnode = ["22.11.0", "20"]\n')?.value).toBe("22.11.0");
    expect(miseNode("[tools]\nnode = { version = '22', postinstall = 'x' }\n")?.value).toBe("22");
    expect(miseNode('tools.node = "lts"\n[env]\n')?.value).toBe("lts");
    expect(miseNode('[tools]\n"node" = "21"\n')?.value).toBe("21");
    expect(miseNode('[tools]\nnodejs = "21"\n')).toBeUndefined();
    const text = '[tools]\nnode = "22"\n';
    const at = miseNode(text);
    expect(text.slice(at?.start, at?.end)).toBe("22");
  });

  test(".tool-versions also accepts mise's `node` name", () => {
    expect(toolVersionsNode("node 22.11.0\n")?.value).toBe("22.11.0");
    expect(toolVersionsNode("# nodejs 18\nnodejsx 1\n")).toBeUndefined();
  });
});

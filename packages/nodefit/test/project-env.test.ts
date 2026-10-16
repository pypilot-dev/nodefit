import { describe, expect, test } from "bun:test";
import { type ProbeOptions, probeNodeEnv, useCommand } from "../src/project/index";

/** A fake machine: files that exist, directories and what they hold, and how programs answer. */
function machine(opts: {
  platform: NodeJS.Platform;
  env: Record<string, string>;
  home: string;
  files?: string[];
  dirs?: Record<string, string[]>;
  run?: Record<string, string>;
}): ProbeOptions & { calls: string[][] } {
  const calls: string[][] = [];
  const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  const files = new Set((opts.files ?? []).map(norm));
  const dirs = new Map(Object.entries(opts.dirs ?? {}).map(([k, v]) => [norm(k), v]));
  return {
    platform: opts.platform,
    env: opts.env,
    home: opts.home,
    isFile: (p) => files.has(norm(p)),
    readdir: (d) => dirs.get(norm(d)) ?? [],
    run: async (file, args) => {
      calls.push([file, ...args]);
      return opts.run?.[norm(file)];
    },
    calls,
  };
}

describe("probeNodeEnv", () => {
  test("Linux with nvm, fnm and mise", async () => {
    const m = machine({
      platform: "linux",
      home: "/home/u",
      env: {
        PATH: "/home/u/.local/share/fnm/aliases/default/bin:/usr/local/bin:/usr/bin",
        NVM_DIR: "/home/u/.nvm",
        FNM_MULTISHELL_PATH: "/run/user/1000/fnm_multishells/123",
        MISE_SHELL: "bash",
      },
      files: ["/usr/local/bin/node", "/usr/local/bin/fnm"],
      dirs: {
        "/home/u/.nvm/versions/node": ["v20.18.0", "v22.11.0"],
        "/home/u/.local/share/fnm/node-versions": ["v22.11.0", "v24.11.0", ".downloads"],
        "/home/u/.local/share/mise/installs/node": ["22", "22.21.1", "lts", "latest"],
      },
      run: { "/usr/local/bin/node": "v22.11.0\n/home/u/.nvm/versions/node/v22.11.0/bin/node\n" },
    });
    const env = await probeNodeEnv(m);
    expect(env).toEqual({
      managers: ["nvm", "fnm", "mise"],
      installed: ["24.11.0", "22.21.1", "22.11.0", "20.18.0"],
      current: { version: "22.11.0", path: "/home/u/.nvm/versions/node/v22.11.0/bin/node" },
    });
    expect(m.calls).toEqual([["/usr/local/bin/node", "-p", expect.stringContaining("process.execPath")]]);
  });

  test("nvm without NVM_DIR (an editor started from the desktop) is found by its install", async () => {
    const m = machine({
      platform: "darwin",
      home: "/Users/u",
      env: { PATH: "/usr/bin", XDG_DATA_HOME: "/Users/u/.data" },
      files: ["/Users/u/.nvm/nvm.sh"],
      dirs: { "/Users/u/.nvm/versions/node": ["v18.20.4"] },
    });
    expect(await probeNodeEnv(m)).toEqual({ managers: ["nvm"], installed: ["18.20.4"] });
  });

  test("macOS fnm in either data directory, volta, asdf and n", async () => {
    const m = machine({
      platform: "darwin",
      home: "/Users/u",
      env: { PATH: "/Users/u/.volta/bin:/opt/homebrew/bin", ASDF_DATA_DIR: "/Users/u/.asdf", N_PREFIX: "/Users/u/n" },
      files: ["/opt/homebrew/bin/fnm", "/Users/u/.volta/bin/volta"],
      dirs: {
        "/Users/u/Library/Application Support/fnm/node-versions": ["v20.9.0"],
        "/Users/u/.local/share/fnm/node-versions": ["v21.7.3"],
        "/Users/u/.volta/tools/image/node": ["22.11.0"],
        "/Users/u/.asdf/installs/nodejs": ["23.11.1", "ref-v1"],
        "/Users/u/n/n/versions/node": ["16.20.2"],
      },
    });
    expect(await probeNodeEnv(m)).toEqual({
      managers: ["fnm", "volta", "asdf", "n"],
      installed: ["23.11.1", "22.11.0", "21.7.3", "20.9.0", "16.20.2"],
    });
  });

  test("Windows: nvm-windows, case-insensitive variables, PATHEXT", async () => {
    const m = machine({
      platform: "win32",
      home: "C:\\Users\\u",
      env: {
        Path: "C:\\nvm4w\\nodejs;C:\\Windows\\system32",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        NVM_HOME: "C:\\Users\\u\\AppData\\Local\\nvm",
        NVM_SYMLINK: "C:\\nvm4w\\nodejs",
        LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
      },
      files: ["C:\\nvm4w\\nodejs\\node.exe"],
      dirs: { "C:\\Users\\u\\AppData\\Local\\nvm": ["v22.11.0", "v20.18.0", "nodejs"] },
      run: { "c:/nvm4w/nodejs/node.exe": "v22.11.0\r\nC:\\nvm4w\\nodejs\\node.exe\r\n" },
    });
    expect(await probeNodeEnv(m)).toEqual({
      managers: ["nvm-windows"],
      installed: ["22.11.0", "20.18.0"],
      current: { version: "22.11.0", path: "C:\\nvm4w\\nodejs\\node.exe" },
    });
  });

  test("Windows: a .cmd shim runs through cmd.exe; fnm and volta default directories", async () => {
    const m = machine({
      platform: "win32",
      home: "C:\\Users\\u",
      env: {
        PATH: "C:\\Users\\u\\AppData\\Local\\mise\\shims;C:\\Program Files\\Volta\\",
        ComSpec: "C:\\Windows\\system32\\cmd.exe",
        APPDATA: "C:\\Users\\u\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
        FNM_DIR: "D:\\fnm",
      },
      files: ["C:\\Users\\u\\AppData\\Local\\mise\\shims\\node.cmd", "C:\\Program Files\\Volta\\volta.exe"],
      dirs: {
        "D:\\fnm\\node-versions": ["v20.18.0"],
        "C:\\Users\\u\\AppData\\Local\\Volta\\tools\\image\\node": ["22.11.0"],
      },
      run: { "c:/windows/system32/cmd.exe": "v22.11.0\nC:\\mise\\node.exe\n" },
    });
    const env = await probeNodeEnv(m);
    expect(env).toEqual({
      managers: ["fnm", "volta"],
      installed: ["22.11.0", "20.18.0"],
      current: { version: "22.11.0", path: "C:\\mise\\node.exe" },
    });
    const [cmd, ...args] = m.calls[0] ?? [];
    expect(cmd).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(args[3]).toStartWith('""C:\\Users\\u\\AppData\\Local\\mise\\shims\\node.cmd" -p ');
  });

  test("no node on PATH, or one that fails, leaves current unset", async () => {
    const none = machine({ platform: "linux", home: "/h", env: { PATH: "/usr/bin" } });
    expect(await probeNodeEnv(none)).toEqual({ managers: [], installed: [] });
    expect(none.calls).toEqual([]);
    const broken = machine({ platform: "linux", home: "/h", env: { PATH: "/usr/bin" }, files: ["/usr/bin/node"] });
    expect((await probeNodeEnv(broken)).current).toBeUndefined();
  });

  test("the real machine answers without throwing", async () => {
    const env = await probeNodeEnv();
    expect(Array.isArray(env.managers)).toBe(true);
    if (env.current) expect(env.current.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("useCommand", () => {
  test("each manager's install-and-switch command", () => {
    expect(useCommand("nvm", "22.11.0")).toBe("nvm install 22.11.0");
    expect(useCommand("nvm-windows", "v22.11.0")).toBe("nvm install 22.11.0; nvm use 22.11.0");
    expect(useCommand("fnm", "22.11.0")).toBe("fnm use --install-if-missing 22.11.0");
    expect(useCommand("volta", "22.11.0")).toBe("volta pin node@22.11.0");
    expect(useCommand("mise", "22.11.0")).toBe("mise use node@22.11.0");
    expect(useCommand("asdf", "22.11.0")).toBe("asdf install nodejs 22.11.0 && asdf set nodejs 22.11.0");
    expect(useCommand("n", "22.11.0")).toBe("n 22.11.0");
  });
});

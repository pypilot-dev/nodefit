import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import semver from "semver";
import type { NodeEnvironment, VersionManager } from "../types";
import { isFile, subdirs } from "./files";

/** What `probeNodeEnv` reads from the machine; tests replace any of it. */
export interface ProbeOptions {
  /** Environment variables (default `process.env`). */
  env?: Record<string, string | undefined>;
  /** Default `process.platform`; decides path syntax and default directories. */
  platform?: NodeJS.Platform;
  /** The user's home directory (default `os.homedir()`). */
  home?: string;
  /** Run a program and resolve its stdout, or undefined when it fails or times out. */
  run?: (file: string, args: string[]) => Promise<string | undefined>;
  /** Sub-directory names of `dir`, [] when it doesn't exist. */
  readdir?: (dir: string) => string[];
  /** True when `path` is an existing file (used to search PATH). */
  isFile?: (path: string) => boolean;
}

const NODE_TIMEOUT_MS = 5000;

// No quotes or spaces, so it survives cmd.exe when node is a .cmd shim.
const NODE_SCRIPT = "process.version+String.fromCharCode(10)+process.execPath";

/**
 * The `node` on PATH, the version managers on this machine and the Node
 * versions they hold. The current process's own version says nothing:
 * nodefit may be running inside VS Code's extension host, or under npx on
 * a different Node than the project's shell would pick.
 */
export async function probeNodeEnv(options: ProbeOptions = {}): Promise<NodeEnvironment> {
  const ctx = context(options);
  const managers = detectManagers(ctx);
  const installed = new Set<string>();
  for (const manager of managers) for (const v of installedVersions(ctx, manager)) installed.add(v);
  const env: NodeEnvironment = {
    managers,
    installed: [...installed].sort(semver.rcompare),
  };
  const current = await currentNode(ctx);
  if (current) env.current = current;
  return env;
}

interface Context {
  platform: NodeJS.Platform;
  home: string;
  path: typeof posix;
  /** Names of the environment variables that are set. */
  names: string[];
  get(name: string): string | undefined;
  run(file: string, args: string[]): Promise<string | undefined>;
  readdir(dir: string): string[];
  isFile(path: string): boolean;
  which(name: string): string | undefined;
}

function context(options: ProbeOptions): Context {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const windows = platform === "win32";
  // Windows environment variable names are case-insensitive (Path vs PATH).
  const get = (name: string): string | undefined => {
    if (env[name] !== undefined) return env[name] || undefined;
    if (!windows) return undefined;
    const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
    return key === undefined ? undefined : env[key] || undefined;
  };
  const path = windows ? win32 : posix;
  const fileExists = options.isFile ?? isFile;
  const which = (name: string): string | undefined => {
    const exts = windows ? (get("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
    for (const dir of (get("PATH") ?? "").split(windows ? ";" : ":")) {
      if (!dir) continue;
      for (const ext of exts) {
        const candidate = path.join(dir.replace(/^"|"$/g, ""), name + ext.toLowerCase());
        if (fileExists(candidate)) return candidate;
      }
    }
    return undefined;
  };
  return {
    platform,
    home: options.home ?? homedir(),
    path,
    names: Object.keys(env).filter((k) => env[k]),
    get,
    run: options.run ?? ((file, args) => runFile(file, args, env)),
    readdir: options.readdir ?? subdirs,
    isFile: fileExists,
    which,
  };
}

function runFile(file: string, args: string[], env: Record<string, string | undefined>): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        env: env as NodeJS.ProcessEnv,
        timeout: NODE_TIMEOUT_MS,
        windowsHide: true,
        // cmd.exe parses its own command line; Node's quoting would garble it.
        windowsVerbatimArguments: /(^|[\\/])cmd(\.exe)?$/i.test(file),
      },
      (error, stdout) => resolve(error ? undefined : stdout),
    );
  });
}

async function currentNode(ctx: Context): Promise<NodeEnvironment["current"]> {
  const node = ctx.which("node");
  if (!node) return undefined;
  // Since Node 18.20.2 / 20.12.2 (CVE-2024-27980) a .cmd shim can't be run
  // without a shell, and some version managers install one.
  const out = /\.(cmd|bat)$/i.test(node)
    ? await ctx.run(ctx.get("ComSpec") ?? "cmd.exe", ["/d", "/s", "/c", `""${node}" -p ${NODE_SCRIPT}"`])
    : await ctx.run(node, ["-p", NODE_SCRIPT]);
  const [version, path] = (out ?? "").trim().split(/\r?\n/);
  const clean = semver.valid(version?.trim() ?? "");
  return clean ? { version: clean, path: path?.trim() || node } : undefined;
}

function detectManagers(ctx: Context): VersionManager[] {
  const windows = ctx.platform === "win32";
  const has = (...names: string[]) => names.some((n) => ctx.get(n) !== undefined);
  const found: VersionManager[] = [];
  // nvm is a shell function, not a program: look for its install instead.
  if (!windows && (has("NVM_DIR") || ctx.isFile(ctx.path.join(ctx.home, ".nvm", "nvm.sh")))) found.push("nvm");
  if (windows && (has("NVM_HOME", "NVM_SYMLINK") || ctx.which("nvm"))) found.push("nvm-windows");
  if (has("FNM_DIR", "FNM_MULTISHELL_PATH") || ctx.which("fnm")) found.push("fnm");
  if (has("VOLTA_HOME") || ctx.which("volta")) found.push("volta");
  if (envPrefixed(ctx, "MISE_") || ctx.which("mise")) found.push("mise");
  if (has("ASDF_DIR", "ASDF_DATA_DIR") || ctx.which("asdf")) found.push("asdf");
  if (has("N_PREFIX") || (!windows && ctx.which("n"))) found.push("n");
  return found;
}

function envPrefixed(ctx: Context, prefix: string): boolean {
  return ctx.names.some((n) => n.toUpperCase().startsWith(prefix));
}

/** Directories holding one sub-directory per installed Node version, per manager. */
function versionDirs(ctx: Context, manager: VersionManager): string[] {
  const { join } = ctx.path;
  const home = ctx.home;
  const windows = ctx.platform === "win32";
  const appData = ctx.get("APPDATA") ?? join(home, "AppData", "Roaming");
  const localAppData = ctx.get("LOCALAPPDATA") ?? join(home, "AppData", "Local");
  const xdgData = ctx.get("XDG_DATA_HOME") ?? join(home, ".local", "share");
  switch (manager) {
    case "nvm":
      return [join(ctx.get("NVM_DIR") ?? join(home, ".nvm"), "versions", "node")];
    case "nvm-windows":
      return [ctx.get("NVM_HOME") ?? join(appData, "nvm")];
    case "fnm": {
      // fnm uses ~/.fnm when it exists (older installs), else the platform's
      // data directory; macOS moved from Application Support to XDG in fnm
      // 1.35, so check both.
      const fnmDir = ctx.get("FNM_DIR");
      const bases = fnmDir
        ? [fnmDir]
        : [
            join(home, ".fnm"),
            windows ? join(appData, "fnm") : join(xdgData, "fnm"),
            ...(ctx.platform === "darwin" ? [join(home, "Library", "Application Support", "fnm")] : []),
          ];
      return bases.map((b) => join(b, "node-versions"));
    }
    case "volta":
      return [
        join(
          ctx.get("VOLTA_HOME") ?? (windows ? join(localAppData, "Volta") : join(home, ".volta")),
          "tools",
          "image",
          "node",
        ),
      ];
    case "mise":
      return [
        join(
          ctx.get("MISE_DATA_DIR") ?? (windows ? join(localAppData, "mise") : join(xdgData, "mise")),
          "installs",
          "node",
        ),
      ];
    case "asdf":
      return [join(ctx.get("ASDF_DATA_DIR") ?? join(home, ".asdf"), "installs", "nodejs")];
    case "n":
      return [join(ctx.get("N_PREFIX") ?? "/usr/local", "n", "versions", "node")];
  }
}

/**
 * Full versions only: mise and asdf keep aliases such as "22" or "lts"
 * next to the real installs, and nvm-windows keeps its own files there.
 */
function installedVersions(ctx: Context, manager: VersionManager): string[] {
  const out: string[] = [];
  for (const dir of versionDirs(ctx, manager)) {
    for (const name of ctx.readdir(dir)) {
      const v = semver.valid(name.replace(/^v/, ""));
      if (v && /^v?\d+\.\d+\.\d+/.test(name)) out.push(v);
    }
  }
  return out;
}

/**
 * The command that installs `version` if needed and makes it this
 * project's Node, for the user to run in a terminal.
 */
export function useCommand(manager: VersionManager, version: string): string {
  const v = version.replace(/^v/, "");
  switch (manager) {
    case "nvm":
      // `nvm install` also switches the current shell to it.
      return `nvm install ${v}`;
    case "nvm-windows":
      // `install` doesn't switch. `;` separates commands in every PowerShell
      // (VS Code's default Windows terminal); 5.1 has no `&&`.
      return `nvm install ${v}; nvm use ${v}`;
    case "fnm":
      return `fnm use --install-if-missing ${v}`;
    case "volta":
      // `pin` writes package.json's volta.node, so the project (and anyone
      // cloning it) gets this Node; volta fetches it on first use.
      return `volta pin node@${v}`;
    case "mise":
      // Installs and writes mise.toml in the current directory.
      return `mise use node@${v}`;
    case "asdf":
      // asdf 0.16 replaced `asdf local` with `asdf set`, which writes .tool-versions.
      return `asdf install nodejs ${v} && asdf set nodejs ${v}`;
    case "n":
      return `n ${v}`;
  }
}

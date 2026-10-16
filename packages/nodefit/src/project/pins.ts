import { dirname, join, resolve } from "node:path";
import semver from "semver";
import type { NodePin, PinSource } from "../types";
import { isDir, isFile, isRecord, readText } from "./files";
import type { Manifest } from "./manifest";

/**
 * Files version managers look for in the project directory and then each
 * parent, nearest first. They stop at the filesystem root; nodefit stops
 * after the repository root (a directory with `.git`), so a stray ~/.nvmrc
 * doesn't speak for every project.
 */
const WALKED: [string, PinSource][] = [
  [".nvmrc", ".nvmrc"],
  [".node-version", ".node-version"],
  [".tool-versions", ".tool-versions"],
  ["mise.toml", "mise.toml"],
  [".mise.toml", "mise.toml"],
];

/** Every place the project (or a directory above it) says which Node it wants. */
export function readPins(root: string, manifest: Manifest): NodePin[] {
  const pins: NodePin[] = [];
  const found = new Set<string>();
  for (const dir of ancestors(root)) {
    for (const [name, source] of WALKED) {
      // The nearest file of each kind wins, as each tool reads only that one.
      if (found.has(source)) continue;
      const file = join(dir, name);
      const text = isFile(file) ? readText(file) : undefined;
      if (text === undefined) continue;
      const value = readPinFile(source, text);
      if (value === undefined) continue;
      found.add(source);
      pins.push({ source, file, value, exact: true });
    }
  }
  pins.push(...manifestPins(join(resolve(root), "package.json"), manifest));
  return pins;
}

/** `root`, then its parents up to and including the first one holding `.git`. */
function ancestors(root: string): string[] {
  const dirs: string[] = [];
  let dir = resolve(root);
  for (;;) {
    dirs.push(dir);
    const gitDir = join(dir, ".git");
    if (isDir(gitDir) || isFile(gitDir)) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/** The Node version a pin file names, or undefined when it names none. */
export function readPinFile(source: PinSource, text: string): string | undefined {
  switch (source) {
    case ".nvmrc":
    case ".node-version":
      return firstVersionLine(text);
    case ".tool-versions":
      return toolVersionsNode(text)?.value;
    case "mise.toml":
      return miseNode(text)?.value;
    default:
      return undefined;
  }
}

/** nvm reads the first line, ignoring `#` comments and surrounding whitespace. */
export function firstVersionLine(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const value = line.replace(/#.*$/, "").trim();
    if (value) return value;
  }
  return undefined;
}

/** A located value: `start`/`end` are offsets into the text, for rewriting it in place. */
export interface Located {
  value: string;
  start: number;
  end: number;
}

/** asdf names the plugin `nodejs`; mise also accepts `node`. The first version listed is the one used. */
export function toolVersionsNode(text: string): Located | undefined {
  const re = /^[ \t]*(?:nodejs|node)[ \t]+([^\s#]+)/gm;
  const m = re.exec(text);
  if (!m?.[1]) return undefined;
  const end = m.index + m[0].length;
  return { value: m[1], start: end - m[1].length, end };
}

/**
 * `node` under `[tools]` in mise.toml: `node = "22"`, `node = ["22", "20"]`
 * (the first is active), `node = { version = "22" }`, or the dotted
 * `tools.node = "22"` at the top level. A line scan rather than a TOML
 * parser: these are the forms mise documents, and it keeps nodefit dependency-free.
 */
export function miseNode(text: string): Located | undefined {
  let section = "";
  let offset = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header?.[1]) section = header[1].trim();
    else {
      const key =
        section === "tools"
          ? /^\s*(?:"node"|'node'|node)\s*=\s*/.exec(line)
          : section === ""
            ? /^\s*tools\.(?:"node"|node)\s*=\s*/.exec(line)
            : null;
      if (key) {
        const rest = line.slice(key[0].length);
        const str = /^(?:\[\s*|\{[^}]*?version\s*=\s*)?(["'])([^"']*)\1/.exec(rest);
        if (str?.[2] !== undefined) {
          const start = offset + key[0].length + str[0].length - 1 - str[2].length;
          return { value: str[2], start, end: start + str[2].length };
        }
      }
    }
    offset += line.length;
  }
  return undefined;
}

/** Pins in package.json: volta's exact one, and the `engines` / `devEngines` ranges. */
function manifestPins(file: string, manifest: Manifest): NodePin[] {
  const pins: NodePin[] = [];
  const volta = isRecord(manifest.volta) ? manifest.volta.node : undefined;
  if (typeof volta === "string" && volta.trim()) pins.push({ source: "volta", file, value: volta.trim(), exact: true });
  const engines = isRecord(manifest.engines) ? manifest.engines.node : undefined;
  if (typeof engines === "string" && engines.trim()) {
    pins.push({ source: "engines", file, value: engines.trim(), exact: false });
  }
  const devEngines = isRecord(manifest.devEngines) ? manifest.devEngines.runtime : undefined;
  for (const runtime of Array.isArray(devEngines) ? devEngines : [devEngines]) {
    if (!isRecord(runtime) || runtime.name !== "node" || typeof runtime.version !== "string") continue;
    const value = runtime.version.trim();
    if (value) pins.push({ source: "devEngines", file, value, exact: semver.valid(value) !== null });
  }
  return pins;
}

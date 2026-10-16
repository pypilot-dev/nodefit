import { NodeSet } from "../node/set";
import type { NodeIndex, NodeVersionSet, Platform } from "../types";
import { libcFromName, mayNameThisArch, namesAnOs, namesThisOs, words } from "./platforms";

export interface BundledBinaries {
  /** Releases a bundled binary loads on; undefined when none fits this platform. */
  prebuilt?: NodeVersionSet | "all";
  /** The files that fit, for evidence. */
  matched: string[];
  /** Platforms the package does ship binaries for ("darwin-arm64", …). */
  platforms: string[];
  /** Any .node file at all: tells a native package from a JS one. */
  hasBinaries: boolean;
  /** A binding.gyp at the root: node-gyp can compile it. */
  hasBindingGyp: boolean;
}

/**
 * Which bundled binaries in a file listing load on `platform`, and on which
 * Node releases.
 *
 * `prebuilds/<platform>-<arch>[+<arch>]/*.node` is prebuildify's layout,
 * read the way node-gyp-build reads it. Other layouts (better-sqlite3's flat
 * `prebuilds/win32-x64.node`, farmhash's `build/farmhash-win32-x64.node`,
 * deasync's `bin/win32-x64-node-22/`, zeromq's `build/win32/x64/node/…`) are
 * matched by the platform words in their paths.
 */
export function readBundledBinaries(files: string[], platform: Platform, index: NodeIndex): BundledBinaries {
  const binaries = files.filter((f) => f.endsWith(".node"));
  const result: BundledBinaries = {
    matched: [],
    platforms: [],
    hasBinaries: binaries.length > 0,
    hasBindingGyp: files.includes("binding.gyp"),
  };

  const prebuildify = binaries.filter((f) => /^prebuilds\/[^/]+\/[^/]+\.node$/.test(f));
  if (prebuildify.length > 0) {
    readPrebuildify(prebuildify, platform, index, result);
    return result;
  }
  readByPathWords(binaries, platform, index, result);
  return result;
}

interface Tags {
  runtime?: string;
  napi?: boolean;
  abi?: number;
  uv?: string;
  armv?: string;
  libc?: string;
}

/** node-gyp-build's parseTags: dot-separated tags before ".node". */
function parseTags(file: string): Tags {
  const tags: Tags = {};
  for (const tag of file.split(".").slice(0, -1)) {
    if (tag === "node" || tag === "electron" || tag === "node-webkit" || tag === "bare") tags.runtime = tag;
    else if (tag === "napi") tags.napi = true;
    else if (/^abi\d+$/.test(tag)) tags.abi = Number(tag.slice(3));
    else if (tag.startsWith("uv")) tags.uv = tag.slice(2);
    else if (tag.startsWith("armv")) tags.armv = tag.slice(4);
    else if (tag === "glibc" || tag === "musl") tags.libc = tag;
  }
  return tags;
}

function readPrebuildify(files: string[], platform: Platform, index: NodeIndex, result: BundledBinaries): void {
  // node-gyp-build calls every non-Alpine system "glibc", Windows and macOS
  // included, so argon2's `win32-x64/argon2.glibc.node` loads on Windows.
  const libc = platform.os === "linux" && platform.libc === "musl" ? "musl" : "glibc";
  const armv = platform.arch === "arm64" ? "8" : platform.arch === "arm" ? undefined : "";
  const platforms = new Set<string>();
  let anyVersion = false;
  const abis = new Set<number>();

  for (const file of files) {
    const [, dir = "", name = ""] = file.split("/");
    const dash = dir.indexOf("-");
    const os = dir.slice(0, dash);
    const archs = dir.slice(dash + 1).split("+");
    const tags = parseTags(name);
    if (tags.runtime && tags.runtime !== "node") continue;
    platforms.add(dir);
    if (os !== platform.os || !archs.includes(platform.arch)) continue;
    if (tags.libc && tags.libc !== libc) continue;
    if (tags.armv !== undefined && armv !== undefined && tags.armv !== armv) continue;
    if (tags.uv && tags.uv !== "1") continue;
    result.matched.push(file);
    if (tags.napi || tags.abi === undefined) anyVersion = true;
    else abis.add(tags.abi);
  }

  result.platforms = [...platforms].sort();
  if (result.matched.length === 0) return;
  result.prebuilt = anyVersion ? "all" : NodeSet.fromAbis(index, abis);
}

/**
 * Layouts other than prebuildify's: a binary fits when its path names our OS
 * and does not name another architecture or C library. A `node-22` or
 * `abi127` segment ties it to a Node line; otherwise it is taken to be a
 * Node-API build, which these packages (better-sqlite3, farmhash, zeromq)
 * all are.
 */
function readByPathWords(files: string[], platform: Platform, index: NodeIndex, result: BundledBinaries): void {
  const platforms = new Set<string>();
  let anyVersion = false;
  const majors = new Set<number>();
  const abis = new Set<number>();
  const wantMusl = platform.os === "linux" && platform.libc === "musl";

  for (const file of files) {
    if (!namesAnOs(file)) continue;
    const ws = words(file);
    if (ws.includes("electron") || file.endsWith(".bare")) continue;
    platforms.add(platformWords(ws));
    if (!namesThisOs(file, platform) || !mayNameThisArch(file, platform)) continue;
    if (platform.os === "linux" && (libcFromName(file) === "musl") !== wantMusl) continue;
    result.matched.push(file);
    const major = /(?:^|[/-])node-v?(\d+)(?:\.\d+)?(?:[/-]|$)/.exec(file);
    const abi = /(?:^|[/.-])abi(\d+)(?:[/.-]|$)/.exec(file);
    if (major?.[1]) majors.add(Number(major[1]));
    else if (abi?.[1]) abis.add(Number(abi[1]));
    else anyVersion = true;
  }

  result.platforms = [...platforms].filter(Boolean).sort();
  if (result.matched.length === 0) return;
  if (anyVersion) {
    result.prebuilt = "all";
    return;
  }
  const byMajor = NodeSet.fromVersions(
    index,
    index.releases.filter((r) => majors.has(r.major)).map((r) => r.version),
  );
  result.prebuilt = byMajor.union(NodeSet.fromAbis(index, abis));
}

/** "win32-x64" out of a path's words, for telling the user what does exist. */
function platformWords(ws: string[]): string {
  const i = ws.findIndex((w) => namesAnOs(w));
  if (i === -1) return "";
  const next = ws[i + 1];
  return next && !/^\d/.test(next) && next !== "node" ? `${ws[i]}-${next}` : (ws[i] as string);
}

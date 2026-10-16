import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { DependencyKind, DirectDependency } from "../types";
import { isFile, isRecord, readText, stringMap, subdirs } from "./files";

export type Manifest = Record<string, unknown>;

/** package.json in `dir`, parsed. Throws a message the user can act on. */
export function readManifest(dir: string): Manifest {
  const file = join(dir, "package.json");
  const text = readText(file);
  if (text === undefined) throw new Error(`no package.json in ${dir}; run nodefit in a Node.js project`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  if (!isRecord(parsed)) throw new Error(`${file} must contain a JSON object`);
  return parsed;
}

/** Like `readManifest`, but undefined instead of throwing (workspace members). */
export function tryReadManifest(dir: string): Manifest | undefined {
  try {
    return readManifest(dir);
  } catch {
    return undefined;
  }
}

const KIND_FIELDS: [string, DependencyKind][] = [
  ["devDependencies", "dev"],
  ["dependencies", "prod"],
  ["optionalDependencies", "optional"],
  ["peerDependencies", "peer"],
];

/**
 * Direct dependencies, one entry per name. Later fields in KIND_FIELDS win,
 * following npm: a name in both `dependencies` and `devDependencies` is
 * installed for production, and one also in `optionalDependencies` is
 * optional. A peer that is also listed elsewhere keeps that kind, since
 * that entry is what gets installed.
 */
export function directDependencies(manifest: Manifest): DirectDependency[] {
  const byName = new Map<string, DirectDependency>();
  for (const [field, kind] of KIND_FIELDS) {
    for (const [name, range] of Object.entries(stringMap(manifest[field]) ?? {})) {
      if (kind === "peer" && byName.has(name)) continue;
      byName.set(name, { name, range, kind });
    }
  }
  return [...byName.values()];
}

/** Workspace patterns from package.json (npm/yarn/bun) and pnpm-workspace.yaml. */
export function workspacePatterns(root: string, manifest: Manifest): string[] {
  const patterns: string[] = [];
  const field = manifest.workspaces;
  const list = Array.isArray(field) ? field : isRecord(field) ? field.packages : undefined;
  if (Array.isArray(list)) patterns.push(...list.filter((p): p is string => typeof p === "string"));
  const pnpm = readText(join(root, "pnpm-workspace.yaml"));
  if (pnpm !== undefined) {
    try {
      const doc: unknown = parseYaml(pnpm);
      if (isRecord(doc) && Array.isArray(doc.packages)) {
        patterns.push(...doc.packages.filter((p): p is string => typeof p === "string"));
      }
    } catch {
      // A broken pnpm-workspace.yaml stops pnpm itself; nothing to add here.
    }
  }
  return patterns;
}

/**
 * Directories matching workspace patterns that hold a package.json, absolute
 * and sorted. Supports what real repos write (`packages/*`, `apps/**`,
 * `tools/cli`, `!packages/legacy`) rather than full glob syntax, to avoid a
 * dependency.
 */
export function expandWorkspaces(root: string, patterns: string[]): string[] {
  const include = new Set<string>();
  const exclude = new Set<string>();
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const pattern = raw
      .slice(negated ? 1 : 0)
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/\/+$/, "");
    if (!pattern) continue;
    const target = negated ? exclude : include;
    for (const dir of matchDirs(root, pattern.split("/"))) target.add(dir);
  }
  const rootDir = resolve(root);
  return [...include].filter((d) => !exclude.has(d) && d !== rootDir && isFile(join(d, "package.json"))).sort();
}

function matchDirs(base: string, segments: string[]): string[] {
  const [head, ...rest] = segments;
  if (head === undefined) return [resolve(base)];
  if (head === "**") {
    // `**` matches zero or more directories.
    const out = matchDirs(base, rest);
    for (const name of visible(base)) out.push(...matchDirs(join(base, name), segments));
    return out;
  }
  if (!/[*?]/.test(head)) return matchDirs(join(base, head), rest);
  const re = segmentRegex(head);
  return visible(base)
    .filter((name) => re.test(name))
    .flatMap((name) => matchDirs(join(base, name), rest));
}

/** Directories a glob walks into: never node_modules or hidden ones, as npm and pnpm skip them. */
function visible(dir: string): string[] {
  return subdirs(dir).filter((n) => n !== "node_modules" && !n.startsWith("."));
}

function segmentRegex(segment: string): RegExp {
  const body = segment
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${body}$`);
}

import { type ParseError, parse } from "jsonc-parser/lib/esm/main.js";
import type { DependencyKind, LockedPackage } from "../../types";
import { enginesObject, isRecord, stringList, stringMap } from "../files";
import { compact, edgeMap, isRegistryVersion, LockGraph, splitSpec } from "./graph";

const KINDS: [string, DependencyKind][] = [
  ["dependencies", "prod"],
  ["devDependencies", "dev"],
  ["optionalDependencies", "optional"],
  ["peerDependencies", "peer"],
];

/**
 * bun.lock, Bun's text lockfile (JSONC with trailing commas). `packages`
 * maps an install path to `[ "name@version", registry, metadata, integrity ]`;
 * the path is the chain of package names node_modules nests it under
 * ("fs-minipass/minipass"), so a dependency resolves to the deepest
 * matching key, as Node's module resolution would find it. Workspace, file
 * and git entries have a shorter tuple whose metadata (if any) comes second.
 */
export function parseBunLock(text: string): LockedPackage[] {
  const errors: ParseError[] = [];
  const doc: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isRecord(doc)) throw new Error("not valid JSONC");
  const packages = isRecord(doc.packages) ? doc.packages : {};
  const graph = new LockGraph();

  for (const [key, entry] of Object.entries(packages)) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
    const [name, version] = splitSpec(entry[0]);
    const meta = entry.find((e, i) => i > 0 && isRecord(e)) as Record<string, unknown> | undefined;
    // A registry entry's second slot is the registry URL ("" for the default).
    const registry = typeof entry[1] === "string" && isRegistryVersion(version);
    const deps = stringMap(meta?.dependencies);
    const optionalDeps = stringMap(meta?.optionalDependencies);
    const pkg = registry
      ? compact<LockedPackage>({
          name,
          version,
          path: `node_modules/${segments(key).join("/node_modules/")}`,
          engines: enginesObject(meta?.engines),
          os: stringList(meta?.os),
          cpu: stringList(meta?.cpu),
          dependencies: edgeMap(deps, optionalDeps),
        })
      : undefined;
    const node = graph.add(key, pkg);
    for (const dep of Object.keys(deps ?? {})) addEdge(packages, node.edges, key, dep, false);
    for (const dep of Object.keys(optionalDeps ?? {})) addEdge(packages, node.edges, key, dep, true);
  }

  // Each workspace's dependencies resolve from under its package name.
  const workspaces = isRecord(doc.workspaces) ? doc.workspaces : {};
  for (const [dir, ws] of Object.entries(workspaces)) {
    if (!isRecord(ws)) continue;
    const from = dir !== "" && typeof ws.name === "string" && ws.name in packages ? ws.name : "";
    for (const [field, kind] of KINDS) {
      for (const dep of Object.keys(stringMap(ws[field]) ?? {})) {
        const to = resolve(packages, from, dep);
        if (to) graph.roots.push({ to, kind });
      }
    }
  }
  graph.markFlags();
  return graph.packages();
}

function addEdge(
  packages: Record<string, unknown>,
  edges: { to: string; optional: boolean }[],
  from: string,
  dep: string,
  optional: boolean,
): void {
  const to = resolve(packages, from, dep);
  if (to) edges.push({ to, optional });
}

function resolve(packages: Record<string, unknown>, from: string, dep: string): string | undefined {
  const segs = from ? segments(from) : [];
  for (let i = segs.length; i >= 0; i--) {
    const key = [...segs.slice(0, i), dep].join("/");
    if (key in packages) return key;
  }
  return undefined;
}

/** "a/@s/b/c" → ["a", "@s/b", "c"]: scoped names keep their slash. */
function segments(key: string): string[] {
  const out: string[] = [];
  const parts = key.split("/");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string;
    out.push(part.startsWith("@") && i + 1 < parts.length ? `${part}/${parts[++i]}` : part);
  }
  return out;
}

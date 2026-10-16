import { parse as parseYaml } from "yaml";
import type { DirectDependency, LockedPackage } from "../../types";
import { isRecord, stringMap } from "../files";
import { compact, edgeMap, isRegistryVersion, LockGraph, splitSpec } from "./graph";

/** Yarn 2+ (berry) lockfiles are YAML with a `__metadata` entry; classic ones aren't YAML. */
export function isBerryLock(text: string): boolean {
  return /^__metadata:/m.test(text);
}

/**
 * Neither yarn format records dev or optional, nor which entry is the
 * project: dependencies are looked up by descriptor ("name@range"), so the
 * graph's roots are the direct dependencies of the project and its workspaces.
 */
export function parseYarnLock(text: string, direct: DirectDependency[]): LockedPackage[] {
  return isBerryLock(text) ? parseBerry(text, direct) : parseClassic(text, direct);
}

// --------------------------------------------------------------------------
// Yarn classic (v1)

interface ClassicEntry {
  descriptors: string[];
  fields: Record<string, string>;
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
}

/**
 * yarn.lock v1 is its own format: unindented, comma-separated descriptors
 * end with ":", two-space fields are `key "value"`, and dependency blocks
 * list `name "range"` pairs four spaces in.
 */
export function readClassicEntries(text: string): ClassicEntry[] {
  const entries: ClassicEntry[] = [];
  let entry: ClassicEntry | undefined;
  let block: Record<string, string> | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    if (indent === 0) {
      entry = {
        descriptors: body.replace(/:$/, "").split(/,\s*/).map(unquote),
        fields: {},
        dependencies: {},
        optionalDependencies: {},
      };
      entries.push(entry);
      block = undefined;
    } else if (entry && indent <= 2) {
      const [key, value] = pair(body);
      block = undefined;
      if (value === "" && body.endsWith(":")) {
        if (key === "dependencies") block = entry.dependencies;
        else if (key === "optionalDependencies") block = entry.optionalDependencies;
      } else entry.fields[key] = value;
    } else if (block) {
      const [key, value] = pair(body);
      block[key] = value;
    }
  }
  return entries;
}

function pair(body: string): [string, string] {
  const m = /^("(?:[^"\\]|\\.)*"|[^\s:]+):?\s*(.*)$/.exec(body);
  return m ? [unquote(m[1] as string), unquote((m[2] as string).trim())] : [body, ""];
}

function unquote(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

function parseClassic(text: string, direct: DirectDependency[]): LockedPackage[] {
  const graph = new LockGraph();
  const byDescriptor = new Map<string, string>();
  const entries = readClassicEntries(text);
  for (const e of entries) for (const d of e.descriptors) byDescriptor.set(d, e.descriptors[0] as string);

  for (const e of entries) {
    const id = e.descriptors[0] as string;
    const [descName, range] = splitSpec(id);
    // An alias ("foo@npm:bar@^1") installs `bar` under the name `foo`.
    const name = range.startsWith("npm:") ? splitSpec(range.slice(4))[0] : descName;
    const version = e.fields.version;
    const registry = isRegistryVersion(version) && isRegistryTarball(e.fields.resolved, range);
    const deps = Object.keys(e.dependencies).length > 0 ? e.dependencies : undefined;
    const optionalDeps = Object.keys(e.optionalDependencies).length > 0 ? e.optionalDependencies : undefined;
    const node = graph.add(
      id,
      registry ? compact<LockedPackage>({ name, version, dependencies: edgeMap(deps, optionalDeps) }) : undefined,
    );
    for (const [dep, r] of Object.entries(e.dependencies)) {
      const to = byDescriptor.get(`${dep}@${r}`);
      if (to) node.edges.push({ to, optional: false });
    }
    for (const [dep, r] of Object.entries(e.optionalDependencies)) {
      const to = byDescriptor.get(`${dep}@${r}`);
      if (to) node.edges.push({ to, optional: true });
    }
  }
  for (const d of direct) {
    const to = byDescriptor.get(`${d.name}@${d.range}`);
    if (to) graph.roots.push({ to, kind: d.kind });
  }
  graph.markFlags();
  return graph.packages();
}

/**
 * Registry tarballs live under ".../-/name-1.2.3.tgz"; git and GitHub
 * tarballs, file: and link: packages don't. Without `resolved` (offline
 * mirrors), trust a descriptor that is a semver range or tag.
 */
function isRegistryTarball(resolved: string | undefined, range: string): boolean {
  if (resolved) return /^https?:\/\//.test(resolved) && resolved.includes("/-/");
  return !/^(file|link|portal|git|github|gitlab|bitbucket|https?|workspace):|^[^@/]+\/[^/]+$/.test(range);
}

// --------------------------------------------------------------------------
// Yarn berry (2+)

/**
 * Keys list descriptors ("a@npm:^1.0.0, a@npm:^1.2.0"); `resolution` is the
 * locator ("a@npm:1.2.3"). Only `npm:` resolutions are registry packages:
 * `workspace:` entries are the project's own packages, `patch:` ones repeat
 * an npm entry with a patch applied, and file/git/link entries aren't published.
 */
function parseBerry(text: string, direct: DirectDependency[]): LockedPackage[] {
  const doc: unknown = parseYaml(text);
  if (!isRecord(doc)) throw new Error("not a YAML mapping");
  const graph = new LockGraph();
  const byDescriptor = new Map<string, string>();
  for (const key of Object.keys(doc)) {
    if (key === "__metadata") continue;
    for (const d of key.split(/,\s*/)) byDescriptor.set(stripLocator(d), key);
  }
  const lookup = (name: string, range: string): string | undefined => {
    // Lockfile descriptors are normalised ("npm:^1.0.0"); package.json ranges aren't.
    if (range.startsWith("patch:")) {
      const inner = /^patch:(.+?)#/.exec(range)?.[1];
      if (inner) return lookup(...splitSpec(decodeURIComponent(inner)));
    }
    return byDescriptor.get(`${name}@${range}`) ?? byDescriptor.get(`${name}@npm:${range}`);
  };

  for (const [key, raw] of Object.entries(doc)) {
    if (key === "__metadata" || !isRecord(raw)) continue;
    const resolution = typeof raw.resolution === "string" ? raw.resolution : "";
    const [resName, ref] = splitSpec(resolution);
    let pkg: LockedPackage | undefined;
    if (ref.startsWith("npm:")) {
      // Aliased resolutions read "real@npm:1.2.3"; older ones "alias@npm:real@1.2.3".
      const inner = ref.slice(4);
      const [name, version] = inner.includes("@") ? splitSpec(inner) : [resName, inner];
      if (isRegistryVersion(version)) {
        const conditions = parseConditions(raw.conditions);
        const deps = stringMap(raw.dependencies);
        pkg = compact<LockedPackage>({
          name,
          version,
          // Yarn adds `node-gyp: npm:latest` to packages that ship a
          // binding.gyp, the same packages npm marks hasInstallScript.
          hasInstallScript: deps?.["node-gyp"] === "npm:latest" ? true : undefined,
          os: conditions.os,
          cpu: conditions.cpu,
          dependencies: edgeMap(npmRanges(raw.dependencies), npmRanges(raw.optionalDependencies)),
        });
      }
    }
    const node = graph.add(key, pkg);
    const meta = isRecord(raw.dependenciesMeta) ? raw.dependenciesMeta : {};
    const optionalMeta = (dep: string) =>
      isRecord(meta[dep]) && (meta[dep] as Record<string, unknown>).optional === true;
    for (const [dep, range] of Object.entries(stringMap(raw.dependencies) ?? {})) {
      const to = lookup(dep, range);
      if (to) node.edges.push({ to, optional: optionalMeta(dep) });
    }
    for (const [dep, range] of Object.entries(stringMap(raw.optionalDependencies) ?? {})) {
      const to = lookup(dep, range);
      if (to) node.edges.push({ to, optional: true });
    }
    // A patch entry stands in for the package it patches.
    if (!pkg && ref.startsWith("patch:")) {
      const to = lookup(resName, ref);
      if (to && to !== key) node.edges.push({ to, optional: false });
    }
  }
  for (const d of direct) {
    const to = lookup(d.name, d.range);
    if (to) graph.roots.push({ to, kind: d.kind });
  }
  graph.markFlags();
  return graph.packages();
}

/** Berry writes "npm:^1.0.0"; report the plain range, as the other lockfiles do. Aliases stay as written. */
function npmRanges(value: unknown): Record<string, string> | undefined {
  const map = stringMap(value);
  if (!map) return undefined;
  for (const [k, v] of Object.entries(map)) if (v.startsWith("npm:") && !v.includes("@")) map[k] = v.slice(4);
  return map;
}

/** "a@file:./x::locator=root%40workspace%3A." → "a@file:./x": the locator only disambiguates. */
function stripLocator(descriptor: string): string {
  const i = descriptor.indexOf("::");
  return i < 0 ? descriptor : descriptor.slice(0, i);
}

/** "os=darwin & cpu=arm64" → { os: ["darwin"], cpu: ["arm64"] }. */
function parseConditions(value: unknown): { os?: string[]; cpu?: string[] } {
  if (typeof value !== "string") return {};
  const out: { os?: string[]; cpu?: string[] } = {};
  for (const m of value.matchAll(/\b(os|cpu)=([\w-]+)/g)) {
    const key = m[1] as "os" | "cpu";
    out[key] = [...(out[key] ?? []), m[2] as string];
  }
  return out;
}

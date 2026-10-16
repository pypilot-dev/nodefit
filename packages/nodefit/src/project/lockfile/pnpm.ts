import { parse as parseYaml } from "yaml";
import type { DependencyKind, LockedPackage } from "../../types";
import { enginesObject, isRecord, stringList, stringMap } from "../files";
import { compact, dedupe, edgeMap, isRegistryVersion, LockGraph } from "./graph";

const KINDS: [string, DependencyKind][] = [
  ["dependencies", "prod"],
  ["devDependencies", "dev"],
  ["optionalDependencies", "optional"],
];

/**
 * pnpm-lock.yaml. Up to v6 (pnpm 8) each `packages` entry carries its own
 * dev/optional flags and `requiresBuild`; v9 splits metadata (`packages`)
 * from the resolved graph (`snapshots`) and drops those flags, so they are
 * derived from the importers' dependencies instead.
 */
export function parsePnpmLock(text: string): LockedPackage[] {
  const doc: unknown = parseYaml(text);
  if (!isRecord(doc)) throw new Error("not a YAML mapping");
  const version = Number.parseFloat(String(doc.lockfileVersion ?? "0"));
  return version >= 9 ? parseV9(doc) : parseV6(doc);
}

function parseV6(doc: Record<string, unknown>): LockedPackage[] {
  const out: LockedPackage[] = [];
  for (const [key, raw] of Object.entries(isRecord(doc.packages) ? doc.packages : {})) {
    // Non-registry packages (git, tarball URLs, file:) have keys without the leading "/".
    if (!key.startsWith("/") || !isRecord(raw)) continue;
    const id = parseKey(key.slice(1));
    if (!id) continue;
    out.push(
      compact({
        name: id.name,
        version: id.version,
        dev: typeof raw.dev === "boolean" ? raw.dev : undefined,
        optional: raw.optional === true ? true : undefined,
        engines: enginesObject(raw.engines),
        hasInstallScript: raw.requiresBuild === true ? true : undefined,
        os: stringList(raw.os),
        cpu: stringList(raw.cpu),
        dependencies: edgeMap(versions(raw.dependencies), versions(raw.optionalDependencies)),
      }),
    );
  }
  return dedupe(out);
}

function parseV9(doc: Record<string, unknown>): LockedPackage[] {
  const meta = isRecord(doc.packages) ? doc.packages : {};
  const snapshots = isRecord(doc.snapshots) ? doc.snapshots : {};
  const graph = new LockGraph();
  for (const [key, raw] of Object.entries(snapshots)) {
    const snap = isRecord(raw) ? raw : {};
    const id = parseKey(key);
    // Peer-suffixed snapshots share their metadata entry: "a@1.0.0(react@18.3.1)" → "a@1.0.0".
    const info = meta[stripPeers(key)];
    const m = isRecord(info) ? info : {};
    const deps = stringMap(snap.dependencies);
    const optionalDeps = stringMap(snap.optionalDependencies);
    const pkg = id
      ? compact<LockedPackage>({
          name: id.name,
          version: id.version,
          engines: enginesObject(m.engines),
          hasInstallScript: m.requiresBuild === true ? true : undefined,
          os: stringList(m.os),
          cpu: stringList(m.cpu),
          dependencies: edgeMap(versions(deps), versions(optionalDeps)),
        })
      : undefined;
    const node = graph.add(key, pkg);
    for (const [name, ref] of Object.entries(deps ?? {})) push(node.edges, name, ref, false);
    for (const [name, ref] of Object.entries(optionalDeps ?? {})) push(node.edges, name, ref, true);
  }
  for (const importer of Object.values(isRecord(doc.importers) ? doc.importers : {})) {
    if (!isRecord(importer)) continue;
    for (const [field, kind] of KINDS) {
      for (const [name, spec] of Object.entries(isRecord(importer[field]) ? importer[field] : {})) {
        const ref = isRecord(spec) && typeof spec.version === "string" ? spec.version : undefined;
        const to = ref === undefined ? undefined : target(name, ref);
        if (to) graph.roots.push({ to, kind });
      }
    }
  }
  graph.markFlags();
  return graph.packages();
}

function push(edges: { to: string; optional: boolean }[], name: string, ref: string, optional: boolean): void {
  const to = target(name, ref);
  if (to) edges.push({ to, optional });
}

/**
 * The snapshot a dependency reference points at: "1.0.0(peer@1)" → "name@1.0.0(peer@1)";
 * aliases are written in full ("real@1.0.0"); "link:" refers to a workspace.
 */
function target(name: string, ref: string): string | undefined {
  if (ref.startsWith("link:")) return undefined;
  return /^@?[^@(]+@/.test(ref) && !ref.startsWith("file:") ? ref : `${name}@${ref}`;
}

/** name → resolved version, without pnpm's peer suffixes. */
function versions(value: unknown): Record<string, string> | undefined {
  const map = stringMap(value);
  if (!map) return undefined;
  for (const [k, v] of Object.entries(map)) map[k] = stripPeers(v);
  return map;
}

function stripPeers(ref: string): string {
  const paren = ref.indexOf("(");
  return paren < 0 ? ref : ref.slice(0, paren);
}

/**
 * "@s/a@1.0.0(peer@2)" (v6, v9) or "@s/a/1.0.0_peer@2" (v5) → name and
 * version; undefined for anything that isn't a registry version.
 */
function parseKey(key: string): { name: string; version: string } | undefined {
  const plain = stripPeers(key);
  const at = plain.indexOf("@", 1);
  if (at > 0) {
    const name = plain.slice(0, at);
    const version = plain.slice(at + 1);
    // A v5 key with a peer suffix ("a/1.0.0_b@2.0.0") also has an "@".
    if (/^(@[^/]+\/)?[^/]+$/.test(name) && isRegistryVersion(version)) return { name, version };
  }
  const slash = plain.lastIndexOf("/");
  if (slash > 0) {
    const version = plain.slice(slash + 1).replace(/_.*$/, "");
    if (isRegistryVersion(version)) return { name: plain.slice(0, slash), version };
  }
  return undefined;
}

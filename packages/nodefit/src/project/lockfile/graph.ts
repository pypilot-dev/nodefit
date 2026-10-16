import semver from "semver";
import type { DependencyKind, LockedPackage } from "../../types";

/** One lockfile entry and the entries its dependencies resolve to. */
export interface LockNode {
  /** Undefined for entries nodefit doesn't report: workspaces, links, git and file packages. */
  pkg?: LockedPackage;
  edges: { to: string; optional: boolean }[];
}

/**
 * A lockfile as a graph. bun, pnpm 9 and yarn don't record whether a
 * package is dev-only or optional, so `markFlags` derives it from which
 * direct dependencies reach it, the way npm computes those flags.
 */
export class LockGraph {
  readonly nodes = new Map<string, LockNode>();
  readonly roots: { to: string; kind: DependencyKind }[] = [];

  add(id: string, pkg: LockedPackage | undefined): LockNode {
    const node: LockNode = { pkg, edges: [] };
    this.nodes.set(id, node);
    return node;
  }

  /**
   * Set `dev` and `optional` on every package a root reaches: dev when only
   * dev dependencies lead to it, optional when every path to it passes an
   * optional edge. Unreached packages keep whatever the lockfile said.
   */
  markFlags(): void {
    const prod = this.reach(
      this.roots.filter((r) => r.kind !== "dev"),
      true,
    );
    const required = this.reach(
      this.roots.filter((r) => r.kind !== "optional"),
      false,
    );
    const any = this.reach(this.roots, true);
    for (const id of any) {
      const pkg = this.nodes.get(id)?.pkg;
      if (!pkg) continue;
      pkg.dev = !prod.has(id);
      pkg.optional = !required.has(id);
    }
  }

  private reach(roots: { to: string }[], followOptional: boolean): Set<string> {
    const seen = new Set<string>();
    const stack = roots.map((r) => r.to);
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (seen.has(id)) continue;
      const node = this.nodes.get(id);
      if (!node) continue;
      seen.add(id);
      for (const e of node.edges) if (followOptional || !e.optional) stack.push(e.to);
    }
    return seen;
  }

  /** The reported packages, one per name@version. */
  packages(): LockedPackage[] {
    return dedupe([...this.nodes.values()].flatMap((n) => (n.pkg ? [n.pkg] : [])));
  }
}

/**
 * One entry per name@version. npm nests the same version at several paths;
 * the merged entry is dev (or optional) only if every copy is.
 */
export function dedupe(list: LockedPackage[]): LockedPackage[] {
  const byKey = new Map<string, LockedPackage>();
  for (const pkg of list) {
    const key = `${pkg.name}@${pkg.version}`;
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, { ...pkg });
      continue;
    }
    seen.dev = both(seen.dev, pkg.dev);
    seen.optional = both(seen.optional, pkg.optional);
    seen.engines ??= pkg.engines;
    seen.hasInstallScript ||= pkg.hasInstallScript;
    seen.os ??= pkg.os;
    seen.cpu ??= pkg.cpu;
    if (pkg.dependencies) seen.dependencies = { ...pkg.dependencies, ...seen.dependencies };
    if (seen.dev === undefined) delete seen.dev;
    if (seen.optional === undefined) delete seen.optional;
    if (seen.hasInstallScript === undefined) delete seen.hasInstallScript;
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name) || semverOrder(a.version, b.version));
}

function both(a: boolean | undefined, b: boolean | undefined): boolean | undefined {
  if (a === undefined && b === undefined) return undefined;
  return Boolean(a) && Boolean(b);
}

function semverOrder(a: string, b: string): number {
  return semver.valid(a) && semver.valid(b) ? semver.compare(a, b) : a.localeCompare(b);
}

/** A version the registry publishes, as opposed to a git ref, path or URL. */
export function isRegistryVersion(version: string | undefined): version is string {
  return typeof version === "string" && semver.valid(version) !== null;
}

/** "name@range" → [name, range], scoped names included. */
export function splitSpec(spec: string): [string, string] {
  const at = spec.indexOf("@", 1);
  return at < 0 ? [spec, ""] : [spec.slice(0, at), spec.slice(at + 1)];
}

/** Drop undefined fields so tests and JSON output stay clean. */
export function compact<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[]) if (value[key] === undefined) delete value[key];
  return value;
}

/** dependencies + optionalDependencies as LockedPackage records them; undefined when empty. */
export function edgeMap(...maps: (Record<string, string> | undefined)[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const m of maps) if (m) Object.assign(out, m);
  return Object.keys(out).length > 0 ? out : undefined;
}

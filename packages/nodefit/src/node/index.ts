/**
 * Node.js releases and sets of them.
 *
 * OWNER: the node-core work package. This file fixes the exported API; the
 * implementation replaces the stubs.
 */

import type { HttpClient, NodeIndex, NodeRelease, NodeVersionSet } from "../types";

export interface LoadIndexOptions {
  http?: HttpClient;
  /** Never touch the network: cache, else the bundled snapshot. */
  offline?: boolean;
}

/**
 * Every final Node release with its ABI and N-API version: from
 * nodejs.org/dist/index.json (cached a day), else the cache at any age, else
 * the snapshot shipped in data/node-releases.json.
 */
export async function loadNodeIndex(_opts: LoadIndexOptions = {}): Promise<NodeIndex> {
  throw new Error("not implemented");
}

/** Immutable set of releases drawn from one index. */
export declare class NodeSet implements NodeVersionSet {
  /** Every release in the index. */
  static all(index: NodeIndex): NodeSet;
  static empty(index: NodeIndex): NodeSet;
  /** Releases satisfying a semver range, with npm's semantics (`engines.node`). Invalid ranges → all. */
  static fromRange(index: NodeIndex, range: string): NodeSet;
  /** Releases whose ABI (`process.versions.modules`) is in `abis`. */
  static fromAbis(index: NodeIndex, abis: Iterable<number>): NodeSet;
  /** Releases supporting at least N-API `version`. */
  static fromNapi(index: NodeIndex, version: number): NodeSet;
  static fromVersions(index: NodeIndex, versions: Iterable<string>): NodeSet;
  readonly size: number;
  isEmpty(): boolean;
  has(version: string): boolean;
  intersect(other: NodeVersionSet): NodeSet;
  union(other: NodeVersionSet): NodeSet;
  releases(): NodeRelease[];
  newest(): NodeRelease | undefined;
  newestLts(): NodeRelease | undefined;
  toString(): string;
}

/** The release for a version string ("v22.11.0" or "22.11.0"), if in the index. */
export function findRelease(_index: NodeIndex, _version: string): NodeRelease | undefined {
  throw new Error("not implemented");
}

/**
 * Resolve what a pin file says ("22", "lts/jod", "lts/*", "node", ">=20") to
 * the newest matching release, as nvm/fnm/volta would.
 */
export function resolveNodeSpec(_index: NodeIndex, _spec: string): NodeRelease | undefined {
  throw new Error("not implemented");
}

import semver from "semver";
import type { NodeIndex, NodeRelease, NodeVersionSet } from "../types";

/**
 * An immutable set of releases drawn from one index.
 *
 * Membership is by exact version, because `engines` ranges cut inside a
 * major line (`>=20.9.0`) and ABI changes happen at majors, so neither
 * majors nor minors alone are precise enough. The index is shared, so sets
 * from the same index combine cheaply.
 */
export class NodeSet implements NodeVersionSet {
  private constructor(
    private readonly index: NodeIndex,
    private readonly members: ReadonlySet<string>,
  ) {}

  static all(index: NodeIndex): NodeSet {
    return new NodeSet(index, new Set(index.releases.map((r) => r.version)));
  }

  static empty(index: NodeIndex): NodeSet {
    return new NodeSet(index, new Set());
  }

  /**
   * Releases satisfying `range` the way npm reads `engines.node`. A range
   * semver cannot parse constrains nothing: npm ignores it too, and calling
   * every release unsupported over a typo would be worse.
   */
  static fromRange(index: NodeIndex, range: string): NodeSet {
    const valid = semver.validRange(range.trim(), { loose: true });
    if (valid === null) return NodeSet.all(index);
    return NodeSet.filter(index, (r) => semver.satisfies(r.version, valid, { includePrerelease: true, loose: true }));
  }

  static fromAbis(index: NodeIndex, abis: Iterable<number>): NodeSet {
    const wanted = new Set(abis);
    return NodeSet.filter(index, (r) => wanted.has(r.abi));
  }

  static fromNapi(index: NodeIndex, version: number): NodeSet {
    return NodeSet.filter(index, (r) => (r.napi ?? 0) >= version);
  }

  static fromVersions(index: NodeIndex, versions: Iterable<string>): NodeSet {
    const known = new Set(index.releases.map((r) => r.version));
    return new NodeSet(index, new Set([...versions].map(strip).filter((v) => known.has(v))));
  }

  private static filter(index: NodeIndex, keep: (r: NodeRelease) => boolean): NodeSet {
    return new NodeSet(index, new Set(index.releases.filter(keep).map((r) => r.version)));
  }

  get size(): number {
    return this.members.size;
  }

  isEmpty(): boolean {
    return this.members.size === 0;
  }

  has(version: string): boolean {
    return this.members.has(strip(version));
  }

  intersect(other: NodeVersionSet): NodeSet {
    return new NodeSet(this.index, new Set([...this.members].filter((v) => other.has(v))));
  }

  union(other: NodeVersionSet): NodeSet {
    const merged = new Set(this.members);
    for (const r of other.releases()) merged.add(r.version);
    return new NodeSet(this.index, merged);
  }

  releases(): NodeRelease[] {
    return this.index.releases.filter((r) => this.members.has(r.version));
  }

  newest(): NodeRelease | undefined {
    return this.index.releases.find((r) => this.members.has(r.version));
  }

  newestLts(): NodeRelease | undefined {
    return this.index.releases.find((r) => r.lts !== false && this.members.has(r.version));
  }

  /**
   * "any", "none", or runs of releases: a whole major line reads "22", a
   * run of whole lines "18–22", part of a line "20.9–20.19" or "20.9+".
   */
  toString(): string {
    if (this.members.size === 0) return "none";
    if (this.members.size === this.index.releases.length) return "any";

    const byMajor = new Map<number, NodeRelease[]>();
    for (const r of [...this.index.releases].reverse()) {
      const line = byMajor.get(r.major) ?? [];
      line.push(r);
      byMajor.set(r.major, line);
    }

    const parts: string[] = [];
    let wholeRun: [number, number] | undefined;
    const flushWhole = () => {
      if (!wholeRun) return;
      parts.push(wholeRun[0] === wholeRun[1] ? `${wholeRun[0]}` : `${wholeRun[0]}–${wholeRun[1]}`);
      wholeRun = undefined;
    };

    for (const [major, line] of [...byMajor].sort((a, b) => a[0] - b[0])) {
      const inSet = line.filter((r) => this.members.has(r.version));
      if (inSet.length === 0) {
        flushWhole();
        continue;
      }
      if (inSet.length === line.length) {
        // Any line that is not whole flushes the run, so a run in progress
        // always ends at the previous line.
        wholeRun = wholeRun ? [wholeRun[0], major] : [major, major];
        continue;
      }
      flushWhole();
      parts.push(...partialLine(line, inSet));
    }
    flushWhole();
    return parts.join(", ");
  }
}

/** Contiguous runs within one major line, oldest first. */
function partialLine(line: NodeRelease[], inSet: NodeRelease[]): string[] {
  const wanted = new Set(inSet.map((r) => r.version));
  const runs: NodeRelease[][] = [];
  let run: NodeRelease[] = [];
  for (const r of line) {
    if (wanted.has(r.version)) run.push(r);
    else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);

  const last = line[line.length - 1];
  return runs.map((r) => {
    const first = r[0] as NodeRelease;
    const end = r[r.length - 1] as NodeRelease;
    if (end === last) return `${short(first)}+`;
    return first === end ? first.version : `${short(first)}–${short(end)}`;
  });
}

/** "20.9" for 20.9.0, else the full version. */
function short(r: NodeRelease): string {
  return r.version.endsWith(".0") ? r.version.slice(0, -2) : r.version;
}

function strip(version: string): string {
  return version.trim().replace(/^v/, "");
}

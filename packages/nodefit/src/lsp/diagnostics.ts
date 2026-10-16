// The package's main entry is a UMD build whose dynamic requires bundlers
// cannot follow; the ESM build bundles cleanly.
import { findNodeAtLocation, getLocation, type Node, parseTree } from "jsonc-parser/lib/esm/main.js";
import type { Finding, Fix, Report, Severity } from "../types";

/** The LSP shapes this module produces, kept structural so tests need no server. */
export interface Position {
  line: number;
  character: number;
}
export interface Range {
  start: Position;
  end: Position;
}
export interface Diagnostic {
  range: Range;
  severity: 1 | 2 | 3 | 4;
  source: "nodefit";
  code: string;
  message: string;
  data: { id: string; fix?: Fix };
}

const SEVERITY: Record<Severity, 1 | 2 | 3> = { error: 1, warning: 2, info: 3 };

/** Where npm reads dependencies, in the order a name is looked up. */
export const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/**
 * Diagnostics for package.json: each finding on the entries of the
 * packages it names (the direct dependency that pulls a transitive one in),
 * and the project's own engines findings on that range. Findings about the
 * project as a whole (no Node pinned, the shell's Node) have no place in the
 * file; the status bar and notifications carry them.
 */
export function reportToDiagnostics(report: Report, text: string): Diagnostic[] {
  const tree = parseTree(text, [], { allowTrailingComma: true });
  if (!tree) return [];
  const lines = lineStarts(text);
  const out: Diagnostic[] = [];
  for (const f of report.findings) {
    for (const node of findingNodes(tree, f)) out.push(diagnostic(f, node, lines));
  }
  return out;
}

function findingNodes(tree: Node, f: Finding): Node[] {
  if (f.id.startsWith("engines-excludes-recommended:")) {
    const path = f.id.endsWith(":devEngines") ? ["devEngines", "runtime"] : ["engines", "node"];
    const node = findNodeAtLocation(tree, path);
    return node ? [node] : [];
  }
  const nodes: Node[] = [];
  for (const name of new Set(f.packages ?? [])) {
    const key = dependencyKey(tree, name);
    if (key) nodes.push(key);
  }
  return nodes;
}

/** The key node of `name` in the first dependency section that lists it. */
export function dependencyKey(tree: Node, name: string): Node | undefined {
  for (const section of DEPENDENCY_SECTIONS) {
    const value = findNodeAtLocation(tree, [section, name]);
    const key = value?.parent?.children?.[0];
    if (key) return key;
  }
  return undefined;
}

/** The dependency name under `offset`, on its key or its range. */
export function dependencyAt(text: string, offset: number): string | undefined {
  const location = getLocation(text, offset);
  const [section, name] = location.path;
  if (location.path.length !== 2 || typeof section !== "string" || typeof name !== "string") return undefined;
  return DEPENDENCY_SECTIONS.includes(section) ? name : undefined;
}

function diagnostic(f: Finding, node: Node, lines: number[]): Diagnostic {
  return {
    range: { start: position(lines, node.offset), end: position(lines, node.offset + node.length) },
    severity: SEVERITY[f.severity],
    source: "nodefit",
    code: f.id,
    message: `${f.title}\n${f.detail}`,
    data: f.fix ? { id: f.id, fix: f.fix } : { id: f.id },
  };
}

export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/** LSP positions count UTF-16 code units, as JavaScript strings do. */
export function position(lines: number[], offset: number): Position {
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((lines[mid] as number) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, character: offset - (lines[lo] as number) };
}

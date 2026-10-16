import { readdirSync, readFileSync, statSync } from "node:fs";

/** A file's text without a byte-order mark, or undefined when it can't be read. */
export function readText(file: string): string | undefined {
  try {
    return stripBom(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Sub-directory names, or none when `dir` can't be listed. */
export function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** The line ending a file already uses, so edits don't mix them. */
export function detectEol(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A name → string map, dropping anything that isn't one. */
export function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === "string") out[k] = v;
  return out;
}

/** A string or string list as a list (lockfiles write `os` both ways). */
export function stringList(value: unknown): string[] | undefined {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    const list = value.filter((v): v is string => typeof v === "string");
    return list.length > 0 ? list : undefined;
  }
  return undefined;
}

/**
 * `engines` as an object. Very old packages wrote `["node >= 0.8"]` or the
 * bare string `"node >= 0.8"`; npm still reads those, so normalise them.
 */
export function enginesObject(value: unknown): Record<string, string> | undefined {
  if (isRecord(value)) return stringMap(value);
  const list = stringList(value);
  if (!list) return undefined;
  const out: Record<string, string> = {};
  for (const item of list) {
    const m = /^\s*([a-z][\w-]*)\s*(.*)$/i.exec(item);
    if (m?.[1]) out[m[1]] = m[2]?.trim() || "*";
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

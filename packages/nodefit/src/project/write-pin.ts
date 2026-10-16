import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import type { NodePin, PinSource, ProjectInfo } from "../types";
import { detectEol } from "./files";
import { type Located, miseNode, toolVersionsNode } from "./pins";

/**
 * The exact pins nodefit may rewrite, most specific first: .nvmrc is read by
 * nvm, fnm and others; volta's field by volta alone; .tool-versions and
 * mise.toml usually hold other tools too.
 */
const WRITABLE: PinSource[] = [".nvmrc", ".node-version", "volta", ".tool-versions", "mise.toml"];

/**
 * Record `version` as the project's Node: update the exact pin it already
 * uses, else create .nvmrc. Pins found in parent directories are left
 * alone (they speak for other projects too), and so are `engines` and
 * `devEngines`, ranges other tools read.
 */
export async function writePin(project: ProjectInfo, version: string): Promise<{ file: string; pin: NodePin }> {
  const v = version.trim().replace(/^v/, "");
  const root = resolve(project.root);
  const pin = WRITABLE.flatMap((source) =>
    project.pins.filter((p) => p.source === source && p.exact && dirname(resolve(p.file)) === root),
  )[0];

  if (!pin) {
    const file = join(root, ".nvmrc");
    const existing = readRaw(file);
    // An .nvmrc with only comments isn't a pin, but keep what it says.
    const text = existing
      ? `${existing.text}${/\n$/.test(existing.text) ? "" : existing.eol}${v}${existing.eol}`
      : `${v}\n`;
    writeFileSync(file, (existing?.bom ?? "") + text);
    return { file, pin: { source: ".nvmrc", file, value: v, exact: true } };
  }

  const raw = readRaw(pin.file);
  if (!raw) throw new Error(`can't read ${pin.file}`);
  let value = v;
  let text: string;
  if (pin.source === "volta") {
    text = setJsonValue(raw.text, ["volta", "node"], v, raw.eol);
  } else {
    const at = locate(pin.source, raw.text);
    if (!at) throw new Error(`no Node version found in ${pin.file}`);
    // Keep the file's style: "v22" stays v-prefixed.
    if (at.value.startsWith("v") && (pin.source === ".nvmrc" || pin.source === ".node-version")) value = `v${v}`;
    text = raw.text.slice(0, at.start) + value + raw.text.slice(at.end);
  }
  writeFileSync(pin.file, raw.bom + text);
  return { file: pin.file, pin: { ...pin, value } };
}

function locate(source: PinSource, text: string): Located | undefined {
  if (source === ".tool-versions") return toolVersionsNode(text);
  if (source === "mise.toml") return miseNode(text);
  return firstLine(text);
}

/** The first non-comment value in an .nvmrc / .node-version, where it sits. */
function firstLine(text: string): Located | undefined {
  let offset = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const m = /^(\s*)([^\s#]+)/.exec(line.replace(/#.*$/, ""));
    if (m?.[2]) {
      const start = offset + (m[1] as string).length;
      return { value: m[2], start, end: start + m[2].length };
    }
    offset += line.length;
  }
  return undefined;
}

function readRaw(file: string): { text: string; bom: string; eol: "\r\n" | "\n" } | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const bom = text.charCodeAt(0) === 0xfeff ? "﻿" : "";
  text = text.slice(bom.length);
  return { text, bom, eol: detectEol(text) };
}

/** Set one value in a JSON file, leaving its indentation and key order as they were. */
export function setJsonValue(text: string, path: string[], value: string, eol: string): string {
  const indent = /^([ \t]+)\S/m.exec(text)?.[1] ?? "  ";
  const edits = modify(text, path, value, {
    formattingOptions: {
      insertSpaces: !indent.startsWith("\t"),
      tabSize: indent.startsWith("\t") ? 1 : indent.length,
      eol,
    },
  });
  return applyEdits(text, edits);
}

/**
 * What a project declares, locks and pins, and which Node this machine runs.
 */

import { resolve } from "node:path";
import type { NodeEnvironment, NodePin, PackageManager, ProjectInfo } from "../types";
import { directDependencies, expandWorkspaces, readManifest, workspacePatterns } from "./manifest";
import { readPins } from "./pins";

/** Read package.json and every Node pin under `root`. Throws if there is no readable package.json. */
export async function readProject(root: string): Promise<ProjectInfo> {
  const dir = resolve(root);
  const manifest = readManifest(dir);
  const spec = typeof manifest.packageManager === "string" ? manifest.packageManager.trim() : undefined;
  const declared = spec?.split("@")[0] ?? "";
  const info: ProjectInfo = {
    root: dir,
    dependencies: directDependencies(manifest),
    locked: [],
    pins: readPins(dir, manifest),
    packageManager: ["npm", "bun", "pnpm", "yarn"].includes(declared) ? (declared as PackageManager) : "npm",
    workspaces: expandWorkspaces(dir, workspacePatterns(dir, manifest)),
  };
  if (typeof manifest.name === "string") info.name = manifest.name;
  if (spec) info.packageManagerSpec = spec;
  return info;
}

/** The `node` on PATH, installed version managers and the versions they hold. */
export async function probeNodeEnv(): Promise<NodeEnvironment> {
  throw new Error("not implemented");
}

/**
 * Record `version` as the project's Node: update the exact pin it already
 * uses (.nvmrc, .node-version, volta, .tool-versions, mise.toml), else
 * create .nvmrc. Never rewrites `engines` (a range other tools read).
 * Keeps the file's line endings and formatting.
 */
export async function writePin(_project: ProjectInfo, _version: string): Promise<{ file: string; pin: NodePin }> {
  throw new Error("not implemented");
}

/** The command that switches this machine to `version` with `manager`, e.g. "fnm use 22". */
export function useCommand(_manager: NodeEnvironment["managers"][number], _version: string): string {
  throw new Error("not implemented");
}

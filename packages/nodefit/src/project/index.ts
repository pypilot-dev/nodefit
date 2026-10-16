/**
 * What a project declares, locks and pins, and which Node this machine runs.
 *
 * OWNER: the project work package. This file fixes the exported API.
 */

import type { NodeEnvironment, NodePin, ProjectInfo } from "../types";

/** Read package.json, the lockfile and every Node pin under `root`. Throws if there is no package.json. */
export async function readProject(_root: string): Promise<ProjectInfo> {
  throw new Error("not implemented");
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

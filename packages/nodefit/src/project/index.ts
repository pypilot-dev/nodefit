/**
 * What a project declares, locks and pins, and which Node this machine runs.
 */

import { resolve } from "node:path";
import type { NodeEnvironment, NodePin, ProjectInfo } from "../types";
import { findLockfile, managerFromSpec, readLockfile } from "./lockfile/index";
import { directDependencies, expandWorkspaces, readManifest, tryReadManifest, workspacePatterns } from "./manifest";
import { readPins } from "./pins";

/**
 * Read package.json, the lockfile and every Node pin under `root`. Throws
 * if there is no readable package.json, or the lockfile is corrupt. A
 * binary bun.lockb is reported as the lockfile with no `locked` packages.
 */
export async function readProject(root: string): Promise<ProjectInfo> {
  const dir = resolve(root);
  const manifest = readManifest(dir);
  const dependencies = directDependencies(manifest);
  const workspaces = expandWorkspaces(dir, workspacePatterns(dir, manifest));

  const spec = typeof manifest.packageManager === "string" ? manifest.packageManager.trim() : undefined;
  const declared = managerFromSpec(spec);
  const lock = findLockfile(dir, declared);
  // Yarn lockfiles resolve the direct dependencies of every workspace by
  // descriptor, so the graph needs all of them as roots.
  const allDirect = [
    ...dependencies,
    ...workspaces.flatMap((ws) => {
      const m = tryReadManifest(ws);
      return m ? directDependencies(m) : [];
    }),
  ];

  const info: ProjectInfo = {
    root: dir,
    dependencies,
    locked: lock ? readLockfile(lock, allDirect) : [],
    pins: readPins(dir, manifest),
    packageManager: declared ?? lock?.manager ?? "npm",
    workspaces,
  };
  if (typeof manifest.name === "string") info.name = manifest.name;
  if (lock) info.lockfile = { kind: lock.kind, path: lock.path };
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

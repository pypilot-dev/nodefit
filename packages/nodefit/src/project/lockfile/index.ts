import { join } from "node:path";
import type { DirectDependency, LockedPackage, LockfileKind, PackageManager } from "../../types";
import { isFile, readText } from "../files";
import { parseBunLock } from "./bun";
import { parseNpmLock } from "./npm";
import { parsePnpmLock } from "./pnpm";
import { isBerryLock, parseYarnLock } from "./yarn";

export interface FoundLockfile {
  kind: LockfileKind;
  path: string;
  manager: PackageManager;
}

/** Lockfile names per package manager, in the order that manager prefers them. */
const LOCKFILES: Record<PackageManager, string[]> = {
  bun: ["bun.lock", "bun.lockb"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  npm: ["npm-shrinkwrap.json", "package-lock.json"],
};

/**
 * Without a `packageManager` field, the lockfile present decides, checked in
 * the order package-manager detectors (`ni`, corepack) use. A project that
 * has several is usually migrating; the newer tools' files come first.
 */
const PRESENCE_ORDER: PackageManager[] = ["bun", "pnpm", "yarn", "npm"];

/** "pnpm@9.12.0+sha512…" → "pnpm"; undefined for anything else. */
export function managerFromSpec(spec: string | undefined): PackageManager | undefined {
  const name = spec?.trim().split("@")[0];
  return name === "npm" || name === "bun" || name === "pnpm" || name === "yarn" ? name : undefined;
}

/** The lockfile the project's package manager would read, if there is one. */
export function findLockfile(root: string, declared: PackageManager | undefined): FoundLockfile | undefined {
  for (const manager of declared ? [declared] : PRESENCE_ORDER) {
    for (const name of LOCKFILES[manager]) {
      const path = join(root, name);
      if (isFile(path)) return { kind: kindOf(name, path), path, manager };
    }
  }
  // A declared manager with no lockfile of its own yet: still report the
  // one that exists, since it's what was installed last.
  return declared ? findLockfile(root, undefined) : undefined;
}

function kindOf(name: string, path: string): LockfileKind {
  if (name.startsWith("bun")) return "bun";
  if (name === "pnpm-lock.yaml") return "pnpm";
  if (name === "yarn.lock") return isBerryLock(readText(path) ?? "") ? "yarn-berry" : "yarn-classic";
  return "npm";
}

/**
 * Every registry package the lockfile installs. bun.lockb is binary and
 * can't be read; it yields nothing, and the analyzer suggests
 * `bun install --save-text-lockfile`. Throws when the file is corrupt.
 */
export function readLockfile(lock: FoundLockfile, direct: DirectDependency[]): LockedPackage[] {
  if (lock.path.endsWith(".lockb")) return [];
  const text = readText(lock.path);
  if (text === undefined) return [];
  try {
    switch (lock.kind) {
      case "npm":
        return parseNpmLock(text);
      case "bun":
        return parseBunLock(text);
      case "pnpm":
        return parsePnpmLock(text);
      case "yarn-classic":
      case "yarn-berry":
        return parseYarnLock(text, direct);
    }
  } catch (e) {
    throw new Error(`can't read ${lock.path}: ${(e as Error).message}`);
  }
}

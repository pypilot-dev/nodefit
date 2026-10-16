import type { LockedPackage } from "../../types";
import { enginesObject, isRecord, stringList, stringMap } from "../files";
import { compact, dedupe, edgeMap, isRegistryVersion } from "./graph";

/**
 * package-lock.json / npm-shrinkwrap.json. v2 and v3 have a flat `packages`
 * map keyed by install path with dev/optional flags already computed; v1
 * (npm 5–6) only has the nested `dependencies` tree.
 */
export function parseNpmLock(text: string): LockedPackage[] {
  const doc: unknown = JSON.parse(text);
  if (!isRecord(doc)) throw new Error("not a JSON object");
  if (isRecord(doc.packages)) return fromPackages(doc.packages);
  if (isRecord(doc.dependencies)) return dedupe(fromTree(doc.dependencies, ""));
  return [];
}

function fromPackages(packages: Record<string, unknown>): LockedPackage[] {
  const out: LockedPackage[] = [];
  for (const [path, raw] of Object.entries(packages)) {
    // "" is the root project; keys outside node_modules are workspace and
    // file: package sources, which reach node_modules only as links.
    if (!isRecord(raw) || !path.includes("node_modules/") || raw.link === true) continue;
    const version = typeof raw.version === "string" ? raw.version : undefined;
    if (!isRegistryVersion(version) || !fromRegistry(raw.resolved)) continue;
    const name = typeof raw.name === "string" ? raw.name : nameFromPath(path);
    out.push(
      compact({
        name,
        version,
        path,
        // devOptional means "needed by a dev dependency, or optionally in
        // production": neither flag alone describes it, so report it as needed.
        dev: raw.dev === true ? true : undefined,
        optional: raw.optional === true ? true : undefined,
        engines: enginesObject(raw.engines),
        hasInstallScript: raw.hasInstallScript === true ? true : undefined,
        os: stringList(raw.os),
        cpu: stringList(raw.cpu),
        dependencies: edgeMap(stringMap(raw.dependencies), stringMap(raw.optionalDependencies)),
      }),
    );
  }
  return dedupe(out);
}

function fromTree(deps: Record<string, unknown>, parent: string): LockedPackage[] {
  const out: LockedPackage[] = [];
  for (const [key, raw] of Object.entries(deps)) {
    if (!isRecord(raw)) continue;
    const path = `${parent}node_modules/${key}`;
    // v1 writes aliases as "npm:real@1.2.3" and git/file packages as their spec.
    let name = key;
    let version = typeof raw.version === "string" ? raw.version : undefined;
    const alias = version?.startsWith("npm:") ? /^npm:(@?[^@]+)@(.+)$/.exec(version) : null;
    if (alias?.[1] && alias[2]) [name, version] = [alias[1], alias[2]];
    if (isRegistryVersion(version) && fromRegistry(raw.resolved)) {
      out.push(
        compact({
          name,
          version,
          path,
          dev: raw.dev === true ? true : undefined,
          optional: raw.optional === true ? true : undefined,
          dependencies: stringMap(raw.requires),
        }),
      );
    }
    if (isRecord(raw.dependencies)) out.push(...fromTree(raw.dependencies, `${path}/`));
  }
  return out;
}

/** Registry tarballs are http(s) URLs; git+ssh://, file: and the like are not. */
function fromRegistry(resolved: unknown): boolean {
  return typeof resolved !== "string" || /^https?:\/\//.test(resolved);
}

function nameFromPath(path: string): string {
  return path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
}

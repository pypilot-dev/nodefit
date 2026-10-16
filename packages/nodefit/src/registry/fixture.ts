import type { Packument, RegistrySource, VersionMeta } from "../types";
import { NotFoundError } from "../types";

/**
 * An in-memory registry for tests: no network, ever. Register packuments
 * (abbreviated) and, where a test needs them, full version documents.
 */
export class FixtureRegistry implements RegistrySource {
  private readonly packuments = new Map<string, Packument>();
  private readonly full = new Map<string, VersionMeta>();

  addPackument(doc: Packument): this {
    this.packuments.set(doc.name, doc);
    return this;
  }

  /** Shorthand: a package whose versions are given as metadata objects. */
  add(name: string, versions: Omit<VersionMeta, "name">[], latest?: string): this {
    const byVersion: Record<string, VersionMeta> = {};
    for (const v of versions) byVersion[v.version] = { name, ...v };
    const newest = latest ?? versions[versions.length - 1]?.version ?? "0.0.0";
    return this.addPackument({ name, "dist-tags": { latest: newest }, versions: byVersion });
  }

  addFull(meta: VersionMeta): this {
    this.full.set(`${meta.name}@${meta.version}`, meta);
    return this;
  }

  async packument(name: string): Promise<Packument> {
    const doc = this.packuments.get(name);
    if (!doc) throw new NotFoundError(`\`${name}\``);
    return doc;
  }

  async fullVersion(name: string, version: string): Promise<VersionMeta> {
    const doc = this.full.get(`${name}@${version}`) ?? this.packuments.get(name)?.versions[version];
    if (!doc) throw new NotFoundError(`\`${name}@${version}\``);
    return doc;
  }
}

import { JsonCache } from "../cache";
import { createHttpClient } from "../http";
import type { HttpClient, Packument, RegistrySource, VersionMeta } from "../types";
import { NotFoundError } from "../types";

const DAY = 24 * 60 * 60 * 1000;

/**
 * The npm registry, disk-cached.
 *
 * Packuments use the abbreviated "corgi" format, which carries `engines`,
 * `hasInstallScript`, `os` and `cpu` for every version at a fraction of the
 * full document's size. Cached for a day; when the registry is unreachable an
 * older copy is used rather than giving up. Full single-version documents
 * (scripts, gypfile, binary) never change once published and are cached
 * forever.
 */
export class Registry implements RegistrySource {
  private readonly memo = new Map<string, Promise<Packument>>();

  constructor(
    private readonly http: HttpClient = createHttpClient(),
    private readonly cache: JsonCache = new JsonCache(),
    private readonly baseUrl: string = process.env.NODEFIT_REGISTRY ?? "https://registry.npmjs.org",
  ) {}

  packument(name: string): Promise<Packument> {
    let pending = this.memo.get(name);
    if (!pending) {
      pending = this.loadPackument(name);
      // A failure must not stick for the life of a language server.
      pending.catch(() => this.memo.delete(name));
      this.memo.set(name, pending);
    }
    return pending;
  }

  private async loadPackument(name: string): Promise<Packument> {
    const key = `packument/${name}`;
    const fresh = this.cache.get<Packument>(key, DAY);
    if (fresh) return fresh;
    try {
      const doc = await this.http.getJson<Packument>(`${this.baseUrl}/${encodeName(name)}`, {
        accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8",
      });
      this.cache.set(key, doc);
      return doc;
    } catch (err) {
      if (err instanceof NotFoundError) throw new NotFoundError(`\`${name}\``);
      const stale = this.cache.get<Packument>(key);
      if (stale) return stale;
      throw err;
    }
  }

  async fullVersion(name: string, version: string): Promise<VersionMeta> {
    const key = `version/${name}@${version}`;
    const cached = this.cache.get<VersionMeta>(key);
    if (cached) return cached;
    try {
      const doc = await this.http.getJson<VersionMeta>(
        `${this.baseUrl}/${encodeName(name)}/${encodeURIComponent(version)}`,
      );
      this.cache.set(key, doc);
      return doc;
    } catch (err) {
      if (err instanceof NotFoundError) throw new NotFoundError(`\`${name}@${version}\``);
      throw err;
    }
  }
}

/** `@scope/name` must keep its `@` but encode the `/`. */
function encodeName(name: string): string {
  return name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * nodefit's cache directory. `NODEFIT_CACHE_DIR` overrides it (tests use a
 * temporary one); otherwise the platform's usual cache location.
 */
export function cacheDir(): string {
  const override = process.env.NODEFIT_CACHE_DIR;
  if (override) return override;
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "nodefit", "cache");
  }
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "nodefit");
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "nodefit");
}

/** A JSON file cache with a time-to-live. Failures to read or write are ignored. */
export class JsonCache {
  constructor(private readonly dir: string = cacheDir()) {}

  private path(key: string): string {
    // Scoped names and versions are safe once "/" and ":" are replaced.
    return join(this.dir, `${key.replace(/[/:\\]/g, "__")}.json`);
  }

  /** The cached value, if younger than `maxAgeMs` (any age when omitted). */
  get<T>(key: string, maxAgeMs?: number): T | undefined {
    const file = this.path(key);
    try {
      if (maxAgeMs !== undefined && Date.now() - statSync(file).mtimeMs > maxAgeMs) return undefined;
      return JSON.parse(readFileSync(file, "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  set(key: string, value: unknown): void {
    const file = this.path(key);
    try {
      mkdirSync(dirname(file), { recursive: true });
      // Write then rename, so a concurrent reader never sees half a file.
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(value));
      renameSync(tmp, file);
    } catch {
      // A read-only or full disk only costs a refetch next time.
    }
  }
}

import type { HttpClient } from "./types";
import { NotFoundError } from "./types";
import { VERSION } from "./version";

const USER_AGENT = `nodefit/${VERSION} (+https://github.com/pypilot-dev/nodefit)`;

export class HttpError extends Error {
  constructor(
    public readonly url: string,
    public readonly status: number,
  ) {
    super(`${url} returned HTTP ${status}`);
    this.name = "HttpError";
  }
}

/** fetch() with a timeout and nodefit's user agent. */
export function createHttpClient(opts: { timeoutMs?: number; headers?: Record<string, string> } = {}): HttpClient {
  const timeoutMs = opts.timeoutMs ?? 15_000;

  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    return fetch(url, {
      ...init,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": USER_AGENT, ...opts.headers, ...(init.headers as Record<string, string>) },
    });
  }

  async function ok(url: string, init?: RequestInit): Promise<Response> {
    const res = await request(url, init);
    if (res.status === 404 || res.status === 410) throw new NotFoundError(url);
    if (!res.ok) throw new HttpError(url, res.status);
    return res;
  }

  return {
    async getJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
      return (await (await ok(url, { headers: { accept: "application/json", ...headers } })).json()) as T;
    },
    async getText(url: string): Promise<string> {
      return (await ok(url)).text();
    },
    async exists(url: string): Promise<boolean> {
      // Some hosts (GitHub release assets) answer HEAD; fall back to GET
      // for those that reject it.
      let res = await request(url, { method: "HEAD" });
      if (res.status === 405 || res.status === 403) res = await request(url);
      if (res.ok) return true;
      if (res.status === 404 || res.status === 410) return false;
      throw new HttpError(url, res.status);
    },
  };
}

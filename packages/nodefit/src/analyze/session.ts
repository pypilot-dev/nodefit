import { JsonCache } from "../cache";
import { createHttpClient } from "../http";
import { loadNodeIndex } from "../node";
import { currentPlatform } from "../platform";
import { probeNodeEnv, readProject } from "../project";
import { Registry } from "../registry/client";
import type { HttpClient } from "../types";
import type { AnalyzeOptions } from "./index";

export interface SessionOptions {
  /** Never touch the network: cached registry documents and Node releases only. */
  offline?: boolean;
  http?: HttpClient;
}

/** What `check` needs: everything but a project. */
export async function loadEnvironment(opts: SessionOptions = {}): Promise<Omit<AnalyzeOptions, "project">> {
  const http = opts.offline ? offlineHttp() : (opts.http ?? createHttpClient());
  const [index, env] = await Promise.all([loadNodeIndex({ http, offline: opts.offline ?? false }), probeNodeEnv()]);
  return { index, env, http, registry: new Registry(http, new JsonCache()), platform: currentPlatform() };
}

/** The real inputs for analyzing the project at `root`, read in parallel. */
export async function loadInputs(root: string, opts: SessionOptions = {}): Promise<AnalyzeOptions> {
  const [project, environment] = await Promise.all([readProject(root), loadEnvironment(opts)]);
  return { ...environment, project };
}

/**
 * Fails every request, so the registry client falls back to its cache at
 * any age and the native check reports what it cannot see.
 */
function offlineHttp(): HttpClient {
  const refuse = async (url: string): Promise<never> => {
    throw new Error(`offline: not fetching ${url}`);
  };
  return { getJson: refuse, getText: refuse, exists: refuse };
}

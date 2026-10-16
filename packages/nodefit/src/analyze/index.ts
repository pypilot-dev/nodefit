/**
 * Intersects everything into a Report.
 *
 * OWNER: the analyze/CLI/LSP work package. This file fixes the exported API.
 */

import type { HttpClient, NodeEnvironment, NodeIndex, Platform, ProjectInfo, RegistrySource, Report } from "../types";

export interface AnalyzeOptions {
  project: ProjectInfo;
  env: NodeEnvironment;
  index: NodeIndex;
  registry: RegistrySource;
  http: HttpClient;
  platform: Platform;
  /** Include packages only dev dependencies need (default true). */
  includeDev?: boolean;
}

export async function analyze(_opts: AnalyzeOptions): Promise<Report> {
  throw new Error("not implemented");
}

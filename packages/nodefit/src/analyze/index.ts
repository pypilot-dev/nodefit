/**
 * Intersects everything into a Report.
 *
 * OWNER: the analyze/CLI/LSP work package. This file fixes the exported API.
 */

import type {
  HttpClient,
  NativeContext,
  NativeVerdict,
  NodeEnvironment,
  NodeIndex,
  Platform,
  ProjectInfo,
  RegistrySource,
  Report,
  VersionMeta,
} from "../types";

export interface AnalyzeOptions {
  project: ProjectInfo;
  env: NodeEnvironment;
  index: NodeIndex;
  registry: RegistrySource;
  http: HttpClient;
  platform: Platform;
  /** Include packages only dev dependencies need (default true). */
  includeDev?: boolean;
  /** The native-module check; tests inject a fake. Defaults to native/analyzeNative. */
  native?: (meta: VersionMeta, ctx: NativeContext) => Promise<NativeVerdict>;
}

export async function analyze(_opts: AnalyzeOptions): Promise<Report> {
  throw new Error("not implemented");
}

/** nodefit's library API. */

export { type AnalyzeOptions, analyze } from "./analyze";
export { type CheckOutcome, checkPackage, parseCheckSpec } from "./analyze/check";
export { loadEnvironment, loadInputs, type SessionOptions } from "./analyze/session";
export { formatCheck, formatDoctor } from "./cli/doctor";
export { toJson } from "./cli/json";
export { createHttpClient } from "./http";
export { reportToDiagnostics } from "./lsp/diagnostics";
export { checkToMarkdown, reportToMarkdown } from "./lsp/markdown";
export { statusFor } from "./lsp/status";
export { analyzeNative } from "./native";
export { findRelease, loadNodeIndex, NodeSet, resolveNodeSpec } from "./node";
export { currentPlatform, platformLabel } from "./platform";
export { probeNodeEnv, readProject, writePin } from "./project";
export * from "./protocol";
export { Registry } from "./registry/client";
export * from "./types";
export { VERSION } from "./version";

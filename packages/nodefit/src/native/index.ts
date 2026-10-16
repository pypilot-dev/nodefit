/**
 * Does a package need a native binary, and for which Node releases is one
 * prebuilt for this platform?
 *
 * OWNER: the native work package. This file fixes the exported API.
 */

import type { NativeContext, NativeVerdict, VersionMeta } from "../types";

/**
 * Classify `meta` (abbreviated metadata; fetch the full document or the file
 * list only when needed) and report which releases have a prebuilt binary
 * for `ctx.platform`. Never throws for a lookup failure: a verdict of kind
 * "unknown" with the reason in `detail` instead.
 */
export async function analyzeNative(_meta: VersionMeta, _ctx: NativeContext): Promise<NativeVerdict> {
  throw new Error("not implemented");
}

/** Cheap screen: could this package carry native code? (no network) */
export function mayBeNative(meta: VersionMeta): boolean {
  return Boolean(meta.hasInstallScript || meta.gypfile || meta.binary || meta.optionalDependencies);
}

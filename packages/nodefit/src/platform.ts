import type { Platform } from "./types";

/** The platform nodefit runs on: the one whose binaries matter. */
export function currentPlatform(): Platform {
  const platform: Platform = { os: process.platform, arch: process.arch };
  if (process.platform === "linux") platform.libc = detectLibc();
  return platform;
}

/**
 * glibc or musl. Node's diagnostic report names the glibc version it runs
 * on (`header.glibcVersionRuntime`); musl builds have no such field.
 */
function detectLibc(): "glibc" | "musl" {
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    return report?.header?.glibcVersionRuntime ? "glibc" : "musl";
  } catch {
    return "glibc";
  }
}

/** "win32-x64", "linux-x64-musl": how prebuilt binaries name platforms. */
export function platformLabel(p: Platform): string {
  return p.libc === "musl" ? `${p.os}-${p.arch}-musl` : `${p.os}-${p.arch}`;
}

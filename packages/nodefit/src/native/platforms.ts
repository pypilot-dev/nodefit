import type { Platform } from "../types";

/**
 * npm's reading of an `os`/`cpu`/`libc` list (npm-install-checks): entries
 * may be negated with "!", and a list of only negations allows everything
 * else.
 */
export function listAllows(list: string[] | string | undefined, value: string | undefined): boolean {
  if (list === undefined) return true;
  const entries = typeof list === "string" ? [list] : list;
  if (entries.length === 0 || (entries.length === 1 && entries[0] === "any")) return true;
  let negated = 0;
  let match = false;
  for (const entry of entries) {
    if (entry.startsWith("!")) {
      negated++;
      if (entry.slice(1) === value) return false;
    } else if (entry === value) {
      match = true;
    }
  }
  return match || negated === entries.length;
}

/** The C library as npm compares it: only Linux has one. */
export function libcOf(platform: Platform): "glibc" | "musl" | undefined {
  return platform.os === "linux" ? (platform.libc ?? "glibc") : undefined;
}

/** Would npm install a package with these fields on `platform`? */
export function installsOn(fields: { os?: string[]; cpu?: string[]; libc?: string[] }, platform: Platform): boolean {
  if (!listAllows(fields.os, platform.os) || !listAllows(fields.cpu, platform.arch)) return false;
  // npm treats a libc list as unsatisfiable off Linux.
  if (fields.libc !== undefined) return listAllows(fields.libc, libcOf(platform));
  return true;
}

const OS_WORDS: Record<string, string[]> = {
  win32: ["win32", "windows", "win"],
  darwin: ["darwin", "macos", "mac", "osx", "apple"],
  linux: ["linux", "linuxmusl"],
  freebsd: ["freebsd"],
  openbsd: ["openbsd"],
  netbsd: ["netbsd"],
  sunos: ["sunos", "solaris"],
  aix: ["aix"],
  android: ["android"],
  openharmony: ["openharmony"],
};

const ARCH_WORDS: Record<string, string[]> = {
  x64: ["x64", "amd64", "x86_64"],
  arm64: ["arm64", "aarch64", "armv8"],
  ia32: ["ia32", "x86", "i386", "i686"],
  arm: ["arm", "armv6", "armv7", "armv7l", "gnueabihf", "eabihf"],
  ppc64: ["ppc64", "ppc64le"],
  s390x: ["s390x"],
  riscv64: ["riscv64"],
  loong64: ["loong64", "loongarch64"],
  mips64el: ["mips64el"],
};

const ALL_OS_WORDS = new Set(Object.values(OS_WORDS).flat());
const ALL_ARCH_WORDS = new Set([...Object.values(ARCH_WORDS).flat(), "universal"]);

/** Words of a package name or path: "@img/sharp-linuxmusl-x64" → img, sharp, linuxmusl, x64. */
export function words(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[-_/@.+]+/)
    .filter(Boolean);
}

/** Does this name mention any operating system, as per-platform package names do? */
export function namesAnOs(name: string): boolean {
  return words(name).some((w) => ALL_OS_WORDS.has(w));
}

export function namesThisOs(name: string, platform: Platform): boolean {
  const ours = OS_WORDS[platform.os] ?? [platform.os];
  return words(name).some((w) => ours.includes(w));
}

/**
 * False only when the name mentions an architecture and it is not ours.
 * Names that mention none (or "universal") stay candidates.
 */
export function mayNameThisArch(name: string, platform: Platform): boolean {
  const ws = words(name);
  const named = ws.filter((w) => ALL_ARCH_WORDS.has(w));
  if (named.length === 0 || named.includes("universal")) return true;
  const ours = ARCH_WORDS[platform.arch] ?? [platform.arch];
  return named.some((w) => ours.includes(w));
}

/** The C library a package name implies ("…-linux-x64-musl", "…-linux-x64-gnu"), if any. */
export function libcFromName(name: string): "glibc" | "musl" | undefined {
  const ws = words(name);
  if (ws.some((w) => w === "musl" || w === "linuxmusl")) return "musl";
  if (ws.some((w) => w === "gnu" || w === "glibc" || w === "gnueabihf")) return "glibc";
  return undefined;
}

/**
 * What a compile from source needs on each OS: the text the user acts on
 * when no prebuilt binary fits.
 */
export function compilerNeeds(platform: Platform): string {
  switch (platform.os) {
    case "win32":
      return 'Python and Visual Studio Build Tools with the "Desktop development with C++" workload';
    case "darwin":
      return "the Xcode Command Line Tools (xcode-select --install)";
    case "linux":
      return platform.libc === "musl" ? "python3, make and g++ (apk add build-base python3)" : "python3, make and g++";
    default:
      return "Python, make and a C++ compiler";
  }
}

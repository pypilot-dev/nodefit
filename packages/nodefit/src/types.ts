/**
 * The contract between nodefit's modules.
 *
 *   node/      Node.js releases and sets of them (NodeSet)
 *   registry/  npm registry metadata, disk-cached
 *   native/    does a package need a native binary, and for which Node
 *              versions is one prebuilt for this platform?
 *   project/   what the project declares, locks and pins, and which Node runs it
 *   analyze/   intersects all of the above into a Report
 *   cli/, lsp/ present a Report
 *
 * The idea is PyPilot's, applied to Node: every dependency narrows the set of
 * Node versions the project can run on (its `engines.node` range, and for a
 * native module the Node ABIs it ships prebuilt binaries for). The project
 * fits the intersection; when that is empty, name the packages that clash.
 */

// --------------------------------------------------------------------------
// Platform

/** `process.platform` / `process.arch` values, plus the C library on Linux. */
export interface Platform {
  os: NodeJS.Platform;
  arch: NodeJS.Architecture;
  /** Linux only: musl (Alpine) and glibc need different binaries. */
  libc?: "glibc" | "musl";
}

// --------------------------------------------------------------------------
// Node releases (node/)

export interface NodeRelease {
  /** Without the leading `v`: "22.11.0". */
  version: string;
  major: number;
  /** `process.versions.modules`, the ABI a non-N-API addon is built for. */
  abi: number;
  /** Highest N-API version this release supports, when known. */
  napi?: number;
  /** LTS codename ("Jod") or false. */
  lts: string | false;
  /** Release date, YYYY-MM-DD. */
  date: string;
  /** End of life of this release's major line, YYYY-MM-DD, when known. */
  eol?: string;
}

export interface NodeIndex {
  /** Newest first, final releases only (no nightlies or RCs). */
  releases: NodeRelease[];
  source: "network" | "cache" | "bundled";
  fetchedAt: string;
}

/**
 * A set of Node releases. Immutable: every operation returns a new set.
 * Implemented by `NodeSet` in node/set.ts.
 */
export interface NodeVersionSet {
  readonly size: number;
  isEmpty(): boolean;
  has(version: string): boolean;
  intersect(other: NodeVersionSet): NodeVersionSet;
  union(other: NodeVersionSet): NodeVersionSet;
  /** Members, newest first. */
  releases(): NodeRelease[];
  newest(): NodeRelease | undefined;
  /** Newest member on an LTS line, else undefined. */
  newestLts(): NodeRelease | undefined;
  /** Short human form, e.g. "20.9–20.19, 22, 24" or "none". */
  toString(): string;
}

// --------------------------------------------------------------------------
// npm registry (registry/)

/** One published version, as the registry's abbreviated document has it. */
export interface VersionMeta {
  name: string;
  version: string;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  os?: string[];
  cpu?: string[];
  libc?: string[];
  /** Set when the package has preinstall/install/postinstall scripts or a binding.gyp. */
  hasInstallScript?: boolean;
  deprecated?: string;
  dist?: { tarball: string; integrity?: string; unpackedSize?: number };
  // Present only in the full document (see `Registry.fullVersion`):
  scripts?: Record<string, string>;
  gypfile?: boolean;
  /** node-pre-gyp / prebuild configuration. */
  binary?: Record<string, unknown>;
  repository?: string | { type?: string; url?: string; directory?: string };
}

export interface Packument {
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, VersionMeta>;
  /** Publish times by version (full document only). */
  time?: Record<string, string>;
}

/** Anything that can answer registry questions; tests inject fixtures. */
export interface RegistrySource {
  /** Abbreviated packument (fast, cached). Throws NotFoundError for unknown names. */
  packument(name: string): Promise<Packument>;
  /** Full metadata for one version: scripts, gypfile, binary, repository. */
  fullVersion(name: string, version: string): Promise<VersionMeta>;
}

export class NotFoundError extends Error {
  constructor(public readonly what: string) {
    super(`${what} is not on the npm registry; check the spelling`);
    this.name = "NotFoundError";
  }
}

// --------------------------------------------------------------------------
// Native modules (native/)

export type NativeKind =
  /** Plain JavaScript. */
  | "none"
  /** Per-platform packages in optionalDependencies (sharp/@img, esbuild, @swc/core, napi-rs). */
  | "platform-packages"
  /** Prebuilt binaries inside the tarball under prebuilds/ (prebuildify + node-gyp-build). */
  | "bundled-prebuilds"
  /** Binaries downloaded at install time from GitHub releases (prebuild-install). */
  | "prebuild-install"
  /** Binaries downloaded at install time from a host in `binary` (node-pre-gyp). */
  | "node-pre-gyp"
  /** A binding.gyp and no prebuilt binaries: always compiled with node-gyp. */
  | "source-only"
  /** An install script nodefit cannot classify. */
  | "unknown";

export interface NativeVerdict {
  kind: NativeKind;
  /**
   * Node releases with a prebuilt binary for the platform. `"all"` when the
   * binary does not depend on the Node version (N-API builds, or no native
   * code). For "source-only", the releases node-gyp can build for (usually all).
   */
  prebuilt: NodeVersionSet | "all";
  /** True when a missing prebuilt binary makes the install compile from source. */
  fallsBackToSource: boolean;
  /** One sentence for the user, naming the evidence. */
  detail: string;
  /** URLs or file names that support the verdict. */
  evidence?: string[];
}

/** What native/ needs to reach its sources. */
export interface NativeContext {
  registry: RegistrySource;
  index: NodeIndex;
  platform: Platform;
  /** fetch() with a timeout and nodefit's user agent (see http.ts). */
  http: HttpClient;
}

export interface HttpClient {
  getJson<T>(url: string, headers?: Record<string, string>): Promise<T>;
  getText(url: string): Promise<string>;
  /** True for 2xx (after redirects), false for 404/410. Throws on network errors. */
  exists(url: string): Promise<boolean>;
}

// --------------------------------------------------------------------------
// Project (project/)

export type DependencyKind = "prod" | "dev" | "optional" | "peer";

export interface DirectDependency {
  name: string;
  /** The range as written in package.json. */
  range: string;
  kind: DependencyKind;
}

/** A package as a lockfile records it. */
export interface LockedPackage {
  name: string;
  version: string;
  /** Install path in node_modules, when the lockfile has one. */
  path?: string;
  /** True for packages only a dev dependency pulls in. */
  dev?: boolean;
  optional?: boolean;
  // package-lock.json v2/v3 records these, sparing a registry lookup:
  engines?: Record<string, string>;
  hasInstallScript?: boolean;
  os?: string[];
  cpu?: string[];
  /**
   * What this package depends on, name → range (or resolved version), as the
   * lockfile records it. Lets the analyzer trace a transitive package back to
   * the direct dependency that pulls it in.
   */
  dependencies?: Record<string, string>;
}

export type LockfileKind = "npm" | "bun" | "pnpm" | "yarn-classic" | "yarn-berry";

export type PinSource =
  | ".nvmrc"
  | ".node-version"
  | ".tool-versions"
  | "mise.toml"
  | "volta"
  | "engines"
  | "devEngines";

/** A place the project states which Node it wants. */
export interface NodePin {
  source: PinSource;
  /** Absolute path of the file holding it. */
  file: string;
  /** As written: "22", "lts/jod", ">=20.9.0", "22.11.0". */
  value: string;
  /** Exact pins (.nvmrc, volta…) select one Node; ranges (engines) allow several. */
  exact: boolean;
}

export type PackageManager = "npm" | "bun" | "pnpm" | "yarn";

export interface ProjectInfo {
  root: string;
  name?: string;
  dependencies: DirectDependency[];
  lockfile?: { kind: LockfileKind; path: string };
  /** Every package the lockfile installs, deduplicated by name@version. */
  locked: LockedPackage[];
  pins: NodePin[];
  packageManager: PackageManager;
  /** From the `packageManager` field, e.g. "pnpm@9.12.0". */
  packageManagerSpec?: string;
  /** Workspace package directories, when this is a monorepo root. */
  workspaces: string[];
}

export type VersionManager = "nvm" | "nvm-windows" | "fnm" | "volta" | "mise" | "asdf" | "n";

export interface NodeEnvironment {
  /** The `node` on PATH, if any. */
  current?: { version: string; path: string };
  /** Version managers found on this machine. */
  managers: VersionManager[];
  /** Node versions those managers have installed locally. */
  installed: string[];
}

// --------------------------------------------------------------------------
// Analysis (analyze/)

export interface PackageReport {
  name: string;
  version: string;
  /** Declared directly in package.json (vs. pulled in by another package). */
  direct: boolean;
  /** Only a dev dependency needs it. */
  dev: boolean;
  /** The chain that pulls it in, for transitive packages: ["sqlite3", "node-gyp"]. */
  via?: string[];
  engines?: string;
  /** Releases its `engines.node` allows (all when it has none). */
  enginesSet: NodeVersionSet;
  native?: NativeVerdict;
  /** Releases on which it installs and runs here: engines ∩ prebuilt. */
  supported: NodeVersionSet;
}

export type Severity = "error" | "warning" | "info";

export type Fix =
  /** Write `version` into the project's pin file (creating .nvmrc if none). */
  | { kind: "pin-node"; version: string }
  /** Switch this machine to `version` with the detected version manager. */
  | { kind: "use-node"; version: string; command?: string }
  /** Move a dependency to a version that fits. */
  | { kind: "change-dependency"; name: string; range: string };

export interface Finding {
  /** Stable id for tests and for de-duplicating notifications. */
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  /** Packages it is about; editors attach diagnostics to their entries. */
  packages?: string[];
  fix?: Fix;
}

export interface Conflict {
  a: { name: string; version: string; supported: string };
  b: { name: string; version: string; supported: string };
}

export interface Report {
  root: string;
  platform: Platform;
  index: { newest: string; source: NodeIndex["source"] };
  env: NodeEnvironment;
  project: ProjectInfo;
  packages: PackageReport[];
  /** Releases every package supports. */
  supported: NodeVersionSet;
  /** The release nodefit recommends (newest LTS in `supported`, else newest). */
  recommended?: NodeRelease;
  conflicts: Conflict[];
  /** Packages that could not be looked up, with the reason. */
  unresolved: { name: string; reason: string }[];
  findings: Finding[];
}

import pkg from "../package.json" with { type: "json" };

/** nodefit's own version, from package.json (bundled at build time). */
export const VERSION: string = pkg.version;

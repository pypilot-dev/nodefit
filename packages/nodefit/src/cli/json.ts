import type { NodeVersionSet } from "../types";

/**
 * A Report (or check outcome) as JSON. Sets of releases become their short
 * form plus the full list, so scripts can test membership without
 * re-implementing semver.
 */
export function toJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v) => (isSet(v) ? { summary: v.toString(), versions: v.releases().map((r) => r.version) } : v),
    2,
  );
}

function isSet(v: unknown): v is NodeVersionSet {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as NodeVersionSet).releases === "function" &&
    typeof (v as NodeVersionSet).intersect === "function"
  );
}

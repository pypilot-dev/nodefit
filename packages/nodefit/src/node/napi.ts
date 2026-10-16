/**
 * Node-API versions by release.
 *
 * index.json has no N-API column, so this restates Node's version matrix
 * (https://nodejs.org/api/n-api.html#node-api-version-matrix): for each
 * N-API version, the first release on each line that has it. The last entry
 * of a row also covers every later line, which is how the matrix words it
 * ("16.0.0 and all later versions"), so a line newer than this table gets
 * the highest version listed until the table is updated.
 *
 * Releases where N-API was experimental (6.14.2, 8.x before 8.11.2, 9.x)
 * are included: they report `process.versions.napi`, and prebuilt N-API
 * binaries load there, which is what the number is used for.
 */
const MATRIX: [napi: number, firstReleases: string[]][] = [
  [10, ["22.14.0", "23.6.0"]],
  [9, ["18.17.0", "20.3.0", "21.0.0"]],
  [8, ["12.22.0", "14.17.0", "15.12.0", "16.0.0"]],
  [7, ["10.23.0", "12.19.0", "14.12.0", "15.0.0"]],
  [6, ["10.20.0", "12.17.0", "14.0.0"]],
  [5, ["10.17.0", "12.11.0", "13.0.0"]],
  [4, ["10.16.0", "11.8.0", "12.0.0"]],
  [3, ["6.14.2", "8.11.2", "9.11.0", "10.0.0"]],
  [2, ["8.10.0", "9.3.0", "10.0.0"]],
  [1, ["8.6.0", "9.0.0", "10.0.0"]],
];

const PARSED = MATRIX.map(([napi, firsts]) => [napi, firsts.map(parse)] as const);

/** The highest N-API version `version` ("22.11.0") supports, or undefined before N-API existed. */
export function napiVersion(version: string): number | undefined {
  const v = parse(version);
  for (const [napi, firsts] of PARSED) {
    const last = firsts[firsts.length - 1];
    for (const first of firsts) {
      if (v[0] === first[0] ? compare(v, first) >= 0 : first === last && v[0] > first[0]) return napi;
    }
  }
  return undefined;
}

function parse(version: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = version.trim().replace(/^v/, "").split(".").map(Number);
  return [major, minor, patch];
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

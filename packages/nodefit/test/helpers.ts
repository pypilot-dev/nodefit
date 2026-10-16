import type { NodeIndex, NodeRelease } from "../src/types";

/**
 * A small hand-made index for tests: a few releases per line, with the real
 * ABIs, N-API levels and LTS codenames of those lines.
 */
export function testIndex(): NodeIndex {
  const lines: [number, number, number, string | false, string[]][] = [
    // major, abi, napi, lts, versions (oldest first)
    [16, 93, 8, "Gallium", ["16.0.0", "16.20.2"]],
    [18, 108, 9, "Hydrogen", ["18.0.0", "18.17.0", "18.20.4"]],
    [20, 115, 9, "Iron", ["20.0.0", "20.9.0", "20.18.0", "20.19.5"]],
    [21, 120, 9, false, ["21.0.0", "21.7.3"]],
    [22, 127, 10, "Jod", ["22.0.0", "22.11.0", "22.21.1"]],
    [23, 131, 10, false, ["23.0.0", "23.11.1"]],
    [24, 137, 10, "Krypton", ["24.0.0", "24.11.0"]],
  ];
  const releases: NodeRelease[] = [];
  for (const [major, abi, napi, lts, versions] of lines) {
    for (const [i, version] of versions.entries()) {
      // Lines become LTS some months in; treat the first release as Current.
      releases.push({ version, major, abi, napi, lts: i === 0 ? false : lts, date: `20${major}-01-01` });
    }
  }
  releases.reverse();
  return { releases, source: "bundled", fetchedAt: "2026-10-16T00:00:00Z" };
}

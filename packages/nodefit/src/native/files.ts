import { gunzipSync } from "node:zlib";
import type { HttpClient, VersionMeta } from "../types";

/** Downloads raw bytes; injectable so tests stay offline. */
export type FetchBytes = (url: string) => Promise<Uint8Array>;

/**
 * Tarballs nodefit is willing to download to list them when jsDelivr can't.
 * Packages with bundled binaries for many platforms run to tens of MB.
 */
export const MAX_TARBALL_UNPACKED = 32 * 1024 * 1024;

interface JsDelivrNode {
  type: "file" | "directory";
  name: string;
  files?: JsDelivrNode[];
}

export interface FileListing {
  /** Paths inside the package, without a leading "/" or "package/". */
  files: string[];
  source: string;
}

/**
 * The files a published version contains: jsDelivr's listing (one small JSON
 * request), else the tarball itself when it is small enough.
 */
export async function listPackageFiles(
  meta: VersionMeta,
  http: HttpClient,
  fetchBytes: FetchBytes,
): Promise<FileListing> {
  const url = `https://data.jsdelivr.com/v1/packages/npm/${meta.name}@${meta.version}`;
  let jsdelivrError: unknown;
  try {
    const doc = await http.getJson<{ files?: JsDelivrNode[] }>(url);
    if (Array.isArray(doc.files)) return { files: flatten(doc.files, ""), source: url };
    jsdelivrError = new Error("jsDelivr returned no file list");
  } catch (err) {
    jsdelivrError = err;
  }

  const tarball = meta.dist?.tarball;
  const size = meta.dist?.unpackedSize;
  if (!tarball || size === undefined || size > MAX_TARBALL_UNPACKED) throw jsdelivrError;
  try {
    return { files: listTarGz(await fetchBytes(tarball)), source: tarball };
  } catch {
    // jsDelivr's failure is the one worth reporting: the tarball was only
    // the fallback.
    throw jsdelivrError;
  }
}

function flatten(nodes: JsDelivrNode[], prefix: string): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    if (node.type === "directory") out.push(...flatten(node.files ?? [], path));
    else out.push(path);
  }
  return out;
}

/** Plain fetch(): HttpClient only speaks text and JSON. */
export const defaultFetchBytes: FetchBytes = async (url) => {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

/**
 * File names in a .tgz. Only the headers matter, so this is a minimal ustar
 * reader: GNU long names and pax `path` records are honoured because npm
 * packs long paths with them.
 */
export function listTarGz(gz: Uint8Array): string[] {
  const tar = gunzipSync(gz);
  const files: string[] = [];
  let offset = 0;
  let longName: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const size = Number.parseInt(cString(header.subarray(124, 136)).trim() || "0", 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    if (type === "L") {
      longName = cString(body);
      continue;
    }
    if (type === "x") {
      const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"));
      if (path?.[1]) longName = path[1];
      continue;
    }
    if (type === "g") continue;

    const prefix = cString(header.subarray(345, 500));
    const name =
      longName ?? (prefix ? `${prefix}/${cString(header.subarray(0, 100))}` : cString(header.subarray(0, 100)));
    longName = undefined;
    if (type === "0" || type === "\0" || type === "") files.push(name.replace(/^[^/]+\//, ""));
  }
  return files;
}

function cString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return Buffer.from(end === -1 ? bytes : bytes.subarray(0, end)).toString("utf8");
}

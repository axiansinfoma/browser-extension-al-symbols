import * as path from "path";
import * as fs from "fs";
import AdmZip from "adm-zip";

/** HTTP headers to attach to a feed request (e.g. Authorization for private feeds). */
export type Headers = Record<string, string>;

async function fetchWithTimeout(url: string, headers: Headers, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Version handling
//
// NuGet normalizes trailing-zero revisions away, so app.json "27.0.0.0" is
// published as "27.0.0" on the feed. We compare component-wise, padding any
// missing trailing component with 0, so the two forms compare equal.
// ---------------------------------------------------------------------------
function versionParts(v: string): number[] {
  return v.split(".").map((p) => parseInt(p, 10) || 0);
}

export function compareVersions(a: string, b: string): number {
  const pa = versionParts(a);
  const pb = versionParts(b);
  const len = Math.max(pa.length, pb.length, 4);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function versionGe(a: string, b: string): boolean {
  return compareVersions(a, b) >= 0;
}

export function versionMajor(v: string): number {
  return parseInt(v.split(".")[0], 10) || 0;
}

/**
 * Pick the highest available version that stays on the requested major line
 * and is >= the minimum (dependency versions are minimums in BC).
 */
export function pickVersion(versions: string[], major: number, min: string): string | undefined {
  const candidates = versions.filter((v) => versionMajor(v) === major && versionGe(v, min));
  if (candidates.length === 0) {
    return undefined;
  }
  candidates.sort(compareVersions);
  return candidates[candidates.length - 1];
}

// ---------------------------------------------------------------------------
// BC NuGet package id: strip only characters that are invalid in a NuGet id
// (keep '.', '_' and '-'), then lowercase for the flat2 URL path.
// ---------------------------------------------------------------------------
export function sanitizeIdPart(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "");
}

export function symbolPackageId(publisher: string, name: string, appId: string): string {
  return `${sanitizeIdPart(publisher)}.${sanitizeIdPart(name)}.symbols.${appId}`.toLowerCase();
}

export interface PackageSchemaParts {
  publisher: string;
  name: string;
  appId: string;
}

/**
 * A schema is only usable if it distinguishes one dependency package from
 * another, so at least one of {name} or {appId} must be present. {publisher}
 * on its own is not enough (many dependencies share a publisher).
 */
export function hasRequiredPackageSchemaPlaceholders(schema: string): boolean {
  const lower = schema.toLowerCase();
  return lower.includes("{name}") || lower.includes("{appid}");
}

/**
 * Apply a feed-provided package schema and sanitize resulting id parts.
 *
 * Placeholders:
 *  - {publisher}
 *  - {name}
 *  - {appId}
 */
export function applyPackageSchema(schema: string, parts: PackageSchemaParts): string {
  return schema
    .replace(/\{publisher\}/gi, sanitizeIdPart(parts.publisher))
    .replace(/\{name\}/gi, sanitizeIdPart(parts.name))
    .replace(/\{appid\}/gi, sanitizeIdPart(parts.appId))
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Feed operations (NuGet v3)
// ---------------------------------------------------------------------------

/** Resolve the flat2 (PackageBaseAddress) endpoint from a feed service index. */
export async function resolveFlatBase(indexUrl: string, headers: Headers): Promise<string> {
  const res = await fetchWithTimeout(indexUrl, headers, 30_000);
  if (!res.ok) {
    throw new Error(`feed index returned HTTP ${res.status}`);
  }
  const doc = (await res.json()) as { resources?: Array<{ "@type": string; "@id": string }> };
  const resource = doc.resources?.find((r) => r["@type"]?.startsWith("PackageBaseAddress"));
  if (!resource?.["@id"]) {
    throw new Error("feed does not advertise a PackageBaseAddress resource");
  }
  return resource["@id"].replace(/\/+$/, "");
}

/** List all published versions of a package, or [] if the package is not on this feed. */
export async function listVersions(flatBase: string, packageId: string, headers: Headers): Promise<string[]> {
  const res = await fetchWithTimeout(`${flatBase}/${packageId}/index.json`, headers, 60_000);
  if (res.status === 404) {
    return [];
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const doc = (await res.json()) as { versions?: string[] };
  return doc.versions ?? [];
}

/** Download a .nupkg and return its bytes. */
export async function downloadNupkg(
  flatBase: string,
  packageId: string,
  version: string,
  headers: Headers
): Promise<Buffer> {
  const url = `${flatBase}/${packageId}/${version}/${packageId}.${version}.nupkg`;
  const res = await fetchWithTimeout(url, headers, 300_000);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} downloading ${packageId} ${version}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Extract every *.app entry (they live at the root of a symbol nupkg) into outDir. */
export function extractApps(nupkg: Buffer, outDir: string): string[] {
  const zip = new AdmZip(nupkg);
  const written: string[] = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) {
      continue;
    }
    if (!entry.entryName.toLowerCase().endsWith(".app")) {
      continue;
    }
    const fileName = path.basename(entry.entryName);
    fs.writeFileSync(path.join(outDir, fileName), entry.getData());
    written.push(fileName);
  }
  return written;
}

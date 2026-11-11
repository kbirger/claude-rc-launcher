/** Version rules shared by the web version check. */

const KNOWN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Strips one leading `v`. */
export function normalizeVersion(v: string): string {
  return v.startsWith("v") ? v.slice(1) : v;
}

/** True only for `X.Y.Z` with an optional `-prerelease` and no `+`. */
export function isKnownVersion(v: string | undefined): v is string {
  return v !== undefined && KNOWN.test(v);
}

const LOCAL_BUILD = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\+[0-9A-Za-z.-]+$/;

/**
 * The release a version is, or is based on. A release (`X.Y.Z`, optionally `-prerelease`) is its own release. A local build
 * (`X.Y.Z+branch.sha`, the last tag plus build metadata) is based on its tag, and the build metadata does not count in
 * a comparison (semantic versioning ignores it). `dev` and anything else has none.
 */
export function releaseOf(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  return KNOWN.test(v) ? v : LOCAL_BUILD.exec(v)?.[1];
}

/** Compares one pre-release identifier list; numbers sort below text. */
function comparePre(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]);
    const nb = /^\d+$/.test(pb[i]);
    if (na && nb) {
      const d = Number(pa[i]) - Number(pb[i]);
      if (d !== 0) return d;
    } else if (na !== nb) {
      return na ? -1 : 1;
    } else if (pa[i] !== pb[i]) {
      return pa[i] < pb[i] ? -1 : 1;
    }
  }
  return 0;
}

/** Compares two known versions numerically; a pre-release is below its release. */
export function compareVersions(a: string, b: string): number {
  const ma = KNOWN.exec(a);
  const mb = KNOWN.exec(b);
  if (!ma || !mb) throw new Error(`unknown version: ${ma ? b : a}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return d;
  }
  if (ma[4] === undefined && mb[4] === undefined) return 0;
  if (ma[4] === undefined) return 1;
  if (mb[4] === undefined) return -1;
  return comparePre(ma[4], mb[4]);
}

/** True only when both versions have a release (see `releaseOf`) and the release of `current` is lower. */
export function isStale(current: string | undefined, target: string | undefined): boolean {
  const c = releaseOf(current);
  const t = releaseOf(target);
  return c !== undefined && t !== undefined && compareVersions(c, t) < 0;
}

/** The version with the lowest release, as it was given (a local build stays a local build), or undefined if none has a release. */
export function stalestVersion(versions: (string | undefined)[]): string | undefined {
  let lowest: string | undefined;
  for (const v of versions) {
    const r = releaseOf(v);
    if (v === undefined || r === undefined) continue;
    if (lowest === undefined || compareVersions(r, releaseOf(lowest)!) < 0) lowest = v;
  }
  return lowest;
}

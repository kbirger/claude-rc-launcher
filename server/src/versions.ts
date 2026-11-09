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

/** True only when both versions are known and `current` is lower. */
export function isStale(current: string | undefined, target: string | undefined): boolean {
  return isKnownVersion(current) && isKnownVersion(target) && compareVersions(current, target) < 0;
}

/** The lowest known version, or undefined if none is known. */
export function stalestVersion(versions: (string | undefined)[]): string | undefined {
  let lowest: string | undefined;
  for (const v of versions) {
    if (!isKnownVersion(v)) continue;
    if (lowest === undefined || compareVersions(v, lowest) < 0) lowest = v;
  }
  return lowest;
}

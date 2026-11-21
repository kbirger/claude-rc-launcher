/** Version rules shared by the web version check. */

const KNOWN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Strips one leading `v`. */
export function normalizeVersion(text: string): string {
  return text.startsWith("v") ? text.slice(1) : text;
}

/** True only for `X.Y.Z` with an optional `-prerelease` and no `+`. */
export function isKnownVersion(value: string | undefined): value is string {
  return value !== undefined && KNOWN.test(value);
}

const LOCAL_BUILD = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\+[0-9A-Za-z.-]+$/;

/**
 * The release a version is, or is based on. A release (`X.Y.Z`, optionally `-prerelease`) is its own release. A local build
 * (`X.Y.Z+branch.sha`, the last tag plus build metadata) is based on its tag, and the build metadata does not count in
 * a comparison (semantic versioning ignores it). `dev` and anything else has none.
 */
export function releaseOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return KNOWN.test(value) ? value : LOCAL_BUILD.exec(value)?.[1];
}

/** Compares one pre-release identifier list; numbers sort below text. */
function comparePre(left: string, right: string): number {
  const pa = left.split(".");
  const pb = right.split(".");

  for (let index = 0; index < Math.max(pa.length, pb.length); index++) {
    if (index >= pa.length) return -1;
    if (index >= pb.length) return 1;
    const na = /^\d+$/.test(pa[index]);
    const nb = /^\d+$/.test(pb[index]);

    if (na && nb) {
      const diff = Number(pa[index]) - Number(pb[index]);
      if (diff !== 0) return diff;
    } else if (na !== nb) {
      return na ? -1 : 1;
    } else if (pa[index] !== pb[index]) {
      return pa[index] < pb[index] ? -1 : 1;
    }
  }

  return 0;
}

/** Compares two known versions numerically; a pre-release is below its release. */
export function compareVersions(left: string, right: string): number {
  const ma = KNOWN.exec(left);
  const mb = KNOWN.exec(right);
  if (!ma || !mb) throw new Error(`unknown version: ${ma ? right : left}`);

  for (let index = 1; index <= 3; index++) {
    const diff = Number(ma[index]) - Number(mb[index]);
    if (diff !== 0) return diff;
  }

  const preA = ma.at(4);
  const preB = mb.at(4);
  if (preA === undefined && preB === undefined) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  return comparePre(preA, preB);
}

/** True only when both versions have a release (see `releaseOf`) and the release of `current` is lower. */
export function isStale(current: string | undefined, target: string | undefined): boolean {
  const currentRelease = releaseOf(current);
  const targetRelease = releaseOf(target);
  return (
    currentRelease !== undefined && targetRelease !== undefined && compareVersions(currentRelease, targetRelease) < 0
  );
}

/** The version with the lowest release, as it was given (a local build stays a local build), or undefined if none has a release. */
export function stalestVersion(versions: (string | undefined)[]): string | undefined {
  let lowest: string | undefined;

  for (const version of versions) {
    const release = releaseOf(version);
    if (version === undefined || release === undefined) continue;
    const lowestRelease = releaseOf(lowest);
    if (lowestRelease === undefined || compareVersions(release, lowestRelease) < 0) lowest = version;
  }

  return lowest;
}

// Same rules as server/src/versions.ts (the web page cannot import the server).
const KNOWN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const LOCAL_BUILD = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\+[0-9A-Za-z.-]+$/;

/** The release a version is, or is based on: `0.12.4` is itself, a local build `0.12.4+branch.sha` is based on `0.12.4`, `dev` has none. */
export function releaseOf(value?: string): string | undefined {
  if (!value) return undefined;
  return KNOWN.test(value) ? value : LOCAL_BUILD.exec(value)?.[1];
}

function comparePre(left: string, right: string): number {
  const pa = left.split(".");
  const pb = right.split(".");

  for (let index = 0; index < Math.max(pa.length, pb.length); index++) {
    if (pa[index] === undefined) return -1;
    if (pb[index] === undefined) return 1;
    const na = /^\d+$/.test(pa[index]!);
    const nb = /^\d+$/.test(pb[index]!);

    if (na && nb) {
      const diff = Number(pa[index]) - Number(pb[index]);
      if (diff !== 0) return diff;
    } else if (na !== nb) {
      return na ? -1 : 1;
    } else if (pa[index] !== pb[index]) {
      return pa[index]! < pb[index]! ? -1 : 1;
    }
  }

  return 0;
}

function compareReleases(left: string, right: string): number {
  const ma = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(left)!;
  const mb = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(right)!;

  for (let index = 1; index <= 3; index++) {
    const diff = Number(ma[index]) - Number(mb[index]);
    if (diff !== 0) return diff;
  }

  if (ma[4] === undefined && mb[4] === undefined) return 0;
  if (ma[4] === undefined) return 1;
  if (mb[4] === undefined) return -1;
  return comparePre(ma[4], mb[4]);
}

/** True when the release of `v` is lower than the release `latest`. A version without a release (`dev`, missing) is never behind. */
export function isBehind(value?: string, latest?: string): boolean {
  const release = releaseOf(value);
  const latestRelease = releaseOf(latest);
  return release !== undefined && latestRelease !== undefined && compareReleases(release, latestRelease) < 0;
}

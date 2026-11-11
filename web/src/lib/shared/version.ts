// Same rules as server/src/versions.ts (the web page cannot import the server).
const KNOWN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const LOCAL_BUILD = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\+[0-9A-Za-z.-]+$/;

/** The release a version is, or is based on: `0.12.4` is itself, a local build `0.12.4+branch.sha` is based on `0.12.4`, `dev` has none. */
export function releaseOf(v?: string): string | undefined {
  if (!v) return undefined;
  return KNOWN.test(v) ? v : LOCAL_BUILD.exec(v)?.[1];
}

function comparePre(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]!);
    const nb = /^\d+$/.test(pb[i]!);
    if (na && nb) {
      const d = Number(pa[i]) - Number(pb[i]);
      if (d !== 0) return d;
    } else if (na !== nb) {
      return na ? -1 : 1;
    } else if (pa[i] !== pb[i]) {
      return pa[i]! < pb[i]! ? -1 : 1;
    }
  }
  return 0;
}

function compareReleases(a: string, b: string): number {
  const ma = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(a)!;
  const mb = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(b)!;
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return d;
  }
  if (ma[4] === undefined && mb[4] === undefined) return 0;
  if (ma[4] === undefined) return 1;
  if (mb[4] === undefined) return -1;
  return comparePre(ma[4], mb[4]);
}

/** True when the release of `v` is lower than the release `latest`. A version without a release (`dev`, missing) is never behind. */
export function isBehind(v?: string, latest?: string): boolean {
  const a = releaseOf(v);
  const b = releaseOf(latest);
  return a !== undefined && b !== undefined && compareReleases(a, b) < 0;
}

import { RELEASE_REPO } from "./release";
import { compareVersions, isKnownVersion, normalizeVersion, releaseOf } from "./versions";

export type ReleaseNote = { version: string; name: string; body: string; url: string; publishedAt: string };
export type ReleaseNotes = { releases: ReleaseNote[]; complete: boolean };

const DEFAULT_TTL_MS = 300_000;

/**
 * Reads the GitHub release list (newest first, no drafts or prereleases) and answers `between(from, to)`: the releases
 * above `from` up to and including `to`. The list is cached for `ttlMs`, concurrent calls share one GitHub call, and a
 * failure serves the last good list and is not retried for `failBackoffMs`. `between` never throws.
 */
export function createReleaseList(o: { fetch: typeof fetch; now?: () => number; ttlMs?: number; failBackoffMs?: number; onError?: (message: string) => void }) {
  const now = o.now ?? Date.now;
  const ttlMs = o.ttlMs ?? DEFAULT_TTL_MS;
  const failBackoffMs = o.failBackoffMs ?? 60_000;
  let cached: { list: ReleaseNote[]; at: number } | undefined;
  let failedAt: number | undefined;
  let inflight: Promise<ReleaseNote[] | undefined> | undefined;

  async function load(): Promise<ReleaseNote[]> {
    let res: Response;
    try {
      res = await o.fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=100`, {
        headers: { accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new Error(`could not reach GitHub: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new Error("GitHub sent an unreadable answer");
    }
    if (!Array.isArray(data)) throw new Error("GitHub sent no release list");
    const list: ReleaseNote[] = [];
    for (const r of data as Record<string, unknown>[]) {
      if (!r || typeof r !== "object" || r.draft === true || r.prerelease === true || typeof r.tag_name !== "string") continue;
      const version = normalizeVersion(r.tag_name);
      if (!isKnownVersion(version)) continue;
      list.push({
        version,
        name: typeof r.name === "string" && r.name ? r.name : version,
        body: typeof r.body === "string" ? r.body : "",
        url: typeof r.html_url === "string" ? r.html_url : "",
        publishedAt: typeof r.published_at === "string" ? r.published_at : "",
      });
    }
    list.sort((a, b) => compareVersions(b.version, a.version));
    cached = { list, at: now() };
    failedAt = undefined;
    return list;
  }

  async function refresh(): Promise<ReleaseNote[] | undefined> {
    try {
      return await load();
    } catch (e) {
      failedAt = now();
      try {
        o.onError?.(e instanceof Error ? e.message : String(e));
      } catch {
        // a broken logger must not change the answer
      }
      return cached?.list;
    } finally {
      inflight = undefined;
    }
  }

  function list(): Promise<ReleaseNote[] | undefined> {
    if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.list);
    if (inflight) return inflight;
    if (failedAt !== undefined && now() - failedAt < failBackoffMs) return Promise.resolve(cached?.list);
    return (inflight = refresh());
  }

  return {
    async between(from: string, to: string): Promise<ReleaseNotes> {
      try {
        const f = releaseOf(normalizeVersion(from));
        const t = releaseOf(normalizeVersion(to));
        if (f === undefined || t === undefined || compareVersions(f, t) === 0) return { releases: [], complete: true };
        const all = await list();
        if (!all) return { releases: [], complete: false };
        const releases = all.filter((r) => compareVersions(r.version, f) > 0 && compareVersions(r.version, t) <= 0);
        const newest = all[0];
        const oldest = all[all.length - 1];
        const complete = newest !== undefined && oldest !== undefined && compareVersions(oldest.version, f) <= 0 && compareVersions(newest.version, f) >= 0;
        return { releases, complete };
      } catch {
        return { releases: [], complete: false };
      }
    },
  };
}

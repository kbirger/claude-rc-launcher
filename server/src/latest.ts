import { RELEASE_REPO } from "./release";
import { normalizeVersion } from "./versions";

export type LatestRelease = { version: string; checkedAt: string };

/** The latest release could not be read and none is cached. */
export class LatestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LatestError";
  }
}

export const DEFAULT_TTL_MS = 300_000;

/**
 * Remembers the latest release tag for `ttlMs`. Concurrent calls share one GitHub call. When GitHub fails it
 * serves the last good value and does not call again for `failBackoffMs`; it throws `LatestError` only when
 * there is no value.
 */
export function createLatestRelease(o: { fetch: typeof fetch; now?: () => number; ttlMs?: number; failBackoffMs?: number; onError?: (message: string) => void }) {
  const now = o.now ?? Date.now;
  const ttlMs = o.ttlMs ?? DEFAULT_TTL_MS;
  const failBackoffMs = o.failBackoffMs ?? 60_000;
  let cached: { value: LatestRelease; at: number } | undefined;
  let failure: { error: LatestError; at: number } | undefined;
  let inflight: Promise<LatestRelease> | undefined;

  async function load(): Promise<LatestRelease> {
    let res: Response;
    try {
      res = await o.fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
        headers: { accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new LatestError(`could not reach GitHub: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw new LatestError(`GitHub answered ${res.status}`);
    let tag: unknown;
    try {
      tag = ((await res.json()) as { tag_name?: unknown }).tag_name;
    } catch {
      throw new LatestError("GitHub sent an unreadable answer");
    }
    if (typeof tag !== "string" || !tag) throw new LatestError("GitHub sent no release tag");
    const at = now();
    const value = { version: normalizeVersion(tag), checkedAt: new Date(at).toISOString() };
    cached = { value, at };
    failure = undefined;
    return value;
  }

  function stale(): LatestRelease {
    if (cached) return cached.value;
    throw failure!.error;
  }

  async function refresh(): Promise<LatestRelease> {
    try {
      return await load();
    } catch (e) {
      failure = { error: e instanceof LatestError ? e : new LatestError(String(e)), at: now() };
      try {
        o.onError?.(failure.error.message);
      } catch {
        // a broken logger must not change the answer
      }
      return stale();
    } finally {
      inflight = undefined;
    }
  }

  return {
    get(): Promise<LatestRelease> {
      if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.value);
      if (inflight) return inflight;
      if (failure && now() - failure.at < failBackoffMs) {
        try { return Promise.resolve(stale()); } catch (e) { return Promise.reject(e); }
      }
      return (inflight = refresh());
    },
    peek(): LatestRelease | undefined {
      return cached?.value;
    },
  };
}

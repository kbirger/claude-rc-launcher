import { RELEASE_REPO } from "./release";
import { normalizeVersion } from "./versions";

export interface LatestRelease {
  version: string;
  checkedAt: string;
}

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
export function createLatestRelease(options: {
  fetch: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  failBackoffMs?: number;
  onError?: (message: string) => void;
}) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const failBackoffMs = options.failBackoffMs ?? 60_000;
  let cached: { value: LatestRelease; at: number } | undefined;
  let failure: { error: LatestError; at: number } | undefined;
  let inflight: Promise<LatestRelease> | undefined;

  async function load(): Promise<LatestRelease> {
    let res: Response;

    try {
      res = await options.fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
        headers: { accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new LatestError(`could not reach GitHub: ${error instanceof Error ? error.message : String(error)}`);
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
    throw failure?.error ?? new LatestError("no release information");
  }

  async function refresh(): Promise<LatestRelease> {
    try {
      return await load();
    } catch (error) {
      failure = { error: error instanceof LatestError ? error : new LatestError(String(error)), at: now() };

      try {
        options.onError?.(failure.error.message);
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
        try {
          return Promise.resolve(stale());
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }

      return (inflight = refresh());
    },
    peek(): LatestRelease | undefined {
      return cached?.value;
    },
  };
}

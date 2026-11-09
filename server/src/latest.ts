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

const DEFAULT_TTL_MS = 3_600_000;

/**
 * Remembers the latest release tag for `ttlMs`. When GitHub fails it serves the last good value,
 * and throws `LatestError` only when there is none.
 */
export function createLatestRelease(o: { fetch: typeof fetch; now?: () => number; ttlMs?: number }) {
  const now = o.now ?? Date.now;
  const ttlMs = o.ttlMs ?? DEFAULT_TTL_MS;
  let cached: { value: LatestRelease; at: number } | undefined;

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
    return { version: normalizeVersion(tag), checkedAt: new Date(now()).toISOString() };
  }

  return {
    async get(): Promise<LatestRelease> {
      if (cached && now() - cached.at < ttlMs) return cached.value;
      try {
        const value = await load();
        cached = { value, at: now() };
        return value;
      } catch (e) {
        if (cached) return cached.value;
        throw e;
      }
    },
    peek(): LatestRelease | undefined {
      return cached?.value;
    },
  };
}

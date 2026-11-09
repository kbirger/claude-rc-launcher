import type { Server } from "bun";

/**
 * Bun closes a request that sends nothing for `idleTimeout` seconds (10 by default). `POST /update` downloads two
 * release assets and runs `--version` before it answers, and the hub waits up to 180 s for a node
 * (`UPDATE_TIMEOUT_MS` in hosts.ts). So the update routes, and only those, get this longer limit. It is above 180 s
 * and below Bun's maximum of 255 s.
 */
export const UPDATE_IDLE_TIMEOUT_SECONDS = 190;

/** `/api/update` on a node, `/api/hosts/<host>/update` and `/cli/api/hosts/<host>/update` on the hub. */
const UPDATE_PATH_RE = /^\/(?:cli\/)?api\/(?:hosts\/[^/]+\/)?update$/;

/**
 * `GET /github/repos` can take up to 120 s on the hub's side (`REPOS_TIMEOUT_MS`), and `POST /github/login` waits up to 15 s
 * for the code. Clone is an async job and needs no long limit. 125 s is above 120 s and below Bun's maximum of 255 s.
 */
export const GITHUB_IDLE_TIMEOUT_SECONDS = 125;

const GITHUB_PATH_RE = /^\/(?:cli\/)?api\/(?:hosts\/[^/]+\/)?github\/(?:repos|login)$/;

/** The update event stream sends nothing between events, so it must not hit the idle limit. */
const EVENTS_PATH_RE = /^\/api\/events$/;

type Fetch = (req: Request, server: Server<undefined>) => Response | Promise<Response>;

/** Wraps an app's fetch so that an update route (`POST`) may stay idle for `seconds`, and the GitHub repo list and login start for `githubSeconds`. */
export function withLongUpdates(
  app: { fetch(req: Request, env?: unknown): Response | Promise<Response> },
  seconds: number = UPDATE_IDLE_TIMEOUT_SECONDS,
  githubSeconds: number = GITHUB_IDLE_TIMEOUT_SECONDS,
): Fetch {
  return (req, server) => {
    const { pathname } = new URL(req.url);
    if (req.method === "GET" && EVENTS_PATH_RE.test(pathname)) server.timeout(req, 0);
    else if (req.method === "POST" && UPDATE_PATH_RE.test(pathname)) server.timeout(req, seconds);
    else if (GITHUB_PATH_RE.test(pathname) && ((req.method === "GET" && pathname.endsWith("/repos")) || (req.method === "POST" && pathname.endsWith("/login")))) server.timeout(req, githubSeconds);
    return app.fetch(req, server);
  };
}

/** Test settings for the mains: a shorter server-wide idle limit and update limit. */
export type ServeLimits = { idleTimeout?: number; updateIdleTimeout?: number };

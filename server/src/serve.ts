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

type Fetch = (req: Request, server: Server<undefined>) => Response | Promise<Response>;

/** Wraps an app's fetch so that a `POST` to an update route may stay idle for `seconds`. */
export function withLongUpdates(app: { fetch(req: Request, env?: unknown): Response | Promise<Response> }, seconds: number = UPDATE_IDLE_TIMEOUT_SECONDS): Fetch {
  return (req, server) => {
    if (req.method === "POST" && UPDATE_PATH_RE.test(new URL(req.url).pathname)) server.timeout(req, seconds);
    return app.fetch(req, server);
  };
}

/** Test settings for the mains: a shorter server-wide idle limit and update limit. */
export type ServeLimits = { idleTimeout?: number; updateIdleTimeout?: number };

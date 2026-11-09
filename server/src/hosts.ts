import { Hono, type Context } from "hono";
import type { Config } from "./config";
import { HostError, type HostClient, type HostFailure } from "./hostclient";
import { HOST_ID_RE } from "./hostid";
import type { HostRegistry } from "./hostregistry";
import { HttpError } from "./instances";
import { isObject, parseCloneRequest, parseLoginRequest, parseMkdirRequest, parseStartRequest, parseUpdateRequest, readJson } from "./requests";
import { VERSION } from "./version";
import type { User } from "./userauth";

export type HostInfo = { id: string; name: string; status: "ok" | "offline" | "error"; error?: string; source?: "config" | "managed"; version?: string };

/** A node's update downloads two release assets and checks them before it answers. */
export const UPDATE_TIMEOUT_MS = 180_000;

/** `gh repo list` over many organizations can be slow. */
export const REPOS_TIMEOUT_MS = 120_000;
/** The node waits up to 15 seconds for the device code. */
export const LOGIN_START_TIMEOUT_MS = 20_000;

const ID_RE = /^[0-9a-f]{12}$/;
const LOGIN_ID_RE = /^[0-9a-f]{32}$/;
const OFFLINE: HostFailure[] = ["unreachable", "timeout"];

const isWrite = (m: string) => m !== "GET" && m !== "HEAD" && m !== "OPTIONS";

/**
 * `/api/hosts`: the host list, `local` (the hub's own instance API) and an allow-listed proxy to nodes.
 * Nothing of the inbound request is forwarded except the validated values below; the node is called with the
 * hub's own credential.
 */
export function hostsApi(o: {
  cfg: Config;
  local: Hono;
  registry: HostRegistry;
  probeTimeoutMs?: number;
  requestTimeoutMs?: number;
}): Hono {
  const { cfg, local } = o;
  const probeTimeoutMs = o.probeTimeoutMs ?? 3_000;
  const requestTimeoutMs = o.requestTimeoutMs ?? 10_000;
  const app = new Hono();

  app.get("/", async (c) => {
    const rest = await Promise.all(
      o.registry.list().map(async ({ host: h, client, source }): Promise<HostInfo> => {
        try {
          const r = await client.call("GET", "/api/node", { timeoutMs: probeTimeoutMs });
          if (r.status === 200) {
            const version = isObject(r.body) && typeof r.body.version === "string" ? r.body.version : undefined;
            return { id: h.id, name: h.name, status: "ok", source, ...(version !== undefined ? { version } : {}) };
          }
          return { id: h.id, name: h.name, status: "error", error: "bad response", source };
        } catch (e) {
          if (!(e instanceof HostError)) return { id: h.id, name: h.name, status: "error", error: "bad response", source };
          return { id: h.id, name: h.name, status: OFFLINE.includes(e.reason) ? "offline" : "error", error: e.reason, source };
        }
      }),
    );
    return c.json([{ id: "local", name: cfg.name, status: "ok", version: VERSION } satisfies HostInfo, ...rest]);
  });

  // Audit every state-changing request, local or remote.
  app.use("/:host/*", async (c, next) => {
    await next();
    if (isWrite(c.req.method)) {
      const u = c.get("user" as never) as User | undefined;
      const pathname = new URL(c.req.url).pathname;
      const hostId = /\/hosts\/([^/]+)/.exec(pathname)?.[1] ?? "unknown";
      console.log(`audit user=${u?.username ?? u?.sub ?? "unknown"} host=${hostId} ${c.req.method} ${pathname} ${c.res.status}`);
    }
  });

  app.route("/local", local);

  const remote = new Hono();
  const clientOf = (c: Context): { id: string; client: HostClient } => {
    const id = c.req.param("host") ?? "";
    const entry = HOST_ID_RE.test(id) && id !== "local" ? o.registry.get(id) : undefined;
    if (!entry) throw new HttpError(404, "unknown host");
    return { id, client: entry.client };
  };
  /** Runs a forward, turning a HostError into the hub's 502. */
  const forward = (fn: (c: Context, client: HostClient) => Promise<{ status: number; body: unknown }>) => async (c: Context) => {
    const { id, client } = clientOf(c);
    try {
      const r = await fn(c, client);
      return r.status === 204 ? c.body(null, 204) : c.json(r.body, r.status as 200);
    } catch (e) {
      if (e instanceof HostError) return c.json({ error: e.message, host: id }, 502);
      throw e;
    }
  };
  const instanceId = (c: Context) => {
    const id = c.req.param("id") ?? "";
    if (!ID_RE.test(id)) throw new HttpError(400, "invalid instance id");
    return id;
  };

  remote.get("/instances", forward((_c, k) => k.call("GET", "/api/instances", { timeoutMs: requestTimeoutMs })));
  remote.post(
    "/instances",
    forward(async (c, k) => {
      const json = parseStartRequest(await readJson(c));
      return k.call("POST", "/api/instances", { json, timeoutMs: requestTimeoutMs });
    }),
  );
  remote.delete("/instances/:id", forward((c, k) => k.call("DELETE", `/api/instances/${instanceId(c)}`, { timeoutMs: requestTimeoutMs })));
  remote.get(
    "/instances/:id/logs",
    forward((c, k) => {
      const id = instanceId(c);
      const lines = c.req.query("lines");
      if (lines !== undefined && !/^-?\d+$/.test(lines)) throw new HttpError(400, "lines must be an integer");
      return k.call("GET", `/api/instances/${id}/logs`, { ...(lines !== undefined ? { query: { lines } } : {}), timeoutMs: requestTimeoutMs });
    }),
  );
  remote.get(
    "/fs",
    forward((c, k) => {
      const p = c.req.query("path");
      const u = c.req.query("user");
      if (u === "") throw new HttpError(400, "user must not be empty");
      const query = { ...(p !== undefined ? { path: p } : {}), ...(u !== undefined ? { user: u } : {}) };
      return k.call("GET", "/api/fs", { ...(Object.keys(query).length ? { query } : {}), timeoutMs: requestTimeoutMs });
    }),
  );
  remote.get("/users", forward((_c, k) => k.call("GET", "/api/users", { timeoutMs: requestTimeoutMs })));
  remote.post(
    "/fs/mkdir",
    forward(async (c, k) => {
      const json = parseMkdirRequest(await readJson(c));
      return k.call("POST", "/api/fs/mkdir", { json, timeoutMs: requestTimeoutMs });
    }),
  );
  remote.get("/node", forward((_c, k) => k.call("GET", "/api/node", { timeoutMs: requestTimeoutMs })));
  remote.post(
    "/update",
    forward(async (c, k) => {
      const json = parseUpdateRequest(await readJson(c));
      return k.call("POST", "/api/update", { json, timeoutMs: UPDATE_TIMEOUT_MS });
    }),
  );
  remote.post(
    "/clone",
    forward(async (c, k) => {
      const json = parseCloneRequest(await readJson(c));
      return k.call("POST", "/api/clone", { json, timeoutMs: requestTimeoutMs });
    }),
  );
  remote.get(
    "/clone/:id",
    forward((c, k) => {
      const id = c.req.param("id") ?? "";
      if (!LOGIN_ID_RE.test(id)) throw new HttpError(400, "invalid clone id");
      return k.call("GET", `/api/clone/${id}`, { timeoutMs: requestTimeoutMs });
    }),
  );
  remote.get(
    "/github/repos",
    forward((c, k) => {
      const u = c.req.query("user");
      if (u === "") throw new HttpError(400, "user must not be empty");
      return k.call("GET", "/api/github/repos", { ...(u !== undefined ? { query: { user: u } } : {}), timeoutMs: REPOS_TIMEOUT_MS });
    }),
  );
  remote.post(
    "/github/login",
    forward(async (c, k) => {
      const json = parseLoginRequest(await readJson(c));
      return k.call("POST", "/api/github/login", { json, timeoutMs: LOGIN_START_TIMEOUT_MS });
    }),
  );
  remote.get(
    "/github/login/:id",
    forward((c, k) => {
      const id = c.req.param("id") ?? "";
      if (!LOGIN_ID_RE.test(id)) throw new HttpError(400, "invalid login id");
      return k.call("GET", `/api/github/login/${id}`, { timeoutMs: requestTimeoutMs });
    }),
  );
  remote.all("*", (c) => c.json({ error: "not found" }, 404));

  app.route("/:host", remote);
  return app;
}

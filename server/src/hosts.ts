import { Hono, type Context } from "hono";
import type { Config } from "./config";
import { HostError, type HostClient, type HostFailure } from "./hostclient";
import { HOST_ID_RE } from "./hostid";
import type { HostRegistry } from "./hostregistry";
import { HttpError } from "./instances";
import { parseMkdirRequest, parseStartRequest, readJson } from "./requests";
import type { User } from "./userauth";

export type HostInfo = { id: string; name: string; status: "ok" | "offline" | "error"; error?: string; source?: "config" | "managed" };

const ID_RE = /^[0-9a-f]{12}$/;
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
          if (r.status === 200) return { id: h.id, name: h.name, status: "ok", source };
          return { id: h.id, name: h.name, status: "error", error: "bad response", source };
        } catch (e) {
          if (!(e instanceof HostError)) return { id: h.id, name: h.name, status: "error", error: "bad response", source };
          return { id: h.id, name: h.name, status: OFFLINE.includes(e.reason) ? "offline" : "error", error: e.reason, source };
        }
      }),
    );
    return c.json([{ id: "local", name: cfg.name, status: "ok" } satisfies HostInfo, ...rest]);
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
  remote.all("*", (c) => c.json({ error: "not found" }, 404));

  app.route("/:host", remote);
  return app;
}

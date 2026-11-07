import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { User, UserAuthStrategy } from "./userauth";
import type { Config } from "./config";
import { cliConfigRoute } from "./cliauth";
import { listDirs, makeDir, type DirOwner } from "./fsapi";
import { enrollmentApi } from "./enrollment";
import type { TokenSource } from "./clientcreds";
import { hostAdminApi } from "./hostadmin";
import { hostsApi } from "./hosts";
import type { HostClient, HostConfig } from "./hostclient";
import { HostRegistry } from "./hostregistry";
import { HttpError, type InstanceService } from "./instances";
import { PathError } from "./paths";

/** The command-line client's surface: bearer-authenticated, mounted under `/cli`. */
export type CliDeps = { issuer: string; clientId: string; auth: MiddlewareHandler; makeClient: (h: HostConfig) => HostClient; hasHubAuth: boolean; enrollment?: { token?: TokenSource; clientId: string; fetch?: typeof fetch } };

export type Deps = { cfg: Config; instances: InstanceService; userAuth: UserAuthStrategy; staticHandler?: MiddlewareHandler; dirOwner?: DirOwner; hostClients?: Map<string, HostClient>; hosts?: HostRegistry; cli?: CliDeps; probeTimeoutMs?: number; requestTimeoutMs?: number };

const ID_RE = /^[0-9a-f]{12}$/;

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function csrf(cfg: Config): MiddlewareHandler {
  let allowed: string;
  try {
    allowed = new URL(cfg.publicUrl).origin;
  } catch {
    allowed = cfg.publicUrl;
  }
  return async (c, next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") return next();
    const media = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (media !== "application/json") return c.json({ error: "content-type must be application/json" }, 415);
    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== allowed) return c.json({ error: "forbidden origin" }, 403);
    return next();
  };
}

export type InstanceApiDeps = { cfg: Config; instances: InstanceService; dirOwner?: DirOwner };

/** The instance and filesystem routes of one host (served for `local` by the hub and by a node). */
export function instanceApi(deps: InstanceApiDeps): Hono {
  const { cfg, instances, dirOwner } = deps;
  const r = new Hono();

  r.get("/instances", async (c) => c.json(await instances.list()));
  r.post("/instances", async (c) => {
    const body = await readJson(c);
    if (!isObject(body)) throw new HttpError(400, "body must be an object");
    if (typeof body.path !== "string" || !body.path) throw new HttpError(400, "path is required");
    if (body.name !== undefined && typeof body.name !== "string") throw new HttpError(400, "name must be a string");
    const input = body.name === undefined ? { path: body.path } : { path: body.path, name: body.name };
    return c.json(await instances.start(input), 201);
  });
  r.delete("/instances/:id", async (c) => {
    const id = c.req.param("id");
    if (!ID_RE.test(id)) throw new HttpError(400, "invalid instance id");
    await instances.stop(id);
    return c.body(null, 204);
  });
  r.get("/instances/:id/logs", async (c) => {
    const id = c.req.param("id");
    if (!ID_RE.test(id)) throw new HttpError(400, "invalid instance id");
    const raw = c.req.query("lines");
    let lines = 100;
    if (raw !== undefined) {
      if (!/^-?\d+$/.test(raw)) throw new HttpError(400, "lines must be an integer");
      lines = Number.parseInt(raw, 10);
    }
    return c.json({ log: await instances.logs(id, lines) });
  });

  r.get("/fs", async (c) => c.json(await listDirs(c.req.query("path"), cfg.roots)));
  r.post("/fs/mkdir", async (c) => {
    const body = await readJson(c);
    if (!isObject(body) || typeof body.parent !== "string" || typeof body.name !== "string") {
      throw new HttpError(400, "parent and name are required strings");
    }
    return c.json(await makeDir(body.parent, body.name, cfg.roots, dirOwner), 201);
  });

  r.all("*", (c) => c.json({ error: "not found" }, 404));
  return r;
}

export function onError(err: Error, c: Context) {
  if (err instanceof HttpError || err instanceof PathError) {
    const extra = err instanceof HttpError ? err.extra : undefined;
    return c.json({ ...(isObject(extra) ? extra : {}), error: err.message }, err.status as 400);
  }
  console.error(err);
  return c.json({ error: "internal error" }, 500);
}

const isWrite = (m: string) => m !== "GET" && m !== "HEAD" && m !== "OPTIONS";

/** The API of a node: no browser surface, bearer auth, JSON-only writes, audit log. */
export function createNodeApp(deps: { cfg: Config; instances: InstanceService; auth: MiddlewareHandler; dirOwner?: DirOwner }): Hono {
  const { cfg, instances, auth, dirOwner } = deps;
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true }));

  const api = new Hono();
  api.use("*", auth);
  api.use("*", async (c, next) => {
    if (!isWrite(c.req.method)) return next();
    const media = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (media !== "application/json") return c.json({ error: "content-type must be application/json" }, 415);
    await next();
  });
  api.use("*", async (c, next) => {
    await next();
    if (isWrite(c.req.method)) {
      console.log(`audit caller=${String(c.get("caller" as never) ?? "unknown")} ${c.req.method} ${new URL(c.req.url).pathname} ${c.res.status}`);
    }
  });
  api.get("/node", (c) => c.json({ ok: true, name: cfg.name }));
  api.route("/", instanceApi({ cfg, instances, dirOwner }));
  app.route("/api", api);
  app.onError(onError);
  return app;
}

export function createApp(deps: Deps): Hono {
  const { cfg, instances, userAuth, staticHandler, dirOwner } = deps;
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));
  if (userAuth.routes) app.route("/auth", userAuth.routes);

  const api = new Hono();
  api.use("*", userAuth.middleware);
  api.use("*", csrf(cfg));

  api.get("/me", (c) => c.json({ ...(c.get("user" as never) as User), ...(userAuth.logoutUrl ? { logoutUrl: userAuth.logoutUrl } : {}) }));

  const registry = deps.hosts ?? HostRegistry.memory(cfg.hosts, deps.hostClients ?? new Map());
  const forwarding = () =>
    hostsApi({
      cfg,
      local: instanceApi({ cfg, instances, dirOwner }),
      registry,
      probeTimeoutMs: deps.probeTimeoutMs,
      requestTimeoutMs: deps.requestTimeoutMs,
    });
  api.route("/hosts", forwarding());
  api.all("*", (c) => c.json({ error: "not found" }, 404));
  app.route("/api", api);

  if (deps.cli) {
    const cli = deps.cli;
    app.route("/cli/config", cliConfigRoute(cli));
    const cliApi = new Hono();
    cliApi.use("*", cli.auth);
    cliApi.use("*", csrf(cfg));
    cliApi.get("/me", (c) => c.json(c.get("user" as never) as User));
    cliApi.route("/node-enrollment", enrollmentApi(cli.enrollment ?? { clientId: "" }));
    // Host management first, so that `probe` is never read as a host id by the forwarding routes.
    cliApi.route("/hosts", hostAdminApi({ registry, makeClient: cli.makeClient, hasHubAuth: cli.hasHubAuth }));
    cliApi.route("/hosts", forwarding());
    cliApi.all("*", (c) => c.json({ error: "not found" }, 404));
    app.route("/cli/api", cliApi);
    app.all("/cli/*", (c) => c.json({ error: "not found" }, 404));
  }

  if (staticHandler) app.get("*", userAuth.middleware, staticHandler);

  app.onError(onError);

  return app;
}

import { Hono, type Context, type MiddlewareHandler } from "hono";
import { authRoutes, requireUser, type OidcClient, type User } from "./auth";
import type { Config } from "./config";
import { listDirs, makeDir } from "./fsapi";
import { HttpError, type InstanceService } from "./instances";

export type Deps = { cfg: Config; instances: InstanceService; oidc: OidcClient; staticHandler?: MiddlewareHandler };

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

export function createApp(deps: Deps): Hono {
  const { cfg, instances, oidc, staticHandler } = deps;
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.route("/auth", authRoutes(cfg, oidc));

  const api = new Hono();
  api.use("*", requireUser(cfg));
  api.use("*", csrf(cfg));

  api.get("/me", (c) => c.json(c.get("user" as never) as User));

  api.get("/instances", async (c) => c.json(await instances.list()));
  api.post("/instances", async (c) => {
    const body = await readJson(c);
    if (!isObject(body)) throw new HttpError(400, "body must be an object");
    if (typeof body.path !== "string" || !body.path) throw new HttpError(400, "path is required");
    if (body.name !== undefined && typeof body.name !== "string") throw new HttpError(400, "name must be a string");
    const input = body.name === undefined ? { path: body.path } : { path: body.path, name: body.name };
    return c.json(await instances.start(input), 201);
  });
  api.delete("/instances/:id", async (c) => {
    const id = c.req.param("id");
    if (!ID_RE.test(id)) throw new HttpError(400, "invalid instance id");
    await instances.stop(id);
    return c.body(null, 204);
  });
  api.get("/instances/:id/logs", async (c) => {
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

  api.get("/fs", async (c) => c.json(await listDirs(c.req.query("path"), cfg.roots)));
  api.post("/fs/mkdir", async (c) => {
    const body = await readJson(c);
    if (!isObject(body) || typeof body.parent !== "string" || typeof body.name !== "string") {
      throw new HttpError(400, "parent and name are required strings");
    }
    return c.json(await makeDir(body.parent, body.name, cfg.roots), 201);
  });

  api.all("*", (c) => c.json({ error: "not found" }, 404));
  app.route("/api", api);

  if (staticHandler) app.get("*", requireUser(cfg), staticHandler);

  app.onError((err, c) => {
    const status = (err as { status?: unknown })?.status;
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) {
      const extra = (err as { extra?: unknown }).extra;
      return c.json({ ...(isObject(extra) ? extra : {}), error: err.message }, status as 400);
    }
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  return app;
}

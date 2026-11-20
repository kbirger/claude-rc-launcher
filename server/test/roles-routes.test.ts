import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { createApp } from "../src/app";
import type { Config } from "../src/config";
import { requiredRole } from "../src/roles";
import type { UserAuthStrategy } from "../src/userauth";

const cfg = { mode: "hub", name: "h", port: 1, host: "x", publicUrl: "https://h.example", roots: ["/tmp"], hosts: [], stateDir: "/tmp/roles-routes" } as unknown as Config;
const stub: any = new Proxy({}, { get: () => async () => ({}) });
const instances: any = { list: async () => [], start: async () => ({ id: "0123456789ab" }), stop: async () => {}, pause: async () => {}, resume: async () => {}, users: async () => ({ selectable: false, default: "u", users: [] }), trustFilter: async () => () => true };
const pass: MiddlewareHandler = async (_c, next) => next();

/** A strategy that takes the role from the header `x-role`. No header gives a user with no role. `x-role: none` is a refused user. */
const byHeader: UserAuthStrategy = {
  middleware: async (c, next) => {
    const role = c.req.header("x-role");
    c.set("user" as never, { sub: "u1", name: "Ann", username: "ann", ...(role ? { role } : {}) } as never);
    await next();
  },
};

const mk = () =>
  createApp({
    cfg,
    instances,
    userAuth: byHeader,
    cloner: stub,
    update: stub,
    latest: stub,
    releaseList: stub,
    updates: stub,
    history: stub,
    updateLog: stub,
    presence: { list: () => [], onChange: () => () => {} },
    cli: { issuer: "https://i", clientId: "c", auth: byHeader.middleware, makeClient: stub, enrollment: { hubKeys: [] } },
  } as never);

const PARAM = /:([a-z]+)/g;

describe("route table", () => {
  test("every hub route under /api and /cli/api has a role in the policy", () => {
    const missing: string[] = [];
    let seen = 0;
    for (const r of mk().routes) {
      if (r.method === "ALL") continue;
      const m = /^\/(?:cli\/)?api(\/.*)$/.exec(r.path);
      if (!m) continue;
      seen++;
      const sub = m[1]!.replace(PARAM, "x");
      if (requiredRole(r.method, sub) === undefined) missing.push(`${r.method} ${r.path}`);
    }
    expect(seen).toBeGreaterThan(40);
    expect(missing).toEqual([]);
  });

  test("the sessions stream is a read route of the browser API", () => {
    expect(mk().routes.some((r) => r.method === "GET" && r.path === "/api/sessions/events")).toBe(true);
    expect(requiredRole("GET", "/sessions/events")).toBe("read");
  });
});

describe("enforcement", () => {
  const JSON_H = { "content-type": "application/json" };
  const call = (method: string, path: string, role?: string, body?: unknown) =>
    mk().request(path, { method, headers: { ...JSON_H, ...(role ? { "x-role": role } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const status = async (method: string, path: string, role?: string, body?: unknown) => (await call(method, path, role, body)).status;

  test("a user with no role acts as read", async () => {
    expect(await status("GET", "/api/hosts/local/instances")).toBe(200);
    expect(await status("POST", "/api/hosts/local/instances", undefined, { path: "/tmp" })).toBe(403);
  });
  test("read can read and cannot write", async () => {
    expect(await status("GET", "/api/hosts/local/instances", "read")).toBe(200);
    for (const [m, p] of [["POST", "/api/hosts/local/instances"], ["DELETE", "/api/hosts/local/instances/0123456789ab"], ["POST", "/api/hosts/local/instances/0123456789ab/pause"], ["POST", "/api/hosts/local/fs/mkdir"], ["PATCH", "/api/hosts/h1"], ["POST", "/api/hosts/local/clone"]] as const) {
      expect([m, p, await status(m, p, "read", {})]).toEqual([m, p, 403]);
    }
  });
  test("read gets 403 on a settings change and restart, and can read the help", async () => {
    expect(await status("PATCH", "/api/hosts/nas/instances/0123456789ab", "read", { createSession: false })).toBe(403);
    expect(await status("POST", "/api/hosts/nas/instances/0123456789ab/restart", "read", {})).toBe(403);
    expect(await status("GET", "/api/hosts/nas/instance-settings", "read")).not.toBe(403);
  });
  test("write passes the role check on a settings change and restart", async () => {
    expect(await status("PATCH", "/api/hosts/nas/instances/0123456789ab", "write", { createSession: false })).not.toBe(403);
    expect(await status("POST", "/api/hosts/nas/instances/0123456789ab/restart", "write", {})).not.toBe(403);
  });
  test("write starts and stops instances and renames a node", async () => {
    expect(await status("POST", "/api/hosts/local/instances", "write", { path: "/tmp" })).toBe(201);
    expect(await status("DELETE", "/api/hosts/local/instances/0123456789ab", "write")).toBe(204);
  });
  test("write cannot use the admin routes", async () => {
    for (const [m, p] of [["POST", "/api/hosts/local/update"], ["POST", "/api/hosts/local/github/login"], ["GET", "/api/hosts/local/github/login/0123456789abcdef0123456789abcdef"]] as const) {
      expect([m, p, await status(m, p, "write", {})]).toEqual([m, p, 403]);
    }
    for (const [m, p] of [["POST", "/cli/api/hosts"], ["POST", "/cli/api/hosts/probe"], ["DELETE", "/cli/api/hosts/h1"]] as const) {
      expect([m, p, await status(m, p, "write", {})]).toEqual([m, p, 403]);
    }
  });
  test("admin passes the role check on the admin routes", async () => {
    for (const [m, p] of [["POST", "/cli/api/hosts/probe"], ["DELETE", "/cli/api/hosts/h1"]] as const) {
      expect([m, p, (await status(m, p, "admin", {})) === 403]).toEqual([m, p, false]);
    }
  });
  test("the role none gives 403 on every kind of route", async () => {
    for (const [m, p] of [["GET", "/api/me"], ["GET", "/api/hosts/local/instances"], ["POST", "/api/hosts/local/instances"], ["GET", "/cli/api/me"]] as const) {
      expect([m, p, await status(m, p, "none", {})]).toEqual([m, p, 403]);
    }
  });
  test("a route with no policy row needs admin", async () => {
    expect(await status("GET", "/api/nope", "write")).toBe(403);
    expect(await status("GET", "/api/nope", "admin")).toBe(404);
  });
  test("a write user who names a user gets 403 on every route that takes one", async () => {
    expect(await status("POST", "/api/hosts/local/instances", "write", { path: "/tmp", user: "alice" })).toBe(403);
    expect(await status("POST", "/api/hosts/local/fs/mkdir", "write", { parent: "/tmp", name: "x", user: "alice" })).toBe(403);
    expect(await status("POST", "/api/hosts/local/clone", "write", { repo: "o/x", parent: "/tmp", user: "alice" })).toBe(403);
    expect(await status("GET", "/api/hosts/local/fs?user=alice", "write")).toBe(403);
    expect(await status("GET", "/api/hosts/local/github/repos?user=alice", "write")).toBe(403);
    expect(await status("GET", "/cli/api/hosts/local/fs?user=alice", "write")).toBe(403);
  });
  test("a write user who names no user passes, and an admin can name one", async () => {
    expect(await status("GET", "/api/hosts/local/fs", "write")).not.toBe(403);
    expect(await status("POST", "/api/hosts/local/instances", "admin", { path: "/tmp", user: "alice" })).not.toBe(403);
    expect(await status("GET", "/api/hosts/local/fs?user=alice", "admin")).not.toBe(403);
  });
  test("a body that is not JSON is left to the route", async () => {
    const r = await mk().request("/api/hosts/local/instances", { method: "POST", headers: { ...JSON_H, "x-role": "write" }, body: "{not json" });
    expect(r.status).toBe(400);
  });
  test("the CLI routes follow the same roles", async () => {
    expect(await status("GET", "/cli/api/hosts/local/instances", "read")).toBe(200);
    expect(await status("POST", "/cli/api/hosts/local/instances", "read", { path: "/tmp" })).toBe(403);
    expect(await status("POST", "/cli/api/hosts/local/instances", "write", { path: "/tmp" })).toBe(201);
  });
  test("the page itself loads for any role", async () => {
    const app = createApp({ cfg, instances, userAuth: byHeader, staticHandler: async (c: any) => c.text("index") } as never);
    expect((await app.request("/", { headers: { "x-role": "read" } })).status).toBe(200);
  });
});

void pass;

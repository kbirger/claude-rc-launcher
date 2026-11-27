import type { MiddlewareHandler } from "hono";
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import type { UserAuthStrategy } from "../src/auth/user";
import type { Config } from "../src/config/parse";
import { requiredRole } from "../src/roles";

const cfg = {
  mode: "hub",
  name: "h",
  port: 1,
  host: "x",
  publicUrl: "https://h.example",
  roots: ["/tmp"],
  hosts: [],
  stateDir: "/tmp/roles-routes",
} as unknown as Config;
const stub: any = new Proxy({}, { get: () => () => Promise.resolve({}) });
const instances: any = {
  list: () => Promise.resolve([]),
  start: () => Promise.resolve({ id: "0123456789ab" }),
  stop: async () => {},
  pause: async () => {},
  resume: async () => {},
  users: () => Promise.resolve({ selectable: false, default: "u", users: [] }),
  trustFilter: () => Promise.resolve(() => true),
};
const pass: MiddlewareHandler = async (_c, next) => next();

/** A strategy that takes the role from the header `x-role`. No header gives a user with no role. `x-role: none` is a refused user. */
const byHeader: UserAuthStrategy = {
  middleware: async (context, next) => {
    const role = context.req.header("x-role");
    context.set("user" as never, { sub: "u1", name: "Ann", username: "ann", ...(role ? { role } : {}) } as never);
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
    cli: {
      issuer: "https://i",
      clientId: "c",
      auth: byHeader.middleware,
      makeClient: stub,
      enrollment: { hubKeys: [] },
    },
  });

const PARAM = /:([a-z]+)/g;

describe("route table", () => {
  test("every hub route under /api and /cli/api has a role in the policy", () => {
    const missing: string[] = [];
    let seen = 0;

    for (const routerRoute of mk().routes) {
      if (routerRoute.method === "ALL") continue;
      const match = /^\/(?:cli\/)?api(\/.*)$/.exec(routerRoute.path);
      if (!match) continue;
      seen++;
      const sub = match[1].replace(PARAM, "x");
      if (requiredRole(routerRoute.method, sub) === undefined)
        missing.push(`${routerRoute.method} ${routerRoute.path}`);
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
    mk().request(path, {
      method,
      headers: { ...JSON_H, ...(role ? { "x-role": role } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const status = async (method: string, path: string, role?: string, body?: unknown) =>
    (await call(method, path, role, body)).status;

  test("a user with no role acts as read", async () => {
    expect(await status("GET", "/api/hosts/local/instances")).toBe(200);
    expect(await status("POST", "/api/hosts/local/instances", undefined, { path: "/tmp" })).toBe(403);
  });
  test("read can read and cannot write", async () => {
    expect(await status("GET", "/api/hosts/local/instances", "read")).toBe(200);

    for (const [item, entry] of [
      ["POST", "/api/hosts/local/instances"],
      ["DELETE", "/api/hosts/local/instances/0123456789ab"],
      ["POST", "/api/hosts/local/instances/0123456789ab/pause"],
      ["POST", "/api/hosts/local/fs/mkdir"],
      ["PATCH", "/api/hosts/h1"],
      ["POST", "/api/hosts/local/clone"],
    ] as const) {
      expect([item, entry, await status(item, entry, "read", {})]).toEqual([item, entry, 403]);
    }
  });
  test("read gets 403 on a settings change and restart, and can read the help", async () => {
    expect(await status("PATCH", "/api/hosts/nas/instances/0123456789ab", "read", { createSession: false })).toBe(403);
    expect(await status("POST", "/api/hosts/nas/instances/0123456789ab/restart", "read", {})).toBe(403);
    expect(await status("GET", "/api/hosts/nas/instance-settings", "read")).not.toBe(403);
  });
  test("write passes the role check on a settings change and restart", async () => {
    expect(await status("PATCH", "/api/hosts/nas/instances/0123456789ab", "write", { createSession: false })).not.toBe(
      403,
    );
    expect(await status("POST", "/api/hosts/nas/instances/0123456789ab/restart", "write", {})).not.toBe(403);
  });
  test("write starts and stops instances and renames a node", async () => {
    expect(await status("POST", "/api/hosts/local/instances", "write", { path: "/tmp" })).toBe(201);
    expect(await status("DELETE", "/api/hosts/local/instances/0123456789ab", "write")).toBe(204);
  });
  test("write cannot use the admin routes", async () => {
    for (const [item, entry] of [
      ["POST", "/api/hosts/local/update"],
      ["POST", "/api/hosts/local/github/login"],
      ["GET", "/api/hosts/local/github/login/0123456789abcdef0123456789abcdef"],
    ] as const) {
      expect([item, entry, await status(item, entry, "write", {})]).toEqual([item, entry, 403]);
    }

    for (const [item, entry] of [
      ["POST", "/cli/api/hosts"],
      ["POST", "/cli/api/hosts/probe"],
      ["DELETE", "/cli/api/hosts/h1"],
    ] as const) {
      expect([item, entry, await status(item, entry, "write", {})]).toEqual([item, entry, 403]);
    }
  });
  test("admin passes the role check on the admin routes", async () => {
    for (const [item, entry] of [
      ["POST", "/cli/api/hosts/probe"],
      ["DELETE", "/cli/api/hosts/h1"],
    ] as const) {
      expect([item, entry, (await status(item, entry, "admin", {})) === 403]).toEqual([item, entry, false]);
    }
  });
  test("the role none gives 403 on every kind of route", async () => {
    for (const [item, entry] of [
      ["GET", "/api/me"],
      ["GET", "/api/hosts/local/instances"],
      ["POST", "/api/hosts/local/instances"],
      ["GET", "/cli/api/me"],
    ] as const) {
      expect([item, entry, await status(item, entry, "none", {})]).toEqual([item, entry, 403]);
    }
  });
  test("a route with no policy row needs admin", async () => {
    expect(await status("GET", "/api/nope", "write")).toBe(403);
    expect(await status("GET", "/api/nope", "admin")).toBe(404);
  });
  test("a write user who names a user gets 403 on every route that takes one", async () => {
    expect(await status("POST", "/api/hosts/local/instances", "write", { path: "/tmp", user: "alice" })).toBe(403);
    expect(
      await status("POST", "/api/hosts/local/fs/mkdir", "write", { parent: "/tmp", name: "x", user: "alice" }),
    ).toBe(403);
    expect(
      await status("POST", "/api/hosts/local/clone", "write", { repo: "o/x", parent: "/tmp", user: "alice" }),
    ).toBe(403);
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
    const response = await mk().request("/api/hosts/local/instances", {
      method: "POST",
      headers: { ...JSON_H, "x-role": "write" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
  });
  test("the CLI routes follow the same roles", async () => {
    expect(await status("GET", "/cli/api/hosts/local/instances", "read")).toBe(200);
    expect(await status("POST", "/cli/api/hosts/local/instances", "read", { path: "/tmp" })).toBe(403);
    expect(await status("POST", "/cli/api/hosts/local/instances", "write", { path: "/tmp" })).toBe(201);
  });
  test("the page itself loads for any role", async () => {
    const app = createApp({
      cfg,
      instances,
      userAuth: byHeader,
      staticHandler: (item: any) => Promise.resolve(item.text("index")),
    });
    expect((await app.request("/", { headers: { "x-role": "read" } })).status).toBe(200);
  });
});

pass;

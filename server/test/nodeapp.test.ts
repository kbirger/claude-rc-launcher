import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { createNodeApp } from "../src/app";
import type { Config } from "../src/config";
import { HttpError } from "../src/instances";
import { VERSION } from "../src/version";

const cfg = { mode: "node", name: "pi", roots: ["/srv"] } as unknown as Config;
const ID = "0123456789ab";
const inst = { id: ID, path: "/srv/p", name: "n", state: "active", startedAt: null };
const instances: any = {
  list: async () => [inst],
  start: async () => inst,
  stop: async () => {},
  logs: async () => "log",
  users: async () => ({ selectable: false, default: "svc", users: [{ name: "svc" }] }),
};
const auth: MiddlewareHandler = async (c, next) => {
  if (c.req.header("authorization") !== "Bearer ok") return c.json({ error: "unauthorized" }, 401);
  c.set("caller" as never, "secret" as never);
  await next();
};
const app = () => createNodeApp({ cfg, instances, auth });
const ok = { authorization: "Bearer ok" };
const json = { ...ok, "content-type": "application/json" };

let logged: string[] = [];
const realLog = console.log;
beforeEach(() => {
  logged = [];
  console.log = (...a: unknown[]) => void logged.push(a.join(" "));
});
afterEach(() => {
  console.log = realLog;
});

describe("node app", () => {
  test("/healthz is open", async () => {
    expect((await app().request("/healthz")).status).toBe(200);
  });
  test("/api routes need auth", async () => {
    for (const p of ["/api/node", "/api/instances", "/api/fs"]) expect((await app().request(p)).status).toBe(401);
  });
  test("/api/node and instance routes work with auth", async () => {
    const a = app();
    expect(await (await a.request("/api/node", { headers: ok })).json()).toEqual({ ok: true, name: "pi", version: VERSION, clone: false });
    expect(await (await a.request("/api/instances", { headers: ok })).json()).toEqual([inst]);
    expect((await a.request("/api/instances", { method: "POST", headers: json, body: JSON.stringify({ path: "/srv/p" }) })).status).toBe(201);
    expect((await a.request(`/api/instances/${ID}`, { method: "DELETE", headers: json })).status).toBe(204);
    expect(await (await a.request(`/api/instances/${ID}/logs`, { headers: ok })).json()).toEqual({ log: "log" });
  });
  test("/api/users needs auth and returns the info", async () => {
    const a = app();
    expect((await a.request("/api/users")).status).toBe(401);
    expect(await (await a.request("/api/users", { headers: ok })).json()).toEqual({ selectable: false, default: "svc", users: [{ name: "svc" }] });
  });
  test("no browser surface: /auth/login and / are 404", async () => {
    const a = app();
    expect((await a.request("/auth/login", { headers: ok })).status).toBe(404);
    expect((await a.request("/", { headers: ok })).status).toBe(404);
  });
  test("state-changing requests need application/json (415); Origin is ignored", async () => {
    const a = app();
    const noct = await a.request("/api/instances", { method: "POST", headers: ok, body: "{}" });
    expect(noct.status).toBe(415);
    const withOrigin = await a.request("/api/instances", { method: "POST", headers: { ...json, origin: "https://evil.example" }, body: JSON.stringify({ path: "/srv/p" }) });
    expect(withOrigin.status).toBe(201);
  });
  test("a POST emits an audit line with caller, method, path and status", async () => {
    await app().request("/api/instances", { method: "POST", headers: json, body: JSON.stringify({ path: "/srv/p" }) });
    expect(logged.some((l) => l === "audit caller=secret POST /api/instances 201")).toBe(true);
  });
  test("GETs are not audited", async () => {
    await app().request("/api/instances", { headers: ok });
    expect(logged.filter((l) => l.startsWith("audit"))).toEqual([]);
  });

  describe("clone routes", () => {
    const code = "WDJB-MJHT";
    const cloner: any = {
      cloneStart: async () => ({ id: "c".repeat(32), path: "/srv/x" }),
      cloneStatus: async (id: string) => {
        if (id === "b".repeat(32)) throw new HttpError(404, "unknown clone");
        return { state: "running" };
      },
      repos: async () => ({ groups: [] }),
      loginStart: async () => ({ id: "a".repeat(32), code, url: "https://github.com/login/device" }),
      loginStatus: async () => ({ state: "pending" }),
    };
    const capp = () => createNodeApp({ cfg, instances, auth, cloner });
    test("need the bearer proof", async () => {
      const a = capp();
      expect((await a.request("/api/clone", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
      expect((await a.request("/api/github/repos")).status).toBe(401);
      expect((await a.request(`/api/clone/${"a".repeat(32)}`)).status).toBe(401);
      expect((await a.request(`/api/github/login/${"a".repeat(32)}`)).status).toBe(401);
    });
    test("work with auth, need JSON, and /node says clone: true", async () => {
      const a = capp();
      expect((await (await a.request("/api/node", { headers: ok })).json()).clone).toBe(true);
      const c = await a.request("/api/clone", { method: "POST", headers: json, body: JSON.stringify({ repo: "o/x", parent: "/srv" }) });
      expect([c.status, await c.json()]).toEqual([202, { id: "c".repeat(32), path: "/srv/x" }]);
      expect((await (await a.request(`/api/clone/${"c".repeat(32)}`, { headers: ok })).json())).toEqual({ state: "running" });
      const bad = await a.request("/api/clone/xyz", { headers: ok });
      expect([bad.status, await bad.json()]).toEqual([400, { error: "invalid clone id" }]);
      expect((await a.request(`/api/clone/${"b".repeat(32)}`, { headers: ok })).status).toBe(404);
      expect((await a.request("/api/clone", { method: "POST", headers: { ...ok, "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
      expect((await a.request("/api/github/repos", { headers: ok })).status).toBe(200);
      expect((await (await a.request(`/api/github/login/${"a".repeat(32)}`, { headers: ok })).json())).toEqual({ state: "pending" });
    });
    test("each write is audited once and the audit line holds no login code", async () => {
      const a = capp();
      const r = await a.request("/api/github/login", { method: "POST", headers: json, body: "{}" });
      expect(r.status).toBe(202);
      expect((await r.json()).code).toBe(code);
      await a.request("/api/clone", { method: "POST", headers: json, body: JSON.stringify({ repo: "o/x", parent: "/srv" }) });
      await a.request("/api/github/repos", { headers: ok });
      expect(logged).toEqual([
        "audit caller=secret POST /api/github/login 202",
        "audit caller=secret POST /api/clone 202",
      ]);
      expect(logged.join("\n")).not.toContain(code);
    });
    test("without a cloner the routes are 404", async () => {
      const a = app();
      expect((await a.request("/api/github/repos", { headers: ok })).status).toBe(404);
      expect((await a.request("/api/clone", { method: "POST", headers: json, body: "{}" })).status).toBe(404);
    });
  });
});

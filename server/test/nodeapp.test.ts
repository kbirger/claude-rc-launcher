import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { createNodeApp } from "../src/app";
import type { Config } from "../src/config";

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
    expect(await (await a.request("/api/node", { headers: ok })).json()).toEqual({ ok: true, name: "pi" });
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
});

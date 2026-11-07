import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { mintSessionCookie, oidcUserAuth, type OidcClient, type User } from "../src/auth";
import type { UserAuthStrategy } from "../src/userauth";
import type { Config } from "../src/config";
import { HttpError, type Instance } from "../src/instances";
import { PathError } from "../src/paths";

const user: User = { sub: "u1", name: "Ann", email: "a@x.io" };
const ID = "0123456789ab";
let root: string;
let cfg: Config;
let cookie: string;
const oidc: OidcClient = {
  async authorizationUrl() { return "https://idp/authorize"; },
  async exchange() { return user; },
};
const inst: Instance = { id: ID, path: "/p", name: "n", state: "active", startedAt: null };

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "app-")));
  await mkdir(join(root, "sub"));
  cfg = { publicUrl: "https://rc.example.com", roots: [root],
    userAuth: { mode: "oidc", sessionSecret: "s3cret-s3cret-s3cret", oidc: { issuer: "https://idp", clientId: "c", clientSecret: "s" } } } as Config;
  cookie = await mintSessionCookie(cfg, user, Date.now() + 3600_000);
});
afterAll(() => rm(root, { recursive: true, force: true }));

function fake(over: Record<string, any> = {}) {
  const calls: any[] = [];
  const svc: any = {
    list: async () => [inst],
    start: async (i: any) => { calls.push(["start", i]); return inst; },
    stop: async (id: string) => { calls.push(["stop", id]); },
    logs: async (id: string, n: number) => { calls.push(["logs", id, n]); return "log text"; },
    ...over,
  };
  return { svc, calls };
}
const mk = (over: Record<string, any> = {}, staticHandler?: any) => {
  const f = fake(over);
  return { app: createApp({ cfg, instances: f.svc, userAuth: oidcUserAuth(cfg, oidc), staticHandler }), calls: f.calls };
};
const H = (extra: Record<string, string> = {}) => ({ cookie, "content-type": "application/json", ...extra });
const post = (app: any, body: unknown, headers = H()) =>
  app.request("/api/hosts/local/instances", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("error handling", () => {
  test("non-HttpError with numeric status becomes 500 internal error", async () => {
    const orig = console.error;
    console.error = () => {};
    try {
      const e = Object.assign(new Error("secret upstream detail"), { status: 502 });
      const r = await mk({ list: async () => { throw e; } }).app.request("/api/hosts/local/instances", { headers: H() });
      expect(r.status).toBe(500);
      expect(await r.json()).toEqual({ error: "internal error" });
    } finally {
      console.error = orig;
    }
  });
  test("HttpError and PathError pass through", async () => {
    const a = await mk({ list: async () => { throw new HttpError(409, "dup", { instance: 1 }); } }).app.request("/api/hosts/local/instances", { headers: H() });
    expect(a.status).toBe(409);
    expect(await a.json()).toEqual({ instance: 1, error: "dup" });
    const b = await mk({ list: async () => { throw new PathError(403, "outside"); } }).app.request("/api/hosts/local/instances", { headers: H() });
    expect(b.status).toBe(403);
  });
});

describe("auth gate", () => {
  test("healthz is open", async () => {
    const r = await mk().app.request("/healthz");
    expect(r.status).toBe(200);
  });
  test.each([
    ["GET", "/api/hosts/local/instances"], ["POST", "/api/hosts/local/instances"], ["DELETE", `/api/hosts/local/instances/${ID}`],
    ["GET", `/api/hosts/local/instances/${ID}/logs`], ["GET", "/api/hosts/local/fs"], ["POST", "/api/hosts/local/fs/mkdir"], ["GET", "/api/me"],
  ])("%s %s without cookie -> 401", async (method, path) => {
    const r = await mk().app.request(path, { method, headers: { "content-type": "application/json" } });
    expect(r.status).toBe(401);
    expect(await r.json()).toHaveProperty("error");
  });
  test("expired session -> 401", async () => {
    const c = await mintSessionCookie(cfg, user, Date.now() - 1000);
    expect((await mk().app.request("/api/me", { headers: { cookie: c } })).status).toBe(401);
  });
  test("tampered session -> 401", async () => {
    const c = cookie.slice(0, -4) + (cookie.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
    expect((await mk().app.request("/api/me", { headers: { cookie: c } })).status).toBe(401);
  });
  test("session signed with another secret -> 401", async () => {
    const c = await mintSessionCookie({ ...cfg, userAuth: { ...cfg.userAuth, sessionSecret: "other-other-other-x" } as Config["userAuth"] }, user, Date.now() + 1e6);
    expect((await mk().app.request("/api/me", { headers: { cookie: c } })).status).toBe(401);
  });
  test("unknown /api route -> 404 json", async () => {
    const r = await mk().app.request("/api/nope", { headers: H() });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "not found" });
  });
});

describe("csrf", () => {
  test("text/plain -> 415 for POST and DELETE", async () => {
    const { app } = mk();
    expect((await post(app, "{}", H({ "content-type": "text/plain" }))).status).toBe(415);
    const d = await app.request(`/api/hosts/local/instances/${ID}`, { method: "DELETE", headers: H({ "content-type": "text/plain" }) });
    expect(d.status).toBe(415);
  });
  test("missing content-type -> 415", async () => {
    const r = await mk().app.request(`/api/hosts/local/instances/${ID}`, { method: "DELETE", headers: { cookie } });
    expect(r.status).toBe(415);
  });
  test("evil Origin -> 403; matching and absent succeed", async () => {
    const { app } = mk();
    expect((await post(app, { path: "/p" }, H({ origin: "https://evil.example" }))).status).toBe(403);
    expect((await post(app, { path: "/p" }, H({ origin: "https://rc.example.com" }))).status).toBe(201);
    expect((await post(app, { path: "/p" })).status).toBe(201);
  });
  test("charset suffix allowed", async () => {
    const r = await post(mk().app, { path: "/p" }, H({ "content-type": "application/json; charset=utf-8" }));
    expect(r.status).toBe(201);
  });
});

describe("instances", () => {
  test("GET list", async () => {
    const r = await mk().app.request("/api/hosts/local/instances", { headers: H() });
    expect(await r.json()).toEqual([inst]);
  });
  test("POST 201 with body passed to service", async () => {
    const { app, calls } = mk();
    const r = await post(app, { path: "/p", name: "nm" });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual(inst);
    expect(calls[0]).toEqual(["start", { path: "/p", name: "nm" }]);
  });
  test.each([["null"], ["[]"], ['"x"'], ["{}"], ['{"path":5}'], ['{"path":"/p","name":3}'], ["{bad"]])(
    "POST invalid body %s -> 400",
    async (b) => {
      const { app, calls } = mk();
      const r = await post(app, b);
      expect(r.status).toBe(400);
      expect(calls.length).toBe(0);
    },
  );
  test("409 passes through with extra", async () => {
    const { app } = mk({ start: async () => { throw new HttpError(409, "exists", { instance: inst }); } });
    const r = await post(app, { path: "/p" });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "exists", instance: inst });
  });
  test("DELETE bad id -> 400 without calling service; valid -> 204", async () => {
    const { app, calls } = mk();
    expect((await app.request("/api/hosts/local/instances/..%2Fx", { method: "DELETE", headers: H() })).status).toBe(400);
    expect((await app.request("/api/hosts/local/instances/ABCDEF123456", { method: "DELETE", headers: H() })).status).toBe(400);
    expect(calls.length).toBe(0);
    const r = await app.request(`/api/hosts/local/instances/${ID}`, { method: "DELETE", headers: H() });
    expect(r.status).toBe(204);
    expect(calls).toEqual([["stop", ID]]);
  });
  test("DELETE unknown -> 404 from service", async () => {
    const { app } = mk({ stop: async () => { throw new HttpError(404, "instance not found"); } });
    const r = await app.request(`/api/hosts/local/instances/${ID}`, { method: "DELETE", headers: H() });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "instance not found" });
  });
});

describe("logs", () => {
  test("default 100, explicit lines, {log}", async () => {
    const { app, calls } = mk();
    const r = await app.request(`/api/hosts/local/instances/${ID}/logs`, { headers: H() });
    expect(await r.json()).toEqual({ log: "log text" });
    await app.request(`/api/hosts/local/instances/${ID}/logs?lines=7`, { headers: H() });
    expect(calls).toEqual([["logs", ID, 100], ["logs", ID, 7]]);
  });
  test("non-numeric lines -> 400; bad id -> 400", async () => {
    const { app, calls } = mk();
    expect((await app.request(`/api/hosts/local/instances/${ID}/logs?lines=abc`, { headers: H() })).status).toBe(400);
    expect((await app.request(`/api/hosts/local/instances/zzz/logs`, { headers: H() })).status).toBe(400);
    expect(calls.length).toBe(0);
  });
});

describe("fs", () => {
  test("no path returns roots", async () => {
    const r = await mk().app.request("/api/hosts/local/fs", { headers: H() });
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.path).toBe("");
    expect(j.dirs.map((d: any) => d.path)).toEqual([root]);
  });
  test("lists a directory", async () => {
    const r = await mk().app.request(`/api/hosts/local/fs?path=${encodeURIComponent(root)}`, { headers: H() });
    const j: any = await r.json();
    expect(j.dirs.map((d: any) => d.name)).toEqual(["sub"]);
  });
  test("outside roots -> PathError status", async () => {
    const r = await mk().app.request(`/api/hosts/local/fs?path=${encodeURIComponent(tmpdir())}`, { headers: H() });
    expect([400, 403, 404]).toContain(r.status);
  });
  test("mkdir creates", async () => {
    const r = await mk().app.request("/api/hosts/local/fs/mkdir", { method: "POST", headers: H(), body: JSON.stringify({ parent: root, name: "newdir" }) });
    expect(r.status).toBe(201);
    expect(((await r.json()) as any).path).toBe(join(root, "newdir"));
  });
  test("mkdir bad body -> 400", async () => {
    const r = await mk().app.request("/api/hosts/local/fs/mkdir", { method: "POST", headers: H(), body: JSON.stringify({ parent: 1 }) });
    expect(r.status).toBe(400);
  });
});

describe("me, errors, static", () => {
  test("me returns user", async () => {
    const r = await mk().app.request("/api/me", { headers: H() });
    expect(await r.json()).toEqual(user);
  });
  test("PathError and HttpError map to status", async () => {
    const a = mk({ list: async () => { throw new PathError(403, "nope"); } }).app;
    const r = await a.request("/api/hosts/local/instances", { headers: H() });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "nope" });
    const b = mk({ list: async () => { throw new HttpError(502, "bad gw"); } }).app;
    expect((await b.request("/api/hosts/local/instances", { headers: H() })).status).toBe(502);
  });
  test("unexpected error -> 500 without leaking", async () => {
    const orig = console.error;
    console.error = () => {};
    try {
      const a = mk({ list: async () => { throw new Error("secret /etc/path"); } }).app;
      const r = await a.request("/api/hosts/local/instances", { headers: H() });
      expect(r.status).toBe(500);
      expect(await r.json()).toEqual({ error: "internal error" });
    } finally { console.error = orig; }
  });
  test("static handler is behind auth and not used for /api", async () => {
    const sh = async (c: any) => c.text("static");
    const { app } = mk({}, sh);
    const anon = await app.request("/index.html");
    expect(anon.status).toBe(302);
    const r = await app.request("/index.html", { headers: { cookie } });
    expect(await r.text()).toBe("static");
    expect((await app.request("/api/zzz", { headers: H() })).status).toBe(404);
  });
  test("no static handler -> 404 for authed non-api", async () => {
    expect((await mk().app.request("/x", { headers: { cookie } })).status).toBe(404);
  });
});

describe("mkdir owner", () => {
  test("dirOwner is forwarded to makeDir (chown attempted)", async () => {
    if (process.platform === "win32") return; // chown is a no-op on Windows
    // A non-root test process cannot chown to another uid; a failing chown must yield 500.
    const f = fake();
    const app = createApp({ cfg, instances: f.svc, userAuth: oidcUserAuth(cfg, oidc), dirOwner: { uid: 0x7ffffff0, gid: 0x7ffffff0 } });
    const r = await app.request("/api/hosts/local/fs/mkdir", {
      method: "POST", headers: H(), body: JSON.stringify({ parent: root, name: "ownedtest" }),
    });
    if (process.getuid?.() === 0) expect(r.status).toBe(201);
    else expect(r.status).toBe(500);
  });
});

describe("/api/me logoutUrl", () => {
  const strategy = (logoutUrl?: string): UserAuthStrategy => ({
    middleware: async (c, next) => { c.set("user" as never, user as never); await next(); },
    ...(logoutUrl ? { logoutUrl } : {}),
  });
  test("included only when the strategy sets it", async () => {
    const f = fake();
    const withUrl = createApp({ cfg, instances: f.svc, userAuth: strategy("https://x/logout") });
    expect(await (await withUrl.request("/api/me")).json()).toEqual({ ...user, logoutUrl: "https://x/logout" });
    const without = createApp({ cfg, instances: f.svc, userAuth: strategy() });
    expect(await (await without.request("/api/me")).json()).toEqual(user);
  });
});

describe("host-scoped API", () => {
  test("old /api/instances and /api/fs routes are gone", async () => {
    expect((await mk().app.request("/api/instances", { headers: H() })).status).toBe(404);
    expect((await mk().app.request("/api/fs", { headers: H() })).status).toBe(404);
  });
  test("/api/hosts lists the local host", async () => {
    const local = { ...cfg, name: "box" } as Config;
    const f = fake();
    const app = createApp({ cfg: local, instances: f.svc, userAuth: oidcUserAuth(local, oidc) });
    const r = await app.request("/api/hosts", { headers: H() });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([{ id: "local", name: "box", status: "ok" }]);
  });
  test("an unknown host is 404", async () => {
    const r = await mk().app.request("/api/hosts/other/instances", { headers: H() });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "unknown host" });
  });
  test("/api/hosts requires authentication", async () => {
    expect((await mk().app.request("/api/hosts")).status).toBe(401);
  });
});

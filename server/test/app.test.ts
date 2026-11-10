import { closeStreams } from "../src/sse";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { mintSessionCookie, oidcUserAuth, type OidcClient, type User } from "../src/auth";
import type { UserAuthStrategy } from "../src/userauth";
import type { Config } from "../src/config";
import { HttpError, type Instance } from "../src/instances";
import { PathError } from "../src/paths";
import { UpdateRefused, type UpdateReport } from "../src/serviceupdate";
import { VERSION } from "../src/version";
import { LatestError, type createLatestRelease } from "../src/latest";
import type { UpdateEntry, UpdateRecord } from "../src/updaterecord";
import { UpdateLog } from "../src/updatelog";
import type { Presence } from "../src/nodewatcher";

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
  cfg = { publicUrl: "https://rc.example.com", roots: [root], hosts: [],
    userAuth: { mode: "oidc", sessionSecret: "s3cret-s3cret-s3cret", oidc: { issuer: "https://idp", clientId: "c", clientSecret: "s" } } } as unknown as Config;
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
    users: async () => ({ selectable: true, default: "svc", users: [{ name: "svc" }, { name: "alice" }] }),
    trustFilter: async (u?: string) => {
      calls.push(["trustFilter", u]);
      if (u === "nobody") throw new HttpError(400, "unknown user");
      return (p: string) => u === "alice" && p.endsWith("sub");
    },
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

describe("users and trust", () => {
  test("GET /users returns the info", async () => {
    const r = await mk().app.request("/api/hosts/local/users", { headers: H() });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ selectable: true, default: "svc", users: [{ name: "svc" }, { name: "alice" }] });
  });
  test("GET /fs?user=alice marks locks", async () => {
    const r = await mk().app.request(`/api/hosts/local/fs?path=${encodeURIComponent(root)}&user=alice`, { headers: H() });
    const j: any = await r.json();
    expect(j.dirs).toEqual([{ name: "sub", path: join(root, "sub"), trusted: true }]);
  });
  test("GET /fs without user marks trust for the default user", async () => {
    const { app, calls } = mk();
    const r = await app.request(`/api/hosts/local/fs?path=${encodeURIComponent(root)}`, { headers: H() });
    const j: any = await r.json();
    expect(j.dirs[0].trusted).toBe(false);
    expect(calls).toContainEqual(["trustFilter", undefined]);
  });
  test("GET /fs without path marks the roots", async () => {
    const r = await mk().app.request("/api/hosts/local/fs", { headers: H() });
    const j: any = await r.json();
    expect(j.dirs).toEqual([{ name: root, path: root, trusted: false }]);
  });
  test("empty user is 400 on GET /fs and POST /instances", async () => {
    const { app, calls } = mk();
    const a = await app.request(`/api/hosts/local/fs?user=`, { headers: H() });
    expect(a.status).toBe(400);
    expect(await a.json()).toEqual({ error: "user must not be empty" });
    const b = await post(app, { path: "/p", user: "" });
    expect(b.status).toBe(400);
    expect(await b.json()).toEqual({ error: "user must not be empty" });
    expect(calls.length).toBe(0);
  });
  test("GET /fs?user=nobody is 400", async () => {
    const r = await mk().app.request(`/api/hosts/local/fs?path=${encodeURIComponent(root)}&user=nobody`, { headers: H() });
    expect(r.status).toBe(400);
  });
  test("POST /instances forwards user and addTrust", async () => {
    const { app, calls } = mk();
    const r = await post(app, { path: "/p", name: "n", user: "alice", addTrust: true, extra: 1 });
    expect(r.status).toBe(201);
    expect(calls).toEqual([["start", { path: "/p", name: "n", user: "alice", addTrust: true }]]);
  });
  test.each([['{"path":"/p","user":5}'], ['{"path":"/p","user":null}'], ['{"path":"/p","addTrust":"yes"}'], ['{"path":"/p","addTrust":null}']])(
    "POST /instances rejects bad user/addTrust %s with 400",
    async (b) => {
      const { app, calls } = mk();
      const r = await post(app, b);
      expect(r.status).toBe(400);
      expect(calls.length).toBe(0);
    },
  );
  test("a 428 body is passed to the client unchanged", async () => {
    const extra = { code: "untrusted", user: "alice", path: "/p" };
    const { app } = mk({ start: async () => { throw new HttpError(428, "folder not trusted", extra); } });
    const r = await post(app, { path: "/p", user: "alice" });
    expect(r.status).toBe(428);
    expect(await r.json()).toEqual({ ...extra, error: "folder not trusted" });
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
  test("dirOwner is forwarded to makeDir (owner change attempted)", async () => {
    const f = fake();
    const seen: unknown[][] = [];
    const adoptDir = async (p: string, o: { uid: number; gid: number }) => { seen.push([p, o.uid, o.gid]); return { dev: 0, ino: 0 }; };
    const app = createApp({ cfg, instances: f.svc, userAuth: oidcUserAuth(cfg, oidc), dirOwner: { uid: 0x7ffffff0, gid: 0x7ffffff0 }, adoptDir });
    const r = await app.request("/api/hosts/local/fs/mkdir", {
      method: "POST", headers: H(), body: JSON.stringify({ parent: root, name: "ownedtest" }),
    });
    expect(r.status).toBe(201);
    expect(seen).toEqual([[join(root, "ownedtest"), 0x7ffffff0, 0x7ffffff0]]);
  });
  test("a failed owner change gives 500", async () => {
    const f = fake();
    const app = createApp({ cfg, instances: f.svc, userAuth: oidcUserAuth(cfg, oidc), dirOwner: { uid: 1, gid: 1 }, adoptDir: async () => { throw new Error("EPERM"); } });
    const r = await app.request("/api/hosts/local/fs/mkdir", {
      method: "POST", headers: H(), body: JSON.stringify({ parent: root, name: "ownedfail" }),
    });
    expect(r.status).toBe(500);
  });
});

describe("mkdir user", () => {
  const ownerSvc = (seen: (string | undefined)[]) => ({
    dirOwnerFor: async (u?: string) => {
      seen.push(u);
      if (u === "nobody") throw new HttpError(400, "unknown user");
      return undefined;
    },
  });
  const mkdirReq = (app: any, body: unknown) =>
    app.request("/api/hosts/local/fs/mkdir", { method: "POST", headers: H(), body: JSON.stringify(body) });

  test("user is passed to dirOwnerFor", async () => {
    const seen: (string | undefined)[] = [];
    const r = await mkdirReq(mk(ownerSvc(seen)).app, { parent: root, name: "useddir", user: "alice" });
    expect(r.status).toBe(201);
    expect(seen).toEqual(["alice"]);
  });

  test("without user, dirOwnerFor is not called", async () => {
    const seen: (string | undefined)[] = [];
    const r = await mkdirReq(mk(ownerSvc(seen)).app, { parent: root, name: "nouserdir" });
    expect(r.status).toBe(201);
    expect(seen).toEqual([]);
  });

  test("the owner from dirOwnerFor replaces dirOwner", async () => {
    if (process.platform === "win32") return;
    // dirOwner is an owner nobody can chown to here. The process's own ids always work.
    const own = { uid: process.getuid!(), gid: process.getgid!() };
    const f = fake({ dirOwnerFor: async () => own });
    const app = createApp({ cfg, instances: f.svc, userAuth: oidcUserAuth(cfg, oidc), dirOwner: { uid: 0x7ffffff0, gid: 0x7ffffff0 } });
    const r = await mkdirReq(app, { parent: root, name: "aliceowned", user: "alice" });
    expect(r.status).toBe(201);
    expect((await stat(join(root, "aliceowned"))).uid).toBe(own.uid);
  });

  test("bad user is 400 and no folder is made", async () => {
    const seen: (string | undefined)[] = [];
    const app = mk(ownerSvc(seen)).app;
    for (const [user, msg] of [[5, "user must be a string"], ["", "user must not be empty"], ["nobody", "unknown user"]] as const) {
      const r = await mkdirReq(app, { parent: root, name: "baduserdir", user });
      expect(r.status).toBe(400);
      expect(((await r.json()) as any).error).toBe(msg);
    }
    expect(seen).toEqual(["nobody"]);
    expect(existsSync(join(root, "baduserdir"))).toBe(false);
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
    expect(await r.json()).toEqual([{ id: "local", name: "box", status: "ok", version: VERSION, noClient: true, platform: process.platform, stale: false }]);
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

describe("POST /update on the local host", () => {
  const withUpdate = (update?: { run(release?: string): Promise<UpdateReport> }) =>
    createApp({ cfg, instances: fake().svc, userAuth: oidcUserAuth(cfg, oidc), ...(update ? { update } : {}) });
  const update = (app: any, body: unknown = {}) => app.request("/api/hosts/local/update", { method: "POST", headers: H(), body: JSON.stringify(body) });

  test("without an updater it is 501", async () => {
    const r = await update(withUpdate());
    expect(r.status).toBe(501);
    expect(await r.json()).toEqual({ error: "update is not available on this host" });
  });

  test("a restarting report is 202; the other reports are 200", async () => {
    const reports: UpdateReport[] = [
      { status: "restarting", from: "1", to: "2", clients: [] },
      { status: "up-to-date", from: "2", clients: [] },
      { status: "clients-only", from: "2", clients: [{ path: "/usr/local/bin/claude-rc", status: "updated" }] },
      { status: "failed", from: "2", clients: [], error: "the checksum does not match" },
    ];
    for (const [report, status] of reports.map((r, i) => [r, i === 0 ? 202 : 200] as const)) {
      const r = await update(withUpdate({ run: async () => report }));
      expect([report.status, r.status]).toEqual([report.status, status]);
      expect(await r.json()).toEqual(report);
    }
  });

  test("a refusal keeps its status and message; another error is 500 with its message", async () => {
    const busy = await update(withUpdate({ run: async () => { throw new UpdateRefused(409, "another update is running on this machine"); } }));
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: "another update is running on this machine" });
    const bad = await update(withUpdate({ run: async () => { throw new UpdateRefused(400, "release must be a version tag such as v1.2.3"); } }));
    expect(bad.status).toBe(400);
    const err = console.error;
    console.error = () => {};
    let boom: Response;
    try {
      boom = await update(withUpdate({ run: async () => { throw new Error("disk full"); } }));
    } finally {
      console.error = err;
    }
    expect(boom.status).toBe(500);
    expect(await boom.json()).toEqual({ error: "disk full" });
  });

  test("GET /node returns ok, name and version", async () => {
    const r = await withUpdate().request("/api/hosts/local/node", { headers: H() });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, name: cfg.name, version: VERSION, platform: process.platform, clone: false, clients: [] });
  });
});

describe("clone routes", () => {
  const calls: any[] = [];
  const cloner: any = {
    cloneStart: async (i: any) => { calls.push(["clone", i]); return { id: "c".repeat(32), path: "/r/x" }; },
    cloneStatus: async (id: string) => {
      if (id === "b".repeat(32)) throw new HttpError(404, "unknown clone");
      return { state: "done", path: "/r/x" };
    },
    repos: async (u?: string) => { calls.push(["repos", u]); return { groups: [{ owner: "o", repos: [] }] }; },
    loginStart: async (u?: string) => { calls.push(["start", u]); return { id: "a".repeat(32), code: "ABCD-1234", url: "https://github.com/login/device" }; },
    loginStatus: async (id: string) => {
      if (id === "b".repeat(32)) throw new HttpError(404, "unknown login");
      return { state: "failed", error: "denied" };
    },
    activeClones: () => [],
  };
  const withCloner = () => createApp({ cfg, instances: fake().svc, userAuth: oidcUserAuth(cfg, oidc), cloner });
  const base = "/api/hosts/local";
  const req = (app: any, method: string, p: string, body?: unknown, headers = H()) =>
    app.request(base + p, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  test("each route returns the cloner's result", async () => {
    calls.length = 0;
    const app = withCloner();
    const c = await req(app, "POST", "/clone", { repo: "o/x", parent: "/r", user: "alice", junk: 1 });
    expect([c.status, await c.json()]).toEqual([202, { id: "c".repeat(32), path: "/r/x" }]);
    expect(calls[0]).toEqual(["clone", { repo: "o/x", parent: "/r", user: "alice" }]);
    const cs = await req(app, "GET", `/clone/${"c".repeat(32)}`);
    expect([cs.status, await cs.json()]).toEqual([200, { state: "done", path: "/r/x" }]);
    const g = await req(app, "GET", "/github/repos?user=alice");
    expect([g.status, await g.json()]).toEqual([200, { groups: [{ owner: "o", repos: [] }] }]);
    expect(calls[1]).toEqual(["repos", "alice"]);
    const l = await req(app, "POST", "/github/login", { user: "alice" });
    expect([l.status, await l.json()]).toEqual([202, { id: "a".repeat(32), code: "ABCD-1234", url: "https://github.com/login/device" }]);
    expect(calls[2]).toEqual(["start", "alice"]);
    const s = await req(app, "GET", `/github/login/${"a".repeat(32)}`);
    expect([s.status, await s.json()]).toEqual([200, { state: "failed", error: "denied" }]);
  });
  test("login without a body object field means no user; repos without user passes undefined", async () => {
    calls.length = 0;
    const app = withCloner();
    expect((await req(app, "POST", "/github/login", {})).status).toBe(202);
    expect((await req(app, "GET", "/github/repos")).status).toBe(200);
    expect(calls).toEqual([["start", undefined], ["repos", undefined]]);
  });
  test("validation and error cases", async () => {
    const app = withCloner();
    expect((await req(app, "POST", "/clone", { repo: "o/x" })).status).toBe(400);
    const e = await req(app, "GET", "/github/repos?user=");
    expect([e.status, await e.json()]).toEqual([400, { error: "user must not be empty" }]);
    const bad = await req(app, "GET", "/github/login/xyz");
    expect([bad.status, await bad.json()]).toEqual([400, { error: "invalid login id" }]);
    expect((await req(app, "GET", `/github/login/${"b".repeat(32)}`)).status).toBe(404);
    const badc = await req(app, "GET", "/clone/xyz");
    expect([badc.status, await badc.json()]).toEqual([400, { error: "invalid clone id" }]);
    const unk = await req(app, "GET", `/clone/${"b".repeat(32)}`);
    expect([unk.status, await unk.json()]).toEqual([404, { error: "unknown clone" }]);
    expect((await req(app, "POST", "/github/login", [])).status).toBe(400);
  });
  test("POST routes need a JSON content type", async () => {
    const app = withCloner();
    const h = { cookie, "content-type": "text/plain" };
    expect((await req(app, "POST", "/clone", { repo: "o/x", parent: "/r" }, h)).status).toBe(415);
    expect((await req(app, "POST", "/github/login", {}, h)).status).toBe(415);
  });
  test("/node reports clone: true", async () => {
    expect((await (await req(withCloner(), "GET", "/node")).json()).clone).toBe(true);
  });
  test("a start in or under a folder with a running clone gives 409 before start is called", async () => {
    const cloning = join(root, "cloning");
    await mkdir(join(cloning, "deep"), { recursive: true });
    await mkdir(join(root, "cloning-sibling"), { recursive: true });
    const f = fake();
    const app = createApp({ cfg, instances: f.svc, userAuth: oidcUserAuth(cfg, oidc), cloner: { ...cloner, activeClones: () => [cloning] } });
    for (const path of [cloning, join(cloning, "deep"), join(cloning, "deep", "..")]) {
      const r = await post(app, { path, addTrust: true });
      expect([r.status, await r.json()]).toEqual([409, { error: "a clone is still running in that folder" }]);
    }
    expect(f.calls.filter((c: any[]) => c[0] === "start")).toEqual([]);
    // A sibling whose name starts the same way is not inside the clone.
    expect((await post(app, { path: join(root, "cloning-sibling") })).status).toBe(201);
    // A path that does not resolve goes to start, which gives its own error.
    expect((await post(app, { path: "/nonexistent/x" })).status).toBe(201);
    expect(f.calls.filter((c: any[]) => c[0] === "start").length).toBe(2);
  });

  test("with no running clone, start is called as before", async () => {
    const f = fake();
    const app = createApp({ cfg, instances: f.svc, userAuth: oidcUserAuth(cfg, oidc), cloner });
    expect((await post(app, { path: join(root, "cloning") })).status).toBe(201);
  });

  test("without a cloner the routes are 404", async () => {
    const app = mk().app;
    for (const [m, p] of [["POST", "/clone"], ["GET", `/clone/${"a".repeat(32)}`], ["GET", "/github/repos"], ["POST", "/github/login"], ["GET", `/github/login/${"a".repeat(32)}`]]) {
      expect((await req(app, m!, p!, m === "POST" ? {} : undefined)).status).toBe(404);
    }
  });
});

describe("GET /api/latest", () => {
  const withLatest = (latest?: ReturnType<typeof createLatestRelease>) =>
    createApp({ cfg, instances: fake().svc, userAuth: oidcUserAuth(cfg, oidc), ...(latest ? { latest } : {}) });
  const get = (app: any) => app.request("/api/latest", { headers: H() });

  test("returns the latest release", async () => {
    const body = { version: "0.8.3", checkedAt: "2026-11-09T00:00:00.000Z" };
    const r = await get(withLatest({ get: async () => body, peek: () => body }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(body);
  });

  test("503 when GitHub cannot be reached and nothing is cached", async () => {
    const r = await get(withLatest({ get: async () => { throw new LatestError("offline"); }, peek: () => undefined }));
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "offline" });
  });

  test("without a session it is rejected", async () => {
    const latest = { get: async () => ({ version: "1", checkedAt: "x" }), peek: () => undefined };
    const r = await withLatest(latest).request("/api/latest");
    expect(r.status).toBe(401);
  });

  test("501 without a latest cache", async () => {
    expect((await get(withLatest())).status).toBe(501);
  });
});

describe("GET /api/updates and /api/events", () => {
  const entry = (host: string): UpdateEntry => ({ host, startedAt: "2026-11-09T00:00:00.000Z", startedBy: "a", from: "0.8.2", status: "running" });
  const fakeRecord = (initial: UpdateEntry[] = []) => {
    const listeners = new Set<(e: UpdateEntry) => void>();
    const rec = {
      list: () => initial.map((e) => ({ ...e })),
      onChange: (fn: (e: UpdateEntry) => void) => (listeners.add(fn), () => void listeners.delete(fn)),
      emit: (e: UpdateEntry) => listeners.forEach((l) => l(e)),
      count: () => listeners.size,
    };
    return rec;
  };
  const pres = (host: string, status: Presence["status"] = "online"): Presence => ({ host, status, version: "1.0.0", at: "2026-11-09T00:00:00.000Z" });
  const fakePresence = (initial: Presence[] = []) => {
    const listeners = new Set<(p: Presence) => void>();
    return {
      list: () => initial.map((p) => ({ ...p })),
      onChange: (fn: (p: Presence) => void) => (listeners.add(fn), () => void listeners.delete(fn)),
      emit: (p: Presence) => listeners.forEach((l) => l(p)),
      count: () => listeners.size,
    };
  };
  const mk = (rec?: ReturnType<typeof fakeRecord>, keepaliveMs?: number, extra: Record<string, unknown> = {}) =>
    createApp({ cfg, instances: fake().svc, userAuth: oidcUserAuth(cfg, oidc), ...(rec ? { updates: rec as unknown as UpdateRecord } : {}), ...(keepaliveMs ? { keepaliveMs } : {}), ...extra });
  const readUntil = async (reader: ReadableStreamDefaultReader<Uint8Array>, re: RegExp) => {
    const dec = new TextDecoder();
    let text = "";
    while (!re.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value);
    }
    return text;
  };
  const gone = async (...counts: (() => number)[]) => {
    for (let i = 0; i < 50 && counts.some((c) => c() > 0); i++) await Bun.sleep(10);
  };
  const CLI_TOKEN = "cli-token";
  const cliAuth = (async (c, next) => (c.req.header("authorization") === `Bearer ${CLI_TOKEN}` ? (c.set("user" as never, user as never), next()) : c.json({ error: "unauthorized" }, 401))) as import("hono").MiddlewareHandler;
  const withCli = { cli: { issuer: "https://i", clientId: "c", auth: cliAuth, makeClient: (() => undefined) as any, enrollment: { hubKeys: [] } } };
  const routes: [string, () => Record<string, string>][] = [
    ["/api/events", () => H()],
    ["/cli/api/events", () => ({ authorization: `Bearer ${CLI_TOKEN}` })],
  ];

  test("GET /api/updates returns the list", async () => {
    const r = await mk(fakeRecord([entry("nas")])).request("/api/updates", { headers: H() });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([entry("nas")]);
  });

  for (const [url, hdr] of routes) {
    test(`${url}: snapshot first with updates, logs and presence, then update, log and presence events; cancel removes every listener`, async () => {
      const rec = fakeRecord([entry("nas")]);
      const log = new UpdateLog();
      log.add("nas", "hello", "2026-11-09T00:00:01.000Z");
      const presence = fakePresence([pres("nas")]);
      const app = mk(rec, undefined, { updateLog: log, presence, ...withCli });
      const r = await app.request(url, { headers: hdr() });
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/event-stream");
      expect(r.headers.get("cache-control")).toBe("no-cache");
      // HTTP/2 forbids connection-specific headers. A proxy that forwards them makes a browser fail with ERR_HTTP2_PROTOCOL_ERROR.
      expect(r.headers.get("transfer-encoding")).toBeNull();
      expect(r.headers.get("connection")).toBeNull();
      const r2 = await app.request(url, { headers: hdr() });
      const reader = r.body!.getReader();
      const reader2 = r2.body!.getReader();
      const snap = `event: snapshot\ndata: ${JSON.stringify({ updates: [entry("nas")], logs: { nas: [{ line: "hello", at: "2026-11-09T00:00:01.000Z" }] }, presence: [pres("nas")] })}\n\n`;
      expect(await readUntil(reader, /\n\n/)).toBe(snap);
      expect(await readUntil(reader2, /\n\n/)).toBe(snap);
      expect([rec.count(), presence.count()]).toEqual([2, 2]);
      rec.emit(entry("box"));
      log.add("box", "line 1", "2026-11-09T00:00:02.000Z");
      presence.emit(pres("box", "offline"));
      for (const rd of [reader, reader2]) {
        const text = await readUntil(rd, /event: presence\ndata: .*\n\n/);
        expect(text).toBe(
          `event: update\ndata: ${JSON.stringify(entry("box"))}\n\n` +
            `event: log\ndata: ${JSON.stringify({ host: "box", line: "line 1", at: "2026-11-09T00:00:02.000Z" })}\n\n` +
            `event: presence\ndata: ${JSON.stringify(pres("box", "offline"))}\n\n`,
        );
      }
      await reader.cancel();
      await reader2.cancel();
      const lines = () => (log as any).subs.size as number;
      await gone(rec.count, presence.count, lines);
      expect([rec.count(), presence.count(), lines()]).toEqual([0, 0, 0]);
    });

    test(`${url}: without updateLog and presence the snapshot has empty logs and presence`, async () => {
      const r = await mk(fakeRecord(), undefined, withCli).request(url, { headers: hdr() });
      const reader = r.body!.getReader();
      expect(await readUntil(reader, /\n\n/)).toBe(`event: snapshot\ndata: ${JSON.stringify({ updates: [], logs: {}, presence: [] })}\n\n`);
      await reader.cancel();
    });

    test(`${url}: a keepalive comment arrives on the interval`, async () => {
      const r = await mk(fakeRecord([entry("nas")]), 20, withCli).request(url, { headers: hdr() });
      const reader = r.body!.getReader();
      const text = await readUntil(reader, /: keepalive\n\n/);
      expect(text).toStartWith(`event: snapshot\ndata: ${JSON.stringify({ updates: [entry("nas")], logs: {}, presence: [] })}\n\n`);
      await reader.cancel();
    });

    test(`${url}: closeStreams ends the stream with a proper end of body`, async () => {
      const app = mk(fakeRecord(), undefined, withCli);
      const r = await app.request(url, { headers: hdr() });
      const reader = r.body!.getReader();
      await readUntil(reader, /\n\n/);
      closeStreams(app);
      let done = false;
      for (let i = 0; i < 20 && !done; i++) done = (await reader.read()).done;
      expect(done).toBe(true);
    });

    test(`${url}: without a login it is 401`, async () => {
      expect((await mk(fakeRecord(), undefined, withCli).request(url)).status).toBe(401);
    });

    test(`${url}: 501 without an update record`, async () => {
      expect((await mk(undefined, undefined, withCli).request(url, { headers: hdr() })).status).toBe(501);
    });
  }

  test("GET /api/updates without a session is rejected", async () => {
    expect((await mk(fakeRecord()).request("/api/updates")).status).toBe(401);
  });

  test("GET /api/updates/history returns the history, needs a session and answers 501 without one", async () => {
    const history = { list: () => ({ nas: [{ entry: { ...entry("nas"), status: "updated" }, lines: [{ line: "hi", at: "t" }] }] }) };
    const r = await mk(fakeRecord(), undefined, { history }).request("/api/updates/history", { headers: H() });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).nas[0].lines[0].line).toBe("hi");
    expect((await mk(fakeRecord(), undefined, { history }).request("/api/updates/history")).status).toBe(401);
    expect((await mk(fakeRecord()).request("/api/updates/history", { headers: H() })).status).toBe(501);
  });

  test("501 without an update record for /api/updates", async () => {
    expect((await mk().request("/api/updates", { headers: H() })).status).toBe(501);
  });
});

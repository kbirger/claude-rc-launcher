import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { mintSessionCookie, oidcUserAuth } from "../src/auth";
import type { OidcClient, User } from "../src/auth";
import type { Config } from "../src/config";
import { HttpError } from "../src/instances";
import type { Instance } from "../src/instances";
import { SETTINGS_HELP } from "../src/instancesettings";
import { LatestError } from "../src/latest";
import type { createLatestRelease } from "../src/latest";
import type { Presence } from "../src/nodewatcher";
import { PathError } from "../src/paths";
import { UpdateRefused } from "../src/serviceupdate";
import type { UpdateReport } from "../src/serviceupdate";
import { closeStreams } from "../src/sse";
import { staticHandler } from "../src/static";
import { UpdateLog } from "../src/updatelog";
import type { UpdateEntry, UpdateRecord } from "../src/updaterecord";
import type { UserAuthStrategy } from "../src/userauth";
import { VERSION } from "../src/version";
import { defined } from "./support";

const user: User = { sub: "u1", name: "Ann", email: "a@x.io", role: "admin" };
const ID = "0123456789ab";
let root: string;
let cfg: Config;
let cookie: string;
const oidc: OidcClient = {
  authorizationUrl() {
    return Promise.resolve("https://idp/authorize");
  },
  exchange() {
    return Promise.resolve(user);
  },
};
const inst: Instance = { id: ID, path: "/p", name: "n", state: "active", startedAt: null };

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "app-")));
  await mkdir(join(root, "sub"));
  cfg = {
    publicUrl: "https://rc.example.com",
    roots: [root],
    hosts: [],
    claudeRcArgs: [],
    userAuth: {
      mode: "oidc",
      sessionSecret: "s3cret-s3cret-s3cret",
      oidc: { issuer: "https://idp", clientId: "c", clientSecret: "s" },
    },
  } as unknown as Config;
  cookie = await mintSessionCookie(cfg, user, Date.now() + 3600_000);
});
afterAll(() => rm(root, { recursive: true, force: true }));

function fake(over: Record<string, any> = {}) {
  const calls: any[] = [];
  const svc: any = {
    list: () => Promise.resolve([inst]),
    start: (item: any) => {
      calls.push(["start", item]);
      return Promise.resolve(inst);
    },
    stop: (id: string) => {
      calls.push(["stop", id]);
      return Promise.resolve();
    },
    pause: (id: string) => {
      calls.push(["pause", id]);
      return Promise.resolve();
    },
    resume: (id: string) => {
      calls.push(["resume", id]);
      return Promise.resolve();
    },
    logs: (id: string, count: number) => {
      calls.push(["logs", id, count]);
      return Promise.resolve("log text");
    },
    users: () => Promise.resolve({ selectable: true, default: "svc", users: [{ name: "svc" }, { name: "alice" }] }),
    trustFilter: (item?: string) => {
      calls.push(["trustFilter", item]);
      if (item === "nobody") return Promise.reject(new HttpError(400, "unknown user"));
      return Promise.resolve((entry: string) => item === "alice" && entry.endsWith("sub"));
    },
    ...over,
  };
  return { svc, calls };
}

const mk = (over: Record<string, any> = {}, staticHandler?: any) => {
  const harness = fake(over);
  return {
    app: createApp({ cfg, instances: harness.svc, userAuth: oidcUserAuth(cfg, oidc), staticHandler }),
    calls: harness.calls,
  };
};

const helper = (extra: Record<string, string> = {}) => ({ cookie, "content-type": "application/json", ...extra });
const post = (app: any, body: unknown, headers = helper()) =>
  app.request("/api/hosts/local/instances", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("PWA files", () => {
  const files = new Map([
    ["/index.html", { path: "/dev/null", type: "text/html" }],
    ["/manifest.webmanifest", { path: "/dev/null", type: "application/manifest+json" }],
    ["/service-worker.js", { path: "/dev/null", type: "text/javascript" }],
  ]);
  let app: any;
  beforeAll(() => {
    app = mk({}, staticHandler(files)).app;
  });
  test("the manifest and the service worker load without a login", async () => {
    expect((await app.request("/manifest.webmanifest")).status).toBe(200);
    expect((await app.request("/service-worker.js")).status).toBe(200);
  });
  test("other pages still redirect to login", async () => {
    const response = await app.request("/");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/auth/login");
  });
});

describe("error handling", () => {
  test("non-HttpError with numeric status becomes 500 internal error", async () => {
    const orig = console.error;

    console.error = () => {};

    try {
      const error = Object.assign(new Error("secret upstream detail"), { status: 502 });
      const response = await mk({
        list: () => {
          return Promise.reject(error);
        },
      }).app.request("/api/hosts/local/instances", { headers: helper() });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "internal error" });
    } finally {
      console.error = orig;
    }
  });
  test("HttpError and PathError pass through", async () => {
    const response = await mk({
      list: () => {
        return Promise.reject(new HttpError(409, "dup", { instance: 1 }));
      },
    }).app.request("/api/hosts/local/instances", { headers: helper() });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ instance: 1, error: "dup" });
    const reply = await mk({
      list: () => {
        return Promise.reject(new PathError(403, "outside"));
      },
    }).app.request("/api/hosts/local/instances", { headers: helper() });
    expect(reply.status).toBe(403);
  });
});

describe("auth gate", () => {
  test("healthz is open", async () => {
    const response = await mk().app.request("/healthz");
    expect(response.status).toBe(200);
  });
  test.each([
    ["GET", "/api/hosts/local/instances"],
    ["POST", "/api/hosts/local/instances"],
    ["DELETE", `/api/hosts/local/instances/${ID}`],
    ["GET", `/api/hosts/local/instances/${ID}/logs`],
    ["GET", "/api/hosts/local/fs"],
    ["POST", "/api/hosts/local/fs/mkdir"],
    ["GET", "/api/me"],
  ])("%s %s without cookie -> 401", async (method, path) => {
    const response = await mk().app.request(path, { method, headers: { "content-type": "application/json" } });
    expect(response.status).toBe(401);
    expect(await response.json()).toHaveProperty("error");
  });
  test("expired session -> 401", async () => {
    const item = await mintSessionCookie(cfg, user, Date.now() - 1000);
    expect((await mk().app.request("/api/me", { headers: { cookie: item } })).status).toBe(401);
  });
  test("tampered session -> 401", async () => {
    const item = cookie.slice(0, -4) + (cookie.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect((await mk().app.request("/api/me", { headers: { cookie: item } })).status).toBe(401);
  });
  test("session signed with another secret -> 401", async () => {
    const item = await mintSessionCookie(
      { ...cfg, userAuth: { ...cfg.userAuth, sessionSecret: "other-other-other-x" } as Config["userAuth"] },
      user,
      Date.now() + 1e6,
    );
    expect((await mk().app.request("/api/me", { headers: { cookie: item } })).status).toBe(401);
  });
  test("unknown /api route -> 404 json", async () => {
    const response = await mk().app.request("/api/nope", { headers: helper() });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  });
});

describe("csrf", () => {
  test("text/plain -> 415 for POST and DELETE", async () => {
    const { app } = mk();
    expect((await post(app, "{}", helper({ "content-type": "text/plain" }))).status).toBe(415);
    const response = await app.request(`/api/hosts/local/instances/${ID}`, {
      method: "DELETE",
      headers: helper({ "content-type": "text/plain" }),
    });
    expect(response.status).toBe(415);
  });
  test("missing content-type -> 415", async () => {
    const response = await mk().app.request(`/api/hosts/local/instances/${ID}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(response.status).toBe(415);
  });
  test("evil Origin -> 403; matching and absent succeed", async () => {
    const { app } = mk();
    expect((await post(app, { path: "/p" }, helper({ origin: "https://evil.example" }))).status).toBe(403);
    expect((await post(app, { path: "/p" }, helper({ origin: "https://rc.example.com" }))).status).toBe(201);
    expect((await post(app, { path: "/p" })).status).toBe(201);
  });
  test("charset suffix allowed", async () => {
    const response = await post(
      mk().app,
      { path: "/p" },
      helper({ "content-type": "application/json; charset=utf-8" }),
    );
    expect(response.status).toBe(201);
  });
});

describe("instances", () => {
  test("GET list", async () => {
    const response = await mk().app.request("/api/hosts/local/instances", { headers: helper() });
    expect(await response.json()).toEqual([inst]);
  });
  test("POST 201 with body passed to service", async () => {
    const { app, calls } = mk();
    const response = await post(app, { path: "/p", name: "nm" });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(inst);
    expect(calls[0]).toEqual(["start", { path: "/p", name: "nm" }]);
  });
  test.each([["null"], ["[]"], ['"x"'], ["{}"], ['{"path":5}'], ['{"path":"/p","name":3}'], ["{bad"]])(
    "POST invalid body %s -> 400",
    async (item) => {
      const { app, calls } = mk();
      const response = await post(app, item);
      expect(response.status).toBe(400);
      expect(calls.length).toBe(0);
    },
  );
  test("409 passes through with extra", async () => {
    const { app } = mk({
      start: () => {
        return Promise.reject(new HttpError(409, "exists", { instance: inst }));
      },
    });
    const response = await post(app, { path: "/p" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "exists", instance: inst });
  });
  test("DELETE bad id -> 400 without calling service; valid -> 204", async () => {
    const { app, calls } = mk();
    expect(
      (await app.request("/api/hosts/local/instances/..%2Fx", { method: "DELETE", headers: helper() })).status,
    ).toBe(400);
    expect(
      (await app.request("/api/hosts/local/instances/ABCDEF123456", { method: "DELETE", headers: helper() })).status,
    ).toBe(400);
    expect(calls.length).toBe(0);
    const response = await app.request(`/api/hosts/local/instances/${ID}`, { method: "DELETE", headers: helper() });
    expect(response.status).toBe(204);
    expect(calls).toEqual([["stop", ID]]);
  });
  test("POST pause and resume: bad id -> 400; valid -> 204; a backend without them -> 501", async () => {
    const { app, calls } = mk();
    expect(
      (await app.request("/api/hosts/local/instances/..%2Fx/pause", { method: "POST", headers: helper() })).status,
    ).toBe(400);
    expect(
      (await app.request(`/api/hosts/local/instances/${ID}/pause`, { method: "POST", headers: helper() })).status,
    ).toBe(204);
    expect(
      (await app.request(`/api/hosts/local/instances/${ID}/resume`, { method: "POST", headers: helper() })).status,
    ).toBe(204);
    expect(calls).toEqual([
      ["pause", ID],
      ["resume", ID],
    ]);
    const none = mk({ pause: undefined });
    expect(
      (await none.app.request(`/api/hosts/local/instances/${ID}/pause`, { method: "POST", headers: helper() })).status,
    ).toBe(501);
  });
  test("PATCH settings: 200 with previous, bad body 400, bad id 400, no backend support 501, 409 keeps its extra fields", async () => {
    const prev = { createSession: true, spawnMode: "same-dir" };
    const { app, calls } = mk({
      update: (id: string, item: any) => {
        calls.push(["update", id, item]);
        return Promise.resolve({ instance: inst, previous: prev, applied: false });
      },
    });
    const url = `/api/hosts/local/instances/${ID}`;
    const patch = (item: string, body: unknown) =>
      app.request(item, { method: "PATCH", headers: helper(), body: JSON.stringify(body) });
    const response = await patch(url, { createSession: false });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ instance: inst, previous: prev, applied: false });
    expect(calls).toEqual([["update", ID, { createSession: false }]]);
    expect((await patch(url, {})).status).toBe(400);
    expect((await patch("/api/hosts/local/instances/..%2Fx", { createSession: false })).status).toBe(400);
    const none = mk({ update: undefined });
    expect(
      (
        await none.app.request(url, {
          method: "PATCH",
          headers: helper(),
          body: JSON.stringify({ createSession: false }),
        })
      ).status,
    ).toBe(501);
    const refused = mk({
      update: () => {
        return Promise.reject(
          new HttpError(409, "claude refused the setting", { code: "settings_refused", settings: prev }),
        );
      },
    });
    const r2 = await refused.app.request(url, {
      method: "PATCH",
      headers: helper(),
      body: JSON.stringify({ spawnMode: "worktree" }),
    });
    expect(r2.status).toBe(409);
    expect(await r2.json()).toEqual({ code: "settings_refused", settings: prev, error: "claude refused the setting" });
  });
  test("POST restart: 204, bad id 400, no backend support 501", async () => {
    const { app, calls } = mk({
      restart: (id: string) => {
        calls.push(["restart", id]);
        return Promise.resolve();
      },
    });
    expect(
      (await app.request(`/api/hosts/local/instances/${ID}/restart`, { method: "POST", headers: helper() })).status,
    ).toBe(204);
    expect(
      (await app.request("/api/hosts/local/instances/..%2Fx/restart", { method: "POST", headers: helper() })).status,
    ).toBe(400);
    expect(calls).toEqual([["restart", ID]]);
    const none = mk({ restart: undefined });
    expect(
      (await none.app.request(`/api/hosts/local/instances/${ID}/restart`, { method: "POST", headers: helper() }))
        .status,
    ).toBe(501);
  });
  test("GET instance-settings returns the help object", async () => {
    const { app } = mk();
    const response = await app.request("/api/hosts/local/instance-settings", { headers: helper() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...SETTINGS_HELP,
      defaults: { createSession: true, spawnMode: "same-dir" },
    });
  });
  test("GET instance-settings returns the node defaults from the operator list", async () => {
    const get = async (claudeRcArgs: string[]) => {
      const local = { ...cfg, claudeRcArgs };
      const app = createApp({ cfg: local, instances: fake().svc, userAuth: oidcUserAuth(local, oidc) });
      return (await (await app.request("/api/hosts/local/instance-settings", { headers: helper() })).json()).defaults;
    };

    expect(await get(["--no-create-session-in-dir", "--spawn", "worktree"])).toEqual({
      createSession: false,
      spawnMode: "worktree",
    });
    expect(await get(["--spawn", "same-dir"])).toEqual({ createSession: true, spawnMode: "same-dir" });
  });
  test("POST start passes the sent settings to the backend and none when absent", async () => {
    const { app, calls } = mk();
    const post = (body: unknown) =>
      app.request("/api/hosts/local/instances", { method: "POST", headers: helper(), body: JSON.stringify(body) });
    expect((await post({ path: root, spawnMode: "worktree" })).status).toBe(201);
    expect((await post({ path: root })).status).toBe(201);
    expect(calls[0][1].settings).toEqual({ spawnMode: "worktree" });
    expect("settings" in calls[1][1]).toBe(false);
  });
  test("DELETE unknown -> 404 from service", async () => {
    const { app } = mk({
      stop: () => {
        return Promise.reject(new HttpError(404, "instance not found"));
      },
    });
    const response = await app.request(`/api/hosts/local/instances/${ID}`, { method: "DELETE", headers: helper() });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "instance not found" });
  });
});

describe("logs", () => {
  test("default 100, explicit lines, {log}", async () => {
    const { app, calls } = mk();
    const response = await app.request(`/api/hosts/local/instances/${ID}/logs`, { headers: helper() });
    expect(await response.json()).toEqual({ log: "log text" });
    await app.request(`/api/hosts/local/instances/${ID}/logs?lines=7`, { headers: helper() });
    expect(calls).toEqual([
      ["logs", ID, 100],
      ["logs", ID, 7],
    ]);
  });
  test("non-numeric lines -> 400; bad id -> 400", async () => {
    const { app, calls } = mk();
    expect((await app.request(`/api/hosts/local/instances/${ID}/logs?lines=abc`, { headers: helper() })).status).toBe(
      400,
    );
    expect((await app.request(`/api/hosts/local/instances/zzz/logs`, { headers: helper() })).status).toBe(400);
    expect(calls.length).toBe(0);
  });
});

describe("users and trust", () => {
  test("GET /users returns the info", async () => {
    const response = await mk().app.request("/api/hosts/local/users", { headers: helper() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      selectable: true,
      default: "svc",
      users: [{ name: "svc" }, { name: "alice" }],
    });
  });
  test("GET /fs?user=alice marks locks", async () => {
    const response = await mk().app.request(`/api/hosts/local/fs?path=${encodeURIComponent(root)}&user=alice`, {
      headers: helper(),
    });
    const body: any = await response.json();
    expect(body.dirs).toEqual([{ name: "sub", path: join(root, "sub"), trusted: true }]);
  });
  test("GET /fs without user marks trust for the default user", async () => {
    const { app, calls } = mk();
    const response = await app.request(`/api/hosts/local/fs?path=${encodeURIComponent(root)}`, { headers: helper() });
    const body: any = await response.json();
    expect(body.dirs[0].trusted).toBe(false);
    expect(calls).toContainEqual(["trustFilter", undefined]);
  });
  test("GET /fs without path marks the roots", async () => {
    const response = await mk().app.request("/api/hosts/local/fs", { headers: helper() });
    const body: any = await response.json();
    expect(body.dirs).toEqual([{ name: root, path: root, trusted: false }]);
  });
  test("empty user is 400 on GET /fs and POST /instances", async () => {
    const { app, calls } = mk();
    const response = await app.request(`/api/hosts/local/fs?user=`, { headers: helper() });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "user must not be empty" });
    const reply = await post(app, { path: "/p", user: "" });
    expect(reply.status).toBe(400);
    expect(await reply.json()).toEqual({ error: "user must not be empty" });
    expect(calls.length).toBe(0);
  });
  test("GET /fs?user=nobody is 400", async () => {
    const response = await mk().app.request(`/api/hosts/local/fs?path=${encodeURIComponent(root)}&user=nobody`, {
      headers: helper(),
    });
    expect(response.status).toBe(400);
  });
  test("POST /instances forwards user and addTrust", async () => {
    const { app, calls } = mk();
    const response = await post(app, { path: "/p", name: "n", user: "alice", addTrust: true, extra: 1 });
    expect(response.status).toBe(201);
    expect(calls).toEqual([["start", { path: "/p", name: "n", user: "alice", addTrust: true }]]);
  });
  test.each([
    ['{"path":"/p","user":5}'],
    ['{"path":"/p","user":null}'],
    ['{"path":"/p","addTrust":"yes"}'],
    ['{"path":"/p","addTrust":null}'],
  ])("POST /instances rejects bad user/addTrust %s with 400", async (item) => {
    const { app, calls } = mk();
    const response = await post(app, item);
    expect(response.status).toBe(400);
    expect(calls.length).toBe(0);
  });
  test("a 428 body is passed to the client unchanged", async () => {
    const extra = { code: "untrusted", user: "alice", path: "/p" };
    const { app } = mk({
      start: () => {
        return Promise.reject(new HttpError(428, "folder not trusted", extra));
      },
    });
    const response = await post(app, { path: "/p", user: "alice" });
    expect(response.status).toBe(428);
    expect(await response.json()).toEqual({ ...extra, error: "folder not trusted" });
  });
});

describe("fs", () => {
  test("no path returns roots", async () => {
    const response = await mk().app.request("/api/hosts/local/fs", { headers: helper() });
    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.path).toBe("");
    expect(body.dirs.map((dir: any) => dir.path)).toEqual([root]);
  });
  test("lists a directory", async () => {
    const response = await mk().app.request(`/api/hosts/local/fs?path=${encodeURIComponent(root)}`, {
      headers: helper(),
    });
    const body: any = await response.json();
    expect(body.dirs.map((dir: any) => dir.name)).toEqual(["sub"]);
  });
  test("outside roots -> PathError status", async () => {
    const response = await mk().app.request(`/api/hosts/local/fs?path=${encodeURIComponent(tmpdir())}`, {
      headers: helper(),
    });
    expect([400, 403, 404]).toContain(response.status);
  });
  test("mkdir creates", async () => {
    const response = await mk().app.request("/api/hosts/local/fs/mkdir", {
      method: "POST",
      headers: helper(),
      body: JSON.stringify({ parent: root, name: "newdir" }),
    });
    expect(response.status).toBe(201);
    expect((await response.json()).path).toBe(join(root, "newdir"));
  });
  test("mkdir bad body -> 400", async () => {
    const response = await mk().app.request("/api/hosts/local/fs/mkdir", {
      method: "POST",
      headers: helper(),
      body: JSON.stringify({ parent: 1 }),
    });
    expect(response.status).toBe(400);
  });
});

describe("me, errors, static", () => {
  test("me returns user", async () => {
    const response = await mk().app.request("/api/me", { headers: helper() });
    expect(await response.json()).toEqual(user);
  });
  test("PathError and HttpError map to status", async () => {
    const hono = mk({
      list: () => {
        return Promise.reject(new PathError(403, "nope"));
      },
    }).app;
    const response = await hono.request("/api/hosts/local/instances", { headers: helper() });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "nope" });
    const item = mk({
      list: () => {
        return Promise.reject(new HttpError(502, "bad gw"));
      },
    }).app;
    expect((await item.request("/api/hosts/local/instances", { headers: helper() })).status).toBe(502);
  });
  test("unexpected error -> 500 without leaking", async () => {
    const orig = console.error;

    console.error = () => {};

    try {
      const hono = mk({
        list: () => {
          return Promise.reject(new Error("secret /etc/path"));
        },
      }).app;
      const response = await hono.request("/api/hosts/local/instances", { headers: helper() });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "internal error" });
    } finally {
      console.error = orig;
    }
  });
  test("static handler is behind auth and not used for /api", async () => {
    const sh = (item: any) => Promise.resolve(item.text("static"));
    const { app } = mk({}, sh);
    const anon = await app.request("/index.html");
    expect(anon.status).toBe(302);
    const response = await app.request("/index.html", { headers: { cookie } });
    expect(await response.text()).toBe("static");
    expect((await app.request("/api/zzz", { headers: helper() })).status).toBe(404);
  });
  test("no static handler -> 404 for authed non-api", async () => {
    expect((await mk().app.request("/x", { headers: { cookie } })).status).toBe(404);
  });
});

describe("mkdir owner", () => {
  test("dirOwner is forwarded to makeDir (owner change attempted)", async () => {
    const harness = fake();
    const seen: unknown[][] = [];

    const adoptDir = (path: string, options: { uid: number; gid: number }) => {
      seen.push([path, options.uid, options.gid]);
      return Promise.resolve({ dev: 0, ino: 0 });
    };

    const app = createApp({
      cfg,
      instances: harness.svc,
      userAuth: oidcUserAuth(cfg, oidc),
      dirOwner: { uid: 0x7ffffff0, gid: 0x7ffffff0 },
      adoptDir,
    });
    const response = await app.request("/api/hosts/local/fs/mkdir", {
      method: "POST",
      headers: helper(),
      body: JSON.stringify({ parent: root, name: "ownedtest" }),
    });
    expect(response.status).toBe(201);
    expect(seen).toEqual([[join(root, "ownedtest"), 0x7ffffff0, 0x7ffffff0]]);
  });
  test("a failed owner change gives 500", async () => {
    const harness = fake();
    const app = createApp({
      cfg,
      instances: harness.svc,
      userAuth: oidcUserAuth(cfg, oidc),
      dirOwner: { uid: 1, gid: 1 },
      adoptDir: () => {
        return Promise.reject(new Error("EPERM"));
      },
    });
    const response = await app.request("/api/hosts/local/fs/mkdir", {
      method: "POST",
      headers: helper(),
      body: JSON.stringify({ parent: root, name: "ownedfail" }),
    });
    expect(response.status).toBe(500);
  });
});

describe("mkdir user", () => {
  const ownerSvc = (seen: (string | undefined)[]) => ({
    dirOwnerFor: (item?: string) => {
      seen.push(item);
      if (item === "nobody") return Promise.reject(new HttpError(400, "unknown user"));
      return Promise.resolve(undefined);
    },
  });
  const mkdirReq = (app: any, body: unknown) =>
    app.request("/api/hosts/local/fs/mkdir", { method: "POST", headers: helper(), body: JSON.stringify(body) });

  test("user is passed to dirOwnerFor", async () => {
    const seen: (string | undefined)[] = [];
    const response = await mkdirReq(mk(ownerSvc(seen)).app, { parent: root, name: "useddir", user: "alice" });
    expect(response.status).toBe(201);
    expect(seen).toEqual(["alice"]);
  });

  test("without user, dirOwnerFor is not called", async () => {
    const seen: (string | undefined)[] = [];
    const response = await mkdirReq(mk(ownerSvc(seen)).app, { parent: root, name: "nouserdir" });
    expect(response.status).toBe(201);
    expect(seen).toEqual([]);
  });

  test("the owner from dirOwnerFor replaces dirOwner", async () => {
    if (process.platform === "win32") return;
    // dirOwner is an owner nobody can chown to here. The process's own ids always work.
    const own = { uid: defined(process.getuid)(), gid: defined(process.getgid)() };
    const harness = fake({ dirOwnerFor: () => Promise.resolve(own) });
    const app = createApp({
      cfg,
      instances: harness.svc,
      userAuth: oidcUserAuth(cfg, oidc),
      dirOwner: { uid: 0x7ffffff0, gid: 0x7ffffff0 },
    });
    const response = await mkdirReq(app, { parent: root, name: "aliceowned", user: "alice" });
    expect(response.status).toBe(201);
    expect((await stat(join(root, "aliceowned"))).uid).toBe(own.uid);
  });

  test("bad user is 400 and no folder is made", async () => {
    const seen: (string | undefined)[] = [];
    const app = mk(ownerSvc(seen)).app;

    for (const [user, msg] of [
      [5, "user must be a string"],
      ["", "user must not be empty"],
      ["nobody", "unknown user"],
    ] as const) {
      const response = await mkdirReq(app, { parent: root, name: "baduserdir", user });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(msg);
    }

    expect(seen).toEqual(["nobody"]);
    expect(existsSync(join(root, "baduserdir"))).toBe(false);
  });
});

describe("/api/me logoutUrl", () => {
  const strategy = (logoutUrl?: string): UserAuthStrategy => ({
    middleware: async (context, next) => {
      context.set("user" as never, user as never);
      await next();
    },
    ...(logoutUrl ? { logoutUrl } : {}),
  });
  test("included only when the strategy sets it", async () => {
    const harness = fake();
    const withUrl = createApp({ cfg, instances: harness.svc, userAuth: strategy("https://x/logout") });
    expect(await (await withUrl.request("/api/me")).json()).toEqual({ ...user, logoutUrl: "https://x/logout" });
    const without = createApp({ cfg, instances: harness.svc, userAuth: strategy() });
    expect(await (await without.request("/api/me")).json()).toEqual(user);
  });
});

describe("host-scoped API", () => {
  test("old /api/instances and /api/fs routes are gone", async () => {
    expect((await mk().app.request("/api/instances", { headers: helper() })).status).toBe(404);
    expect((await mk().app.request("/api/fs", { headers: helper() })).status).toBe(404);
  });
  test("/api/hosts lists the local host", async () => {
    const local = { ...cfg, name: "box" };
    const harness = fake();
    const app = createApp({ cfg: local, instances: harness.svc, userAuth: oidcUserAuth(local, oidc) });
    const response = await app.request("/api/hosts", { headers: helper() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      {
        id: "local",
        name: "box",
        status: "ok",
        version: VERSION,
        noClient: true,
        platform: process.platform,
        stale: false,
      },
    ]);
  });
  test("an unknown host is 404", async () => {
    const response = await mk().app.request("/api/hosts/other/instances", { headers: helper() });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "unknown host" });
  });
  test("/api/hosts requires authentication", async () => {
    expect((await mk().app.request("/api/hosts")).status).toBe(401);
  });
});

describe("POST /update on the local host", () => {
  const withUpdate = (update?: { run(release?: string): Promise<UpdateReport> }) =>
    createApp({ cfg, instances: fake().svc, userAuth: oidcUserAuth(cfg, oidc), ...(update ? { update } : {}) });
  const update = (app: any, body: unknown = {}) =>
    app.request("/api/hosts/local/update", { method: "POST", headers: helper(), body: JSON.stringify(body) });

  test("without an updater it is 501", async () => {
    const response = await update(withUpdate());
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ error: "update is not available on this host" });
  });

  test("a restarting report is 202; the other reports are 200", async () => {
    const reports: UpdateReport[] = [
      { status: "restarting", from: "1", to: "2", clients: [] },
      { status: "up-to-date", from: "2", clients: [] },
      { status: "clients-only", from: "2", clients: [{ path: "/usr/local/bin/claude-rc", status: "updated" }] },
      { status: "failed", from: "2", clients: [], error: "the checksum does not match" },
    ];

    for (const [report, status] of reports.map(
      (updateReport, index) => [updateReport, index === 0 ? 202 : 200] as const,
    )) {
      const response = await update(withUpdate({ run: () => Promise.resolve(report) }));
      expect([report.status, response.status]).toEqual([report.status, status]);
      expect(await response.json()).toEqual(report);
    }
  });

  test("a refusal keeps its status and message; another error is 500 with its message", async () => {
    const busy = await update(
      withUpdate({
        run: () => {
          return Promise.reject(new UpdateRefused(409, "another update is running on this machine"));
        },
      }),
    );
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: "another update is running on this machine" });
    const bad = await update(
      withUpdate({
        run: () => {
          return Promise.reject(new UpdateRefused(400, "release must be a version tag such as v1.2.3"));
        },
      }),
    );
    expect(bad.status).toBe(400);
    const err = console.error;

    console.error = () => {};

    let boom: Response;

    try {
      boom = await update(
        withUpdate({
          run: () => {
            return Promise.reject(new Error("disk full"));
          },
        }),
      );
    } finally {
      console.error = err;
    }

    expect(boom.status).toBe(500);
    expect(await boom.json()).toEqual({ error: "disk full" });
  });

  test("GET /node returns ok, name and version", async () => {
    const response = await withUpdate().request("/api/hosts/local/node", { headers: helper() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      name: cfg.name,
      version: VERSION,
      platform: process.platform,
      clone: false,
      clients: [],
    });
  });
});

describe("clone routes", () => {
  const calls: any[] = [];
  const cloner: any = {
    cloneStart: (item: any) => {
      calls.push(["clone", item]);
      return Promise.resolve({ id: "c".repeat(32), path: "/r/x" });
    },
    cloneStatus: (id: string) => {
      if (id === "b".repeat(32)) return Promise.reject(new HttpError(404, "unknown clone"));
      return Promise.resolve({ state: "done", path: "/r/x" });
    },
    repos: (item?: string) => {
      calls.push(["repos", item]);
      return Promise.resolve({ groups: [{ owner: "o", repos: [] }] });
    },
    loginStart: (item?: string) => {
      calls.push(["start", item]);
      return Promise.resolve({ id: "a".repeat(32), code: "ABCD-1234", url: "https://github.com/login/device" });
    },
    loginStatus: (id: string) => {
      if (id === "b".repeat(32)) return Promise.reject(new HttpError(404, "unknown login"));
      return Promise.resolve({ state: "failed", error: "denied" });
    },
    activeClones: () => [],
  };
  const withCloner = () => createApp({ cfg, instances: fake().svc, userAuth: oidcUserAuth(cfg, oidc), cloner });
  const base = "/api/hosts/local";
  const req = (app: any, method: string, item: string, body?: unknown, headers = helper()) =>
    app.request(base + item, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  test("each route returns the cloner's result", async () => {
    calls.length = 0;
    const app = withCloner();
    const response = await req(app, "POST", "/clone", { repo: "o/x", parent: "/r", user: "alice", junk: 1 });
    expect([response.status, await response.json()]).toEqual([202, { id: "c".repeat(32), path: "/r/x" }]);
    expect(calls[0]).toEqual(["clone", { repo: "o/x", parent: "/r", user: "alice" }]);
    const cs = await req(app, "GET", `/clone/${"c".repeat(32)}`);
    expect([cs.status, await cs.json()]).toEqual([200, { state: "done", path: "/r/x" }]);
    const reply = await req(app, "GET", "/github/repos?user=alice");
    expect([reply.status, await reply.json()]).toEqual([200, { groups: [{ owner: "o", repos: [] }] }]);
    expect(calls[1]).toEqual(["repos", "alice"]);
    const res = await req(app, "POST", "/github/login", { user: "alice" });
    expect([res.status, await res.json()]).toEqual([
      202,
      { id: "a".repeat(32), code: "ABCD-1234", url: "https://github.com/login/device" },
    ]);
    expect(calls[2]).toEqual(["start", "alice"]);
    const element = await req(app, "GET", `/github/login/${"a".repeat(32)}`);
    expect([element.status, await element.json()]).toEqual([200, { state: "failed", error: "denied" }]);
  });
  test("login without a body object field means no user; repos without user passes undefined", async () => {
    calls.length = 0;
    const app = withCloner();
    expect((await req(app, "POST", "/github/login", {})).status).toBe(202);
    expect((await req(app, "GET", "/github/repos")).status).toBe(200);
    expect(calls).toEqual([
      ["start", undefined],
      ["repos", undefined],
    ]);
  });
  test("validation and error cases", async () => {
    const app = withCloner();
    expect((await req(app, "POST", "/clone", { repo: "o/x" })).status).toBe(400);
    const response = await req(app, "GET", "/github/repos?user=");
    expect([response.status, await response.json()]).toEqual([400, { error: "user must not be empty" }]);
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
    const item = { cookie, "content-type": "text/plain" };
    expect((await req(app, "POST", "/clone", { repo: "o/x", parent: "/r" }, item)).status).toBe(415);
    expect((await req(app, "POST", "/github/login", {}, item)).status).toBe(415);
  });
  test("/node reports clone: true", async () => {
    expect((await (await req(withCloner(), "GET", "/node")).json()).clone).toBe(true);
  });
  test("a start in or under a folder with a running clone gives 409 before start is called", async () => {
    const cloning = join(root, "cloning");
    await mkdir(join(cloning, "deep"), { recursive: true });
    await mkdir(join(root, "cloning-sibling"), { recursive: true });
    const harness = fake();
    const app = createApp({
      cfg,
      instances: harness.svc,
      userAuth: oidcUserAuth(cfg, oidc),
      cloner: { ...cloner, activeClones: () => [cloning] },
    });

    for (const path of [cloning, join(cloning, "deep"), join(cloning, "deep", "..")]) {
      const response = await post(app, { path, addTrust: true });
      expect([response.status, await response.json()]).toEqual([
        409,
        { error: "a clone is still running in that folder" },
      ]);
    }

    expect(harness.calls.filter((call: any[]) => call[0] === "start")).toEqual([]);
    // A sibling whose name starts the same way is not inside the clone.
    expect((await post(app, { path: join(root, "cloning-sibling") })).status).toBe(201);
    // A path that does not resolve goes to start, which gives its own error.
    expect((await post(app, { path: "/nonexistent/x" })).status).toBe(201);
    expect(harness.calls.filter((call: any[]) => call[0] === "start").length).toBe(2);
  });

  test("with no running clone, start is called as before", async () => {
    const harness = fake();
    const app = createApp({ cfg, instances: harness.svc, userAuth: oidcUserAuth(cfg, oidc), cloner });
    expect((await post(app, { path: join(root, "cloning") })).status).toBe(201);
  });

  test("without a cloner the routes are 404", async () => {
    const app = mk().app;

    for (const [item, entry] of [
      ["POST", "/clone"],
      ["GET", `/clone/${"a".repeat(32)}`],
      ["GET", "/github/repos"],
      ["POST", "/github/login"],
      ["GET", `/github/login/${"a".repeat(32)}`],
    ]) {
      expect((await req(app, item, entry, item === "POST" ? {} : undefined)).status).toBe(404);
    }
  });
});

describe("GET /api/latest", () => {
  const withLatest = (latest?: ReturnType<typeof createLatestRelease>) =>
    createApp({ cfg, instances: fake().svc, userAuth: oidcUserAuth(cfg, oidc), ...(latest ? { latest } : {}) });
  const get = (app: any) => app.request("/api/latest", { headers: helper() });

  test("returns the latest release", async () => {
    const body = { version: "0.8.3", checkedAt: "2026-11-09T00:00:00.000Z" };
    const response = await get(withLatest({ get: () => Promise.resolve(body), peek: () => body }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(body);
  });

  test("503 when GitHub cannot be reached and nothing is cached", async () => {
    const response = await get(
      withLatest({
        get: () => {
          return Promise.reject(new LatestError("offline"));
        },
        peek: () => undefined,
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "offline" });
  });

  test("without a session it is rejected", async () => {
    const latest = { get: () => Promise.resolve({ version: "1", checkedAt: "x" }), peek: () => undefined };
    const response = await withLatest(latest).request("/api/latest");
    expect(response.status).toBe(401);
  });

  test("501 without a latest cache", async () => {
    expect((await get(withLatest())).status).toBe(501);
  });
});

describe("GET /api/updates and /api/events", () => {
  const entry = (host: string): UpdateEntry => ({
    host,
    startedAt: "2026-11-09T00:00:00.000Z",
    startedBy: "a",
    from: "0.8.2",
    status: "running",
  });

  const fakeRecord = (initial: UpdateEntry[] = []) => {
    const listeners = new Set<(updateEntry: UpdateEntry) => void>();
    const rec = {
      list: () => initial.map((updateEntry) => ({ ...updateEntry })),
      onChange: (fn: (updateEntry: UpdateEntry) => void) => (listeners.add(fn), () => void listeners.delete(fn)),
      emit: (updateEntry: UpdateEntry) => {
        listeners.forEach((listener) => {
          listener(updateEntry);
        });
      },
      count: () => listeners.size,
    };
    return rec;
  };

  const pres = (host: string, status: Presence["status"] = "online"): Presence => ({
    host,
    status,
    version: "1.0.0",
    at: "2026-11-09T00:00:00.000Z",
  });

  const fakePresence = (initial: Presence[] = []) => {
    const listeners = new Set<(presence: Presence) => void>();
    return {
      list: () => initial.map((presence) => ({ ...presence })),
      onChange: (fn: (presence: Presence) => void) => (listeners.add(fn), () => void listeners.delete(fn)),
      emit: (presence: Presence) => {
        listeners.forEach((listener) => {
          listener(presence);
        });
      },
      count: () => listeners.size,
    };
  };

  const mk = (rec?: ReturnType<typeof fakeRecord>, keepaliveMs?: number, extra: Record<string, unknown> = {}) =>
    createApp({
      cfg,
      instances: fake().svc,
      userAuth: oidcUserAuth(cfg, oidc),
      ...(rec ? { updates: rec as unknown as UpdateRecord } : {}),
      ...(keepaliveMs ? { keepaliveMs } : {}),
      ...extra,
    });

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
    for (let index = 0; index < 50 && counts.some((callback) => callback() > 0); index++) await Bun.sleep(10);
  };

  const CLI_TOKEN = "cli-token";
  const cliAuth = (async (context, next) =>
    context.req.header("authorization") === `Bearer ${CLI_TOKEN}`
      ? (context.set("user" as never, user as never), next())
      : context.json({ error: "unauthorized" }, 401)) as import("hono").MiddlewareHandler;
  const withCli = {
    cli: {
      issuer: "https://i",
      clientId: "c",
      auth: cliAuth,
      makeClient: (() => undefined) as any,
      enrollment: { hubKeys: [] },
    },
  };
  const routes: [string, () => Record<string, string>][] = [
    ["/api/events", () => helper()],
    ["/cli/api/events", () => ({ authorization: `Bearer ${CLI_TOKEN}` })],
  ];

  test("GET /api/updates returns the list", async () => {
    const response = await mk(fakeRecord([entry("nas")])).request("/api/updates", { headers: helper() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([entry("nas")]);
  });

  for (const [url, hdr] of routes) {
    test(`${url}: snapshot first with updates, logs and presence, then update, log and presence events; cancel removes every listener`, async () => {
      const rec = fakeRecord([entry("nas")]);
      const log = new UpdateLog();
      log.add("nas", "hello", "2026-11-09T00:00:01.000Z");
      const presence = fakePresence([pres("nas")]);
      const app = mk(rec, undefined, { updateLog: log, presence, ...withCli });
      const response = await app.request(url, { headers: hdr() });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.headers.get("cache-control")).toBe("no-cache");
      // HTTP/2 forbids connection-specific headers. A proxy that forwards them makes a browser fail with ERR_HTTP2_PROTOCOL_ERROR.
      expect(response.headers.get("transfer-encoding")).toBeNull();
      expect(response.headers.get("connection")).toBeNull();
      const r2 = await app.request(url, { headers: hdr() });
      const reader = defined(response.body).getReader();
      const reader2 = defined(r2.body).getReader();
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
      const response = await mk(fakeRecord(), undefined, withCli).request(url, { headers: hdr() });
      const reader = defined(response.body).getReader();
      expect(await readUntil(reader, /\n\n/)).toBe(
        `event: snapshot\ndata: ${JSON.stringify({ updates: [], logs: {}, presence: [] })}\n\n`,
      );
      await reader.cancel();
    });

    test(`${url}: a keepalive comment arrives on the interval`, async () => {
      const response = await mk(fakeRecord([entry("nas")]), 20, withCli).request(url, { headers: hdr() });
      const reader = defined(response.body).getReader();
      const text = await readUntil(reader, /: keepalive\n\n/);
      expect(text).toStartWith(
        `event: snapshot\ndata: ${JSON.stringify({ updates: [entry("nas")], logs: {}, presence: [] })}\n\n`,
      );
      await reader.cancel();
    });

    test(`${url}: closeStreams ends the stream with a proper end of body`, async () => {
      const app = mk(fakeRecord(), undefined, withCli);
      const response = await app.request(url, { headers: hdr() });
      const reader = defined(response.body).getReader();
      await readUntil(reader, /\n\n/);
      closeStreams(app);
      let done = false;
      for (let index = 0; index < 20 && !done; index++) done = (await reader.read()).done;
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
    const history = {
      list: () => ({ nas: [{ entry: { ...entry("nas"), status: "updated" }, lines: [{ line: "hi", at: "t" }] }] }),
    };
    const response = await mk(fakeRecord(), undefined, { history }).request("/api/updates/history", {
      headers: helper(),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).nas[0].lines[0].line).toBe("hi");
    expect((await mk(fakeRecord(), undefined, { history }).request("/api/updates/history")).status).toBe(401);
    expect((await mk(fakeRecord()).request("/api/updates/history", { headers: helper() })).status).toBe(501);
  });

  test("501 without an update record for /api/updates", async () => {
    expect((await mk().request("/api/updates", { headers: helper() })).status).toBe(501);
  });
});

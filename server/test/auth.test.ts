import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createOidcClient, oidcUserAuth, type OidcClient, type User } from "../src/auth";
import type { Config } from "../src/config";

const user: User = { sub: "u1", name: "Ann", email: "a@x.io" };
const withSecret = (c: Config, s: string): Config => ({ ...c, userAuth: { ...c.userAuth, sessionSecret: s } });
const mkCfg = (publicUrl = "https://rc.example.com"): Config =>
  ({ publicUrl, userAuth: { mode: "oidc", sessionSecret: "s3cret-s3cret-s3cret", oidc: { issuer: "https://idp", clientId: "c", clientSecret: "s" } } }) as Config;

function stub(fail = false) {
  const calls: any[] = [];
  const oidc: OidcClient = {
    async authorizationUrl(p) {
      calls.push(["url", p]);
      return `https://idp/authorize?state=${p.state}`;
    },
    async exchange(p) {
      calls.push(["exchange", p]);
      if (fail) throw new Error("bad code");
      return user;
    },
  };
  return { oidc, calls };
}

function build(cfg = mkCfg(), oidc = stub().oidc, now = () => 1_000_000) {
  const ua = oidcUserAuth(cfg, oidc, now);
  const app = new Hono();
  app.route("/auth", ua.routes!);
  app.use("*", ua.middleware);
  app.get("/", (c) => c.json({ user: c.get("user" as never) }));
  app.get("/api/x", (c) => c.json({ ok: true }));
  return app;
}

const setCookies = (r: Response) => r.headers.getSetCookie();
const find = (r: Response, name: string) => setCookies(r).find((c) => c.startsWith(name + "="));
const pair = (sc: string) => sc.split(";")[0]!;
const CLEARED = /Max-Age=0|Expires=Thu, 01 Jan 1970/;
const tamper = (p: string) => p.slice(0, -4) + (p.slice(-4) === "AAAA" ? "BBBB" : "AAAA");

async function login(app: Hono) {
  const r = await app.request("/auth/login");
  const sc = find(r, "oidc_state")!;
  const url = new URL(r.headers.get("location")!);
  return { r, sc, state: url.searchParams.get("state")! };
}

describe("login", () => {
  test("discovery failure -> 502 readable page, logged", async () => {
    const oidc: OidcClient = { async authorizationUrl() { throw new Error("discovery down"); }, async exchange() { return user; } };
    const orig = console.error;
    const logged: unknown[][] = [];
    console.error = (...a: unknown[]) => { logged.push(a); };
    try {
      const r = await build(mkCfg(), oidc).request("/auth/login");
      expect(r.status).toBe(502);
      expect(r.headers.get("content-type")).toContain("text/html");
      expect(await r.text()).toContain("identity provider");
      expect(find(r, "oidc_state")).toBeUndefined();
    } finally {
      console.error = orig;
    }
    expect(logged.length).toBe(1);
  });
  test("redirects to provider and sets short-lived signed state cookie", async () => {
    const s = stub();
    const app = build(mkCfg(), s.oidc);
    const { r, sc, state } = await login(app);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toStartWith("https://idp/authorize");
    expect(sc).toContain("HttpOnly");
    expect(sc).toContain("SameSite=Lax");
    expect(sc).toContain("Max-Age=600");
    expect(sc).toContain("Path=/auth");
    expect(s.calls[0][1].redirectUri).toBe("https://rc.example.com/auth/callback");
    expect(s.calls[0][1].codeVerifier.length).toBeGreaterThan(20);
    expect(state.length).toBeGreaterThan(10);
  });
  test("trailing slash on publicUrl is stripped", async () => {
    const s = stub();
    await build(mkCfg("https://rc.example.com/"), s.oidc).request("/auth/login");
    expect(s.calls[0][1].redirectUri).toBe("https://rc.example.com/auth/callback");
  });
});

describe("allowed_users", () => {
  const withAllowed = (allowed: string[]): Config => {
    const c = mkCfg();
    return { ...c, userAuth: { ...c.userAuth, allowedUsers: allowed } } as Config;
  };
  test("user not on the list -> 403 and no session cookie", async () => {
    const s = stub();
    const app = build(withAllowed(["someone-else"]), s.oidc);
    const { sc, state } = await login(app);
    const r = await app.request(`/auth/callback?code=abc&state=${state}`, { headers: { cookie: pair(sc) } });
    expect(r.status).toBe(403);
    expect(find(r, "session")).toBeUndefined();
  });
  test("listed user (by email) gets a session", async () => {
    const s = stub();
    const app = build(withAllowed(["a@x.io"]), s.oidc);
    const { sc, state } = await login(app);
    const r = await app.request(`/auth/callback?code=abc&state=${state}`, { headers: { cookie: pair(sc) } });
    expect(r.status).toBe(302);
    expect(find(r, "session")).toBeDefined();
  });
});

describe("callback", () => {
  test("matching state sets session cookie and redirects to /", async () => {
    const s = stub();
    const app = build(mkCfg(), s.oidc);
    const { sc, state } = await login(app);
    const r = await app.request(`/auth/callback?code=abc&state=${state}&next=//evil.com`, { headers: { cookie: pair(sc) } });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/");
    const sess = find(r, "session")!;
    expect(sess).toContain("HttpOnly");
    expect(sess).toContain("SameSite=Lax");
    expect(sess).toContain("Max-Age=43200");
    expect(sess).toContain("Path=/");
    expect(sess).toContain("Secure");
    const ex = s.calls.find((c) => c[0] === "exchange")[1];
    expect(ex.state).toBe(state);
    expect(ex.callbackUrl.searchParams.get("code")).toBe("abc");
    expect(ex.redirectUri).toBe("https://rc.example.com/auth/callback");
    expect(find(r, "oidc_state")).toMatch(CLEARED);
    const me = await app.request("/", { headers: { cookie: pair(sess) } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as any).user).toEqual(user);
  });
  test("Secure flag absent for http publicUrl", async () => {
    const app = build(mkCfg("http://localhost:8080"));
    const { sc, state } = await login(app);
    const r = await app.request(`/auth/callback?code=a&state=${state}`, { headers: { cookie: pair(sc) } });
    expect(find(r, "session")).toBeDefined();
    expect(find(r, "session")).not.toContain("Secure");
  });
  async function expectFail(r: Response) {
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBeString();
    expect(find(r, "session")).toBeUndefined();
    expect(find(r, "oidc_state")).toMatch(CLEARED);
  }
  test("missing state cookie -> 400", async () => {
    const app = build();
    const { state } = await login(app);
    await expectFail(await app.request(`/auth/callback?code=a&state=${state}`));
  });
  test("missing state param -> 400", async () => {
    const app = build();
    const { sc } = await login(app);
    await expectFail(await app.request(`/auth/callback?code=a`, { headers: { cookie: pair(sc) } }));
  });
  test("mismatched state -> 400", async () => {
    const app = build();
    const { sc } = await login(app);
    await expectFail(await app.request(`/auth/callback?code=a&state=other`, { headers: { cookie: pair(sc) } }));
  });
  test("tampered state cookie -> 400", async () => {
    const app = build();
    const { sc, state } = await login(app);
    await expectFail(await app.request(`/auth/callback?code=a&state=${state}`, { headers: { cookie: tamper(pair(sc)) } }));
  });
  test("exchange error -> 400, no session", async () => {
    const app = build(mkCfg(), stub(true).oidc);
    const { sc, state } = await login(app);
    await expectFail(await app.request(`/auth/callback?code=a&state=${state}`, { headers: { cookie: pair(sc) } }));
  });
});

describe("logout", () => {
  test("clears session and redirects to /", async () => {
    const r = await build().request("/auth/logout");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/");
    expect(find(r, "session")).toMatch(CLEARED);
  });
});

describe("requireUser", () => {
  async function session(app: Hono) {
    const { sc, state } = await login(app);
    const r = await app.request(`/auth/callback?code=a&state=${state}`, { headers: { cookie: pair(sc) } });
    return pair(find(r, "session")!);
  }
  test("no cookie: 401 for api, 302 for pages", async () => {
    const app = build();
    const a = await app.request("/api/x");
    expect(a.status).toBe(401);
    expect(await a.json()).toEqual({ error: "unauthenticated" });
    const p = await app.request("/");
    expect(p.status).toBe(302);
    expect(p.headers.get("location")).toBe("/auth/login");
  });
  test("valid session passes", async () => {
    const app = build();
    const ck = await session(app);
    expect((await app.request("/api/x", { headers: { cookie: ck } })).status).toBe(200);
  });
  test("tampered cookie rejected", async () => {
    const app = build();
    const ck = await session(app);
    expect((await app.request("/api/x", { headers: { cookie: tamper(ck) } })).status).toBe(401);
    expect((await app.request("/", { headers: { cookie: tamper(ck) } })).status).toBe(302);
  });
  test("payload tampered with old signature rejected", async () => {
    let t = 1_000_000;
    const app = build(mkCfg(), stub().oidc, () => t);
    const ck = await session(app);
    const decoded = decodeURIComponent(ck.slice("session=".length));
    const i = decoded.lastIndexOf(".");
    const payload = JSON.parse(decoded.slice(0, i));
    const sig = decoded.slice(i);
    const forge = (p: object) => `session=${encodeURIComponent(JSON.stringify(p) + sig)}`;
    expect((await app.request("/api/x", { headers: { cookie: ck } })).status).toBe(200);
    expect((await app.request("/api/x", { headers: { cookie: forge({ ...payload, exp: payload.exp + 1e9 }) } })).status).toBe(401);
    expect((await app.request("/api/x", { headers: { cookie: forge({ ...payload, user: { ...payload.user, sub: "admin" } }) } })).status).toBe(401);
  });
  test("state cookie value is not accepted as a session", async () => {
    const app = build();
    const { sc } = await login(app);
    const forged = pair(sc).replace(/^oidc_state=/, "session=");
    expect((await app.request("/api/x", { headers: { cookie: forged } })).status).toBe(401);
  });
  test("exact /api is treated as API (401 json)", async () => {
    const r = await build().request("/api");
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "unauthenticated" });
  });
  test("cookie signed with another secret rejected", async () => {
    const other = build(withSecret(mkCfg(), "different-secret-value"));
    const ck = await session(other);
    expect((await build().request("/api/x", { headers: { cookie: ck } })).status).toBe(401);
  });
  test("expired cookie rejected via injected clock", async () => {
    let t = 1_000_000;
    const app = build(mkCfg(), stub().oidc, () => t);
    const ck = await session(app);
    t += 12 * 3600 * 1000 - 1;
    expect((await app.request("/api/x", { headers: { cookie: ck } })).status).toBe(200);
    t += 1;
    expect((await app.request("/api/x", { headers: { cookie: ck } })).status).toBe(401);
    expect((await app.request("/", { headers: { cookie: ck } })).status).toBe(302);
  });
});

test("createOidcClient does not contact the IdP until first use", async () => {
  const cfg = mkCfg();
  cfg.userAuth.oidc.issuer = "http://127.0.0.1:1/";
  const c = await createOidcClient(cfg);
  await expect(c.authorizationUrl({ redirectUri: "http://x/cb", state: "s", codeVerifier: "v".repeat(43) })).rejects.toThrow();
});

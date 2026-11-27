import { Hono } from "hono";
import { describe, expect, test } from "bun:test";
import { createOidcClient, mintSessionCookie, oidcUserAuth, scopeFor } from "../src/auth";
import type { OidcClient, User } from "../src/auth";
import type { Config, OidcUserAuth } from "../src/config/parse";
import { DEFAULT_ROLES } from "../src/roles";
import { rejection, defined } from "./support";

const user: User = { sub: "u1", name: "Ann", email: "a@x.io" };
const withSecret = (config: Config, item: string): Config => ({
  ...config,
  userAuth: { ...(config.userAuth as OidcUserAuth), sessionSecret: item },
});
const mkCfg = (publicUrl = "https://rc.example.com"): Config =>
  ({
    publicUrl,
    userAuth: {
      mode: "oidc",
      sessionSecret: "s3cret-s3cret-s3cret",
      oidc: { issuer: "https://idp", clientId: "c", clientSecret: "s" },
    },
  }) as Config;

function stub(fail = false) {
  const calls: any[] = [];
  const oidc: OidcClient = {
    authorizationUrl(options) {
      calls.push(["url", options]);
      return Promise.resolve(`https://idp/authorize?state=${options.state}`);
    },
    exchange(options) {
      calls.push(["exchange", options]);
      if (fail) return Promise.reject(new Error("bad code"));
      return Promise.resolve(user);
    },
  };
  return { oidc, calls };
}

function build(cfg = mkCfg(), oidc = stub().oidc, now = () => 1_000_000) {
  const ua = oidcUserAuth(cfg, oidc, now);
  const app = new Hono();
  app.route("/auth", defined(ua.routes));
  app.use("*", ua.middleware);
  app.get("/", (context) => context.json({ user: context.get("user" as never) }));
  app.get("/api/x", (context) => context.json({ ok: true }));
  return app;
}

const setCookies = (response: Response) => response.headers.getSetCookie();
const find = (response: Response, name: string) =>
  setCookies(response).find((setCooky) => setCooky.startsWith(name + "="));
const pair = (sc: string) => sc.split(";")[0];
const CLEARED = /Max-Age=0|Expires=Thu, 01 Jan 1970/;
const tamper = (item: string) => item.slice(0, -4) + (item.endsWith("AAAA") ? "BBBB" : "AAAA");

async function login(app: Hono) {
  const response = await app.request("/auth/login");
  const sc = defined(find(response, "oidc_state"));
  const url = new URL(defined(response.headers.get("location")));
  return { response: response, sc, state: defined(url.searchParams.get("state")) };
}

describe("login", () => {
  test("discovery failure -> 502 readable page, logged", async () => {
    const oidc: OidcClient = {
      authorizationUrl() {
        return Promise.reject(new Error("discovery down"));
      },
      exchange() {
        return Promise.resolve(user);
      },
    };
    const orig = console.error;
    const logged: unknown[][] = [];

    console.error = (...args: unknown[]) => {
      logged.push(args);
    };

    try {
      const response = await build(mkCfg(), oidc).request("/auth/login");
      expect(response.status).toBe(502);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain("identity provider");
      expect(find(response, "oidc_state")).toBeUndefined();
    } finally {
      console.error = orig;
    }

    expect(logged.length).toBe(1);
  });
  test("redirects to provider and sets short-lived signed state cookie", async () => {
    const recorder = stub();
    const app = build(mkCfg(), recorder.oidc);
    const { response: response, sc, state } = await login(app);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toStartWith("https://idp/authorize");
    expect(sc).toContain("HttpOnly");
    expect(sc).toContain("SameSite=Lax");
    expect(sc).toContain("Max-Age=600");
    expect(sc).toContain("Path=/auth");
    expect(recorder.calls[0][1].redirectUri).toBe("https://rc.example.com/auth/callback");
    expect(recorder.calls[0][1].codeVerifier.length).toBeGreaterThan(20);
    expect(state.length).toBeGreaterThan(10);
  });
  test("trailing slash on publicUrl is stripped", async () => {
    const recorder = stub();
    await build(mkCfg("https://rc.example.com/"), recorder.oidc).request("/auth/login");
    expect(recorder.calls[0][1].redirectUri).toBe("https://rc.example.com/auth/callback");
  });
});

describe("allowed_users", () => {
  const withAllowed = (allowed: string[]): Config => {
    const config = mkCfg();
    return { ...config, userAuth: { ...(config.userAuth as OidcUserAuth), allowedUsers: allowed } };
  };

  test("user not on the list -> 403 and no session cookie", async () => {
    const recorder = stub();
    const app = build(withAllowed(["someone-else"]), recorder.oidc);
    const { sc, state } = await login(app);
    const response = await app.request(`/auth/callback?code=abc&state=${state}`, { headers: { cookie: pair(sc) } });
    expect(response.status).toBe(403);
    expect(find(response, "session")).toBeUndefined();
  });
  test("listed user (by email) gets a session", async () => {
    const recorder = stub();
    const app = build(withAllowed(["a@x.io"]), recorder.oidc);
    const { sc, state } = await login(app);
    const response = await app.request(`/auth/callback?code=abc&state=${state}`, { headers: { cookie: pair(sc) } });
    expect(response.status).toBe(302);
    expect(find(response, "session")).toBeDefined();
  });
});

describe("allowed_users on an existing session", () => {
  const withAllowed = (allowed: string[] | undefined): Config => {
    const config = mkCfg();
    return {
      ...config,
      userAuth: { ...(config.userAuth as OidcUserAuth), ...(allowed ? { allowedUsers: allowed } : {}) },
    };
  };

  const NOW = 1_000_000;
  const session = (cfg: Config, item: User = user) => mintSessionCookie(cfg, item, NOW + 60_000);
  const get = (app: Hono, path: string, cookie: string) => app.request(path, { headers: { cookie } });

  test("a session of a user who is no longer listed gets 403 on the API and on pages, and the cookie is cleared", async () => {
    const cookie = await session(withAllowed(undefined), { sub: "u9", name: "Gone", username: "gone" });
    const app = build(withAllowed(["a@x.io"]));

    for (const path of ["/api/x", "/"]) {
      const response = await get(app, path, cookie);
      expect([path, response.status]).toEqual([path, 403]);
      expect(await response.json()).toEqual({ error: "user is not allowed" });
      expect(find(response, "session")).toMatch(CLEARED);
    }
  });

  test("the same cookie works while the user is listed and stops working when the user is removed", async () => {
    const cookie = await session(withAllowed(["a@x.io"]));
    expect((await get(build(withAllowed(["a@x.io"])), "/api/x", cookie)).status).toBe(200);
    expect((await get(build(withAllowed(["someone-else"])), "/api/x", cookie)).status).toBe(403);
  });

  test("a listed username or email passes, and with no list every valid session passes", async () => {
    const byName = await session(withAllowed(undefined), { sub: "u2", name: "Bob", username: "bob" });
    expect((await get(build(withAllowed(["bob"])), "/api/x", byName)).status).toBe(200);
    expect((await get(build(withAllowed(undefined)), "/api/x", byName)).status).toBe(200);
  });

  test("an expired or missing session is still 401 and is not mistaken for a denied user", async () => {
    const old = await mintSessionCookie(withAllowed(["a@x.io"]), user, NOW - 1);
    expect((await get(build(withAllowed(["a@x.io"])), "/api/x", old)).status).toBe(401);
    expect((await build(withAllowed(["a@x.io"])).request("/api/x")).status).toBe(401);
  });
});

describe("callback", () => {
  test("matching state sets session cookie and redirects to /", async () => {
    const recorder = stub();
    const app = build(mkCfg(), recorder.oidc);
    const { sc, state } = await login(app);
    const response = await app.request(`/auth/callback?code=abc&state=${state}&next=//evil.com`, {
      headers: { cookie: pair(sc) },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    const sess = defined(find(response, "session"));
    expect(sess).toContain("HttpOnly");
    expect(sess).toContain("SameSite=Lax");
    expect(sess).toContain("Max-Age=43200");
    expect(sess).toContain("Path=/");
    expect(sess).toContain("Secure");
    const ex = recorder.calls.find((call) => call[0] === "exchange")[1];
    expect(ex.state).toBe(state);
    expect(ex.callbackUrl.searchParams.get("code")).toBe("abc");
    expect(ex.redirectUri).toBe("https://rc.example.com/auth/callback");
    expect(find(response, "oidc_state")).toMatch(CLEARED);
    const me = await app.request("/", { headers: { cookie: pair(sess) } });
    expect(me.status).toBe(200);
    expect((await me.json()).user).toEqual(user);
  });
  test("Secure flag absent for http publicUrl", async () => {
    const app = build(mkCfg("http://localhost:8080"));
    const { sc, state } = await login(app);
    const response = await app.request(`/auth/callback?code=a&state=${state}`, { headers: { cookie: pair(sc) } });
    expect(find(response, "session")).toBeDefined();
    expect(find(response, "session")).not.toContain("Secure");
  });

  async function expectFail(response: Response) {
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBeString();
    expect(find(response, "session")).toBeUndefined();
    expect(find(response, "oidc_state")).toMatch(CLEARED);
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
    await expectFail(
      await app.request(`/auth/callback?code=a&state=${state}`, { headers: { cookie: tamper(pair(sc)) } }),
    );
  });
  test("exchange error -> 400, no session", async () => {
    const app = build(mkCfg(), stub(true).oidc);
    const { sc, state } = await login(app);
    await expectFail(await app.request(`/auth/callback?code=a&state=${state}`, { headers: { cookie: pair(sc) } }));
  });
});

describe("logout", () => {
  test("clears session and redirects to /", async () => {
    const response = await build().request("/auth/logout");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    expect(find(response, "session")).toMatch(CLEARED);
  });
  test("ends the identity provider session when the provider supports it", async () => {
    const asked: string[] = [];
    const oidc: OidcClient = {
      ...stub().oidc,
      endSessionUrl(options) {
        asked.push(options.postLogoutRedirectUri);
        return Promise.resolve(
          `https://idp/end-session/?post_logout_redirect_uri=${encodeURIComponent(options.postLogoutRedirectUri)}`,
        );
      },
    };
    const response = await build(mkCfg(), oidc).request("/auth/logout");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toStartWith("https://idp/end-session/");
    expect(asked).toEqual(["https://rc.example.com/"]);
    expect(find(response, "session")).toMatch(CLEARED);
  });
  test("provider has no end-session endpoint or is down: still clears session and goes to /", async () => {
    const oidc: OidcClient = {
      ...stub().oidc,
      endSessionUrl() {
        return Promise.reject(new Error("no end_session_endpoint"));
      },
    };
    const response = await build(mkCfg(), oidc).request("/auth/logout");
    expect(response.headers.get("location")).toBe("/");
    expect(find(response, "session")).toMatch(CLEARED);
  });
});

describe("requireUser", () => {
  async function session(app: Hono) {
    const { sc, state } = await login(app);
    const response = await app.request(`/auth/callback?code=a&state=${state}`, { headers: { cookie: pair(sc) } });
    return pair(defined(find(response, "session")));
  }

  test("no cookie: 401 for api, 302 for pages", async () => {
    const app = build();
    const response = await app.request("/api/x");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
    const reply = await app.request("/");
    expect(reply.status).toBe(302);
    expect(reply.headers.get("location")).toBe("/auth/login");
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
    const item = 1_000_000;
    const app = build(mkCfg(), stub().oidc, () => item);
    const ck = await session(app);
    const decoded = decodeURIComponent(ck.slice("session=".length));
    const position = decoded.lastIndexOf(".");
    const payload = JSON.parse(decoded.slice(0, position));
    const sig = decoded.slice(position);
    const forge = (value: object) => `session=${encodeURIComponent(JSON.stringify(value) + sig)}`;
    expect((await app.request("/api/x", { headers: { cookie: ck } })).status).toBe(200);
    expect(
      (await app.request("/api/x", { headers: { cookie: forge({ ...payload, exp: payload.exp + 1e9 }) } })).status,
    ).toBe(401);
    expect(
      (
        await app.request("/api/x", {
          headers: { cookie: forge({ ...payload, user: { ...payload.user, sub: "admin" } }) },
        })
      ).status,
    ).toBe(401);
  });
  test("state cookie value is not accepted as a session", async () => {
    const app = build();
    const { sc } = await login(app);
    const forged = pair(sc).replace(/^oidc_state=/, "session=");
    expect((await app.request("/api/x", { headers: { cookie: forged } })).status).toBe(401);
  });
  test("exact /api is treated as API (401 json)", async () => {
    const response = await build().request("/api");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  });
  test("cookie signed with another secret rejected", async () => {
    const other = build(withSecret(mkCfg(), "different-secret-value"));
    const ck = await session(other);
    expect((await build().request("/api/x", { headers: { cookie: ck } })).status).toBe(401);
  });
  test("expired cookie rejected via injected clock", async () => {
    let item = 1_000_000;
    const app = build(mkCfg(), stub().oidc, () => item);
    const ck = await session(app);
    item += 12 * 3600 * 1000 - 1;
    expect((await app.request("/api/x", { headers: { cookie: ck } })).status).toBe(200);
    item += 1;
    expect((await app.request("/api/x", { headers: { cookie: ck } })).status).toBe(401);
    expect((await app.request("/", { headers: { cookie: ck } })).status).toBe(302);
  });
});

test("createOidcClient does not contact the IdP until first use", async () => {
  const cfg = mkCfg();
  (cfg.userAuth as OidcUserAuth).oidc.issuer = "http://127.0.0.1:1/";
  const oidcClient = createOidcClient(cfg);
  expect(
    await rejection(
      oidcClient.authorizationUrl({ redirectUri: "http://x/cb", state: "s", codeVerifier: "v".repeat(43) }),
    ),
  ).toBeInstanceOf(Error);
});

describe("roles", () => {
  const callbackWith = async (item: User, cfg = mkCfg()) => {
    const oidc: OidcClient = {
      authorizationUrl(options) {
        return Promise.resolve(`https://idp/authorize?state=${options.state}`);
      },
      exchange() {
        return Promise.resolve(item);
      },
    };
    const app = build(cfg, oidc);
    const { sc, state } = await login(app);
    return {
      app,
      response: await app.request(`/auth/callback?code=abc&state=${state}`, { headers: { cookie: pair(sc) } }),
    };
  };

  test("the role none gives 403 and no session cookie", async () => {
    const { response: response } = await callbackWith({ ...user, role: "none" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "access refused" });
    expect(find(response, "session")).toBeUndefined();
  });
  test("the role is kept in the session", async () => {
    const { app, response: response } = await callbackWith({ ...user, role: "write" });
    const cookie = pair(defined(find(response, "session")));
    const me = await app.request("/", { headers: { cookie } });
    expect(((await me.json()) as { user: User }).user.role).toBe("write");
  });
  test("a session with no role has no role", async () => {
    const cookie = await mintSessionCookie(mkCfg(), user, 1_000_000 + 60_000);
    const me = await build().request("/", { headers: { cookie } });
    expect(((await me.json()) as { user: User }).user.role).toBeUndefined();
  });
  test("a session with an unknown role value has no role", async () => {
    const cookie = await mintSessionCookie(mkCfg(), { ...user, role: "root" } as unknown as User, 1_000_000 + 60_000);
    const me = await build().request("/", { headers: { cookie } });
    expect(((await me.json()) as { user: User }).user.role).toBeUndefined();
  });
  test("the cookie life follows session_ttl_hours, and is 12 hours without it", async () => {
    const config = mkCfg();
    const two = { ...config, userAuth: { ...(config.userAuth as OidcUserAuth), sessionTtlHours: 2 } } as Config;
    expect(find((await callbackWith(user, two)).response, "session")).toContain("Max-Age=7200");
    expect(find((await callbackWith(user)).response, "session")).toContain("Max-Age=43200");
  });
  test("the scope adds the role scope when one is set", () => {
    expect(scopeFor(DEFAULT_ROLES)).toBe("openid email profile clauderc");
    expect(scopeFor({ ...DEFAULT_ROLES, scope: undefined })).toBe("openid email profile");
  });
});

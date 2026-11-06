import { timingSafeEqual } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import * as client from "openid-client";
import type { Config } from "./config";

export type User = { sub: string; name: string; email?: string };

export interface OidcClient {
  authorizationUrl(p: { redirectUri: string; state: string; codeVerifier: string }): Promise<string>;
  exchange(p: { redirectUri: string; callbackUrl: URL; state: string; codeVerifier: string }): Promise<User>;
}

const SESSION_COOKIE = "session";
const STATE_COOKIE = "oidc_state";
const SESSION_TTL_S = 12 * 60 * 60;
const STATE_TTL_S = 10 * 60;

const redirectUriOf = (cfg: Config) => `${cfg.publicUrl.replace(/\/+$/, "")}/auth/callback`;
const isSecure = (cfg: Config) => cfg.publicUrl.startsWith("https:");

/**
 * Thin openid-client v6 adapter. NOT unit-tested: needs a live IdP.
 */
export async function createOidcClient(cfg: Config): Promise<OidcClient> {
  const issuer = new URL(cfg.oidc.issuer);
  // Discovery is lazy (first login) and cached on success, so the server starts without the IdP.
  // A failed discovery is not cached; the next login retries. Auth is never bypassed.
  let pending: Promise<client.Configuration> | undefined;
  const getConfig = () => {
    pending ??= client
      .discovery(
        issuer,
        cfg.oidc.clientId,
        cfg.oidc.clientSecret,
        undefined,
        issuer.protocol === "http:" ? { execute: [client.allowInsecureRequests] } : undefined,
      )
      .catch((e) => {
        pending = undefined;
        throw e;
      });
    return pending;
  };
  return {
    async authorizationUrl({ redirectUri, state, codeVerifier }) {
      const config = await getConfig();
      const url = client.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: "openid email profile",
        state,
        code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: "S256",
      });
      return url.href;
    },
    async exchange({ callbackUrl, state, codeVerifier }) {
      const config = await getConfig();
      const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
        expectedState: state,
        pkceCodeVerifier: codeVerifier,
      });
      const claims = tokens.claims();
      if (!claims || typeof claims.sub !== "string" || !claims.sub) throw new Error("ID token missing sub");
      const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
      const email = str(claims.email);
      const name = str(claims.name) ?? str(claims.preferred_username) ?? email ?? claims.sub;
      return email ? { sub: claims.sub, name, email } : { sub: claims.sub, name };
    },
  };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function authRoutes(cfg: Config, oidc: OidcClient, now: () => number = Date.now): Hono {
  const app = new Hono();
  const secure = isSecure(cfg);
  const redirectUri = redirectUriOf(cfg);
  const clearState = (c: Parameters<typeof deleteCookie>[0]) =>
    deleteCookie(c, STATE_COOKIE, { path: "/auth", secure });

  app.get("/login", async (c) => {
    const state = client.randomState();
    const codeVerifier = client.randomPKCECodeVerifier();
    const location = await oidc.authorizationUrl({ redirectUri, state, codeVerifier });
    await setSignedCookie(c, STATE_COOKIE, JSON.stringify({ state, codeVerifier }), cfg.sessionSecret, {
      path: "/auth",
      httpOnly: true,
      sameSite: "Lax",
      secure,
      maxAge: STATE_TTL_S,
    });
    return c.redirect(location, 302);
  });

  app.get("/callback", async (c) => {
    const fail = (msg: string) => {
      clearState(c);
      return c.json({ error: msg }, 400);
    };
    const raw = await getSignedCookie(c, cfg.sessionSecret, STATE_COOKIE);
    let saved: { state?: unknown; codeVerifier?: unknown } = {};
    try {
      if (raw) saved = JSON.parse(raw);
    } catch {
      /* treated as missing */
    }
    if (typeof saved.state !== "string" || typeof saved.codeVerifier !== "string") return fail("invalid login state");
    const given = c.req.query("state");
    if (!given || !safeEqual(given, saved.state)) return fail("state mismatch");

    // Rebuild the callback URL from the configured public URL so it is correct behind a proxy.
    const callbackUrl = new URL(redirectUri);
    callbackUrl.search = new URL(c.req.url).search;
    let user: User;
    try {
      user = await oidc.exchange({ redirectUri, callbackUrl, state: saved.state, codeVerifier: saved.codeVerifier });
    } catch {
      return fail("login failed");
    }
    clearState(c);
    const payload = { user, exp: now() + SESSION_TTL_S * 1000 };
    await setSignedCookie(c, SESSION_COOKIE, JSON.stringify(payload), cfg.sessionSecret, {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure,
      maxAge: SESSION_TTL_S,
    });
    return c.redirect("/", 302);
  });

  app.get("/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure });
    return c.redirect("/", 302);
  });

  return app;
}

export function requireUser(cfg: Config, now: () => number = Date.now): MiddlewareHandler {
  return async (c, next) => {
    const user = await readSession(c, cfg, now);
    if (!user) {
      if (c.req.path.startsWith("/api/")) return c.json({ error: "unauthenticated" }, 401);
      return c.redirect("/auth/login", 302);
    }
    c.set("user", user);
    await next();
  };
}

/** Test helper: returns a `Cookie` header value carrying a validly signed session. */
export async function mintSessionCookie(cfg: Config, user: User, exp: number): Promise<string> {
  const { serializeSigned } = await import("hono/utils/cookie");
  const sc = await serializeSigned(SESSION_COOKIE, JSON.stringify({ user, exp }), cfg.sessionSecret, { path: "/" });
  return sc.split(";")[0]!;
}

async function readSession(c: Parameters<typeof getSignedCookie>[0], cfg: Config, now: () => number): Promise<User | null> {
  const raw = await getSignedCookie(c, cfg.sessionSecret, SESSION_COOKIE);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    if (typeof p?.exp !== "number" || p.exp <= now()) return null;
    const u = p.user;
    if (typeof u?.sub !== "string" || typeof u?.name !== "string") return null;
    return typeof u.email === "string" ? { sub: u.sub, name: u.name, email: u.email } : { sub: u.sub, name: u.name };
  } catch {
    return null;
  }
}

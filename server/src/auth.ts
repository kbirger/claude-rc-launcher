import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import * as client from "openid-client";
import { timingSafeEqual } from "node:crypto";
import type { Config, OidcUserAuth } from "./config/parse";
import { isObject } from "./shared/requests";
import { isRole, rolesFrom } from "./roles";
import type { RoleSettings } from "./roles";
import { isAllowed, userFromClaims } from "./userauth";
import type { User, UserAuthStrategy } from "./userauth";

export type { User };

export interface OidcClient {
  authorizationUrl(options: { redirectUri: string; state: string; codeVerifier: string }): Promise<string>;
  exchange(options: { redirectUri: string; callbackUrl: URL; state: string; codeVerifier: string }): Promise<User>;
  /** URL that ends the identity provider session. Throws if the provider has no end-session endpoint. */
  endSessionUrl?(options: { postLogoutRedirectUri: string }): Promise<string>;
}

function oidcOf(cfg: Config): OidcUserAuth {
  if (cfg.userAuth?.mode !== "oidc") throw new Error("user_auth.mode is not oidc");
  return cfg.userAuth;
}

const SESSION_COOKIE = "session";
const STATE_COOKIE = "oidc_state";
const DEFAULT_SESSION_TTL_HOURS = 12;
const STATE_TTL_S = 10 * 60;

/** Lifetime of the session cookie in seconds. */
const sessionTtlS = (cfg: Config) => (oidcOf(cfg).sessionTtlHours ?? DEFAULT_SESSION_TTL_HOURS) * 60 * 60;

/** The scope that the hub asks the identity provider for. */
export const scopeFor = (roles: RoleSettings): string =>
  ["openid", "email", "profile", ...(roles.scope ? [roles.scope] : [])].join(" ");

const redirectUriOf = (cfg: Config) => `${cfg.publicUrl.replace(/\/+$/, "")}/auth/callback`;
const isSecure = (cfg: Config) => cfg.publicUrl.startsWith("https:");

/**
 * Thin openid-client v6 adapter. NOT unit-tested: needs a live IdP.
 */
export function createOidcClient(cfg: Config): OidcClient {
  const issuer = new URL(oidcOf(cfg).oidc.issuer);
  // Discovery is lazy (first login) and cached on success, so the server starts without the IdP.
  // A failed discovery is not cached; the next login retries. Auth is never bypassed.
  let pending: Promise<client.Configuration> | undefined;

  const getConfig = () => {
    pending ??= client
      .discovery(
        issuer,
        oidcOf(cfg).oidc.clientId,
        oidcOf(cfg).oidc.clientSecret,
        undefined,
        // loadConfig only allows http: for loopback or OIDC_ALLOW_INSECURE
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- openid-client has no other way to allow a loopback http issuer
        issuer.protocol === "http:" ? { execute: [client.allowInsecureRequests] } : undefined,
      )
      .catch((error: unknown) => {
        pending = undefined;
        throw error;
      });
    return pending;
  };

  return {
    async authorizationUrl({ redirectUri, state, codeVerifier }) {
      const config = await getConfig();
      const url = client.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: scopeFor(rolesFrom(oidcOf(cfg))),
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
      const user = userFromClaims(claims, rolesFrom(oidcOf(cfg)));
      if (!user) throw new Error("ID token missing sub");

      return user;
    },
    async endSessionUrl({ postLogoutRedirectUri }) {
      const config = await getConfig();
      return client.buildEndSessionUrl(config, { post_logout_redirect_uri: postLogoutRedirectUri }).href;
    },
  };
}

function safeEqual(left: string, right: string): boolean {
  const ab = Buffer.from(left);
  const bb = Buffer.from(right);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function authRoutes(cfg: Config, oidc: OidcClient, now: () => number = Date.now): Hono {
  const app = new Hono();
  const secure = isSecure(cfg);
  const redirectUri = redirectUriOf(cfg);
  const clearState = (context: Parameters<typeof deleteCookie>[0]) =>
    deleteCookie(context, STATE_COOKIE, { path: "/auth", secure });

  app.get("/login", async (context) => {
    const state = client.randomState();
    const codeVerifier = client.randomPKCECodeVerifier();
    let location: string;

    try {
      location = await oidc.authorizationUrl({ redirectUri, state, codeVerifier });
    } catch (caught) {
      console.error("OIDC discovery/authorization setup failed:", caught);
      return context.html(
        '<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Login unavailable</title><h1>Identity provider unavailable</h1><p>The identity provider could not be reached. Try again in a moment.</p><p><a href="/auth/login">Retry</a></p>',
        502,
      );
    }

    await setSignedCookie(context, STATE_COOKIE, JSON.stringify({ state, codeVerifier }), oidcOf(cfg).sessionSecret, {
      path: "/auth",
      httpOnly: true,
      sameSite: "Lax",
      secure,
      maxAge: STATE_TTL_S,
    });
    return context.redirect(location, 302);
  });

  app.get("/callback", async (context) => {
    const fail = (msg: string) => {
      clearState(context);
      return context.json({ error: msg }, 400);
    };

    const raw = await getSignedCookie(context, oidcOf(cfg).sessionSecret, STATE_COOKIE);
    let saved: { state?: unknown; codeVerifier?: unknown } = {};

    try {
      const parsed: unknown = raw ? JSON.parse(raw) : undefined;
      if (isObject(parsed)) saved = parsed;
    } catch {
      /* treated as missing */
    }

    if (typeof saved.state !== "string" || typeof saved.codeVerifier !== "string") return fail("invalid login state");
    const given = context.req.query("state");
    if (!given || !safeEqual(given, saved.state)) return fail("state mismatch");

    // Rebuild the callback URL from the configured public URL so it is correct behind a proxy.
    const callbackUrl = new URL(redirectUri);
    callbackUrl.search = new URL(context.req.url).search;
    let user: User;

    try {
      user = await oidc.exchange({ redirectUri, callbackUrl, state: saved.state, codeVerifier: saved.codeVerifier });
    } catch {
      return fail("login failed");
    }

    clearState(context);
    if (!isAllowed(user, oidcOf(cfg).allowedUsers)) return context.json({ error: "user is not allowed" }, 403);
    if (user.role === "none") return context.json({ error: "access refused" }, 403);
    const payload = { user, exp: now() + sessionTtlS(cfg) * 1000 };
    await setSignedCookie(context, SESSION_COOKIE, JSON.stringify(payload), oidcOf(cfg).sessionSecret, {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure,
      maxAge: sessionTtlS(cfg),
    });
    return context.redirect("/", 302);
  });

  app.get("/logout", async (context) => {
    deleteCookie(context, SESSION_COOKIE, { path: "/", secure });

    // Clearing the hub cookie is not enough: the identity provider session stays alive, so the next page load
    // signs the user straight back in. End that session too, when the provider offers an end-session endpoint.
    if (oidc.endSessionUrl) {
      try {
        const postLogoutRedirectUri = `${cfg.publicUrl.replace(/\/+$/, "")}/`;
        return context.redirect(await oidc.endSessionUrl({ postLogoutRedirectUri }), 302);
      } catch (caught) {
        console.error("OIDC end-session unavailable, cleared the local session only:", caught);
      }
    }

    return context.redirect("/", 302);
  });

  return app;
}

function requireUser(cfg: Config, now: () => number = Date.now): MiddlewareHandler {
  return async (context, next) => {
    const user = await readSession(context, cfg, now);

    if (!user) {
      const requestPath = context.req.path;
      if (requestPath === "/api" || requestPath.startsWith("/api/"))
        return context.json({ error: "unauthenticated" }, 401);
      return context.redirect("/auth/login", 302);
    }

    // The list is checked on every request, not only at login. A user who is removed from `allowed_users` loses access
    // when the hub next reads its configuration, and does not keep it until the session cookie expires.
    if (!isAllowed(user, oidcOf(cfg).allowedUsers)) {
      deleteCookie(context, SESSION_COOKIE, { path: "/", secure: isSecure(cfg) });
      return context.json({ error: "user is not allowed" }, 403);
    }

    context.set("user", user);
    await next();
  };
}

export function oidcUserAuth(cfg: Config, oidc: OidcClient, now: () => number = Date.now): UserAuthStrategy {
  return { routes: authRoutes(cfg, oidc, now), middleware: requireUser(cfg, now) };
}

/** Test helper: returns a `Cookie` header value carrying a validly signed session. */
export async function mintSessionCookie(cfg: Config, user: User, exp: number): Promise<string> {
  const { serializeSigned } = await import("hono/utils/cookie");
  const sc = await serializeSigned(SESSION_COOKIE, JSON.stringify({ user, exp }), oidcOf(cfg).sessionSecret, {
    path: "/",
  });
  return sc.split(";")[0];
}

async function readSession(
  context: Parameters<typeof getSignedCookie>[0],
  cfg: Config,
  now: () => number,
): Promise<User | null> {
  const raw = await getSignedCookie(context, oidcOf(cfg).sessionSecret, SESSION_COOKIE);
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed) || typeof parsed.exp !== "number" || parsed.exp <= now()) return null;
    const user = parsed.user;
    if (!isObject(user) || typeof user.sub !== "string" || typeof user.name !== "string") return null;
    const out: User = { sub: user.sub, name: user.name };
    if (typeof user.email === "string") out.email = user.email;
    if (typeof user.username === "string") out.username = user.username;
    if (isRole(user.role)) out.role = user.role; // a cookie from before roles, or an unknown value, has no role and acts as read
    return out;
  } catch {
    return null;
  }
}

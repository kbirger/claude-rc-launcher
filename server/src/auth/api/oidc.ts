import { Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import * as client from "openid-client";
import { timingSafeEqual } from "node:crypto";
import type { Config } from "../../config";
import { isObject } from "../../shared/requests";
import { isSecure, oidcOf, requireUser, SESSION_COOKIE } from "../oidc";
import type { OidcClient } from "../oidc";
import { isAllowed } from "../user";
import type { User, UserAuthStrategy } from "../user";

const STATE_COOKIE = "oidc_state";
const DEFAULT_SESSION_TTL_HOURS = 12;
const STATE_TTL_S = 10 * 60;

/** Lifetime of the session cookie in seconds. */
const sessionTtlS = (cfg: Config) => (oidcOf(cfg).sessionTtlHours ?? DEFAULT_SESSION_TTL_HOURS) * 60 * 60;

const redirectUriOf = (cfg: Config) => `${cfg.publicUrl.replace(/\/+$/, "")}/auth/callback`;

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

export function oidcUserAuth(cfg: Config, oidc: OidcClient, now: () => number = Date.now): UserAuthStrategy {
  return { routes: authRoutes(cfg, oidc, now), middleware: requireUser(cfg, now) };
}

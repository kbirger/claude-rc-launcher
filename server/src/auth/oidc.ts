import type { MiddlewareHandler } from "hono";
import { deleteCookie, getSignedCookie } from "hono/cookie";
import * as client from "openid-client";
import type { Config, OidcUserAuth } from "../config";
import { isRole, rolesFrom } from "../roles";
import type { RoleSettings } from "../roles";
import { isObject } from "../shared/requests";
import { isAllowed, userFromClaims } from "./user";
import type { User } from "./user";

export type { User };

export interface OidcClient {
  authorizationUrl(options: { redirectUri: string; state: string; codeVerifier: string }): Promise<string>;
  exchange(options: { redirectUri: string; callbackUrl: URL; state: string; codeVerifier: string }): Promise<User>;
  /** URL that ends the identity provider session. Throws if the provider has no end-session endpoint. */
  endSessionUrl?(options: { postLogoutRedirectUri: string }): Promise<string>;
}

export function oidcOf(cfg: Config): OidcUserAuth {
  if (cfg.userAuth?.mode !== "oidc") throw new Error("user_auth.mode is not oidc");
  return cfg.userAuth;
}

export const SESSION_COOKIE = "session";

/** The scope that the hub asks the identity provider for. */
export const scopeFor = (roles: RoleSettings): string =>
  ["openid", "email", "profile", ...(roles.scope ? [roles.scope] : [])].join(" ");

export const isSecure = (cfg: Config) => cfg.publicUrl.startsWith("https:");

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

export function requireUser(cfg: Config, now: () => number = Date.now): MiddlewareHandler {
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

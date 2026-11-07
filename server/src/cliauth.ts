import { Hono, type MiddlewareHandler } from "hono";
import type { JwtVerifier } from "./jwt";
import { isAllowed, userFromClaims } from "./userauth";

const unauthenticated = (c: Parameters<MiddlewareHandler>[0]) => c.json({ error: "unauthenticated" }, 401);

/**
 * Accepts only `Authorization: Bearer <ID token>` of the CLI's public OIDC client. Cookies and proxy headers are
 * never read. The user is built from the token claims and must pass `allowed_users`.
 */
export function cliBearerAuth(o: { verify: JwtVerifier; allowedUsers?: string[] }): MiddlewareHandler {
  return async (c, next) => {
    const m = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "");
    if (!m) return unauthenticated(c);
    let claims;
    try {
      claims = await o.verify(m[1]!);
    } catch {
      return unauthenticated(c);
    }
    if (typeof claims.exp !== "number") return unauthenticated(c); // a token that never expires is never accepted
    const user = userFromClaims(claims as Record<string, unknown>);
    if (!user) return unauthenticated(c);
    if (!isAllowed(user, o.allowedUsers)) return c.json({ error: "user is not allowed" }, 403);
    c.set("user", user);
    await next();
  };
}

/** Public values that the CLI needs to start a login. Contains no secret. */
export function cliConfigRoute(s: { issuer: string; clientId: string }): Hono {
  const r = new Hono();
  r.get("/", (c) => c.json({ issuer: s.issuer, client_id: s.clientId }));
  return r;
}

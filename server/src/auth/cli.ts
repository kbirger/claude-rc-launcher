import type { MiddlewareHandler } from "hono";
import type { RoleSettings } from "../roles";
import type { JwtVerifier } from "./jwt";
import { isAllowed, userFromClaims } from "./user";

const unauthenticated = (context: Parameters<MiddlewareHandler>[0]) => context.json({ error: "unauthenticated" }, 401);

/**
 * Accepts only `Authorization: Bearer <ID token>` of the CLI's public OIDC client. Cookies and proxy headers are
 * never read. The user is built from the token claims and must pass `allowed_users`.
 */
export function cliBearerAuth(options: {
  verify: JwtVerifier;
  allowedUsers?: string[];
  roles?: RoleSettings;
}): MiddlewareHandler {
  return async (context, next) => {
    const match = /^Bearer (\S+)$/.exec(context.req.header("authorization") ?? "");
    if (!match) return unauthenticated(context);
    let claims;

    try {
      claims = await options.verify(match[1]);
    } catch {
      return unauthenticated(context);
    }

    if (typeof claims.exp !== "number") return unauthenticated(context); // a token that never expires is never accepted
    const user = userFromClaims(claims, options.roles);
    if (!user) return unauthenticated(context);
    if (!isAllowed(user, options.allowedUsers)) return context.json({ error: "user is not allowed" }, 403);
    if (user.role === "none") return context.json({ error: "access refused" }, 403);
    context.set("user", user);
    await next();
  };
}

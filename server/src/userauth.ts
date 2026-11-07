import type { Hono, MiddlewareHandler } from "hono";

export type User = { sub: string; name: string; email?: string; username?: string };

/** How the hub authenticates browsers. `middleware` sets `user` or responds 401/403. */
export interface UserAuthStrategy {
  routes?: Hono;
  middleware: MiddlewareHandler;
  logoutUrl?: string;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export function userFromClaims(claims: Record<string, unknown>): User | null {
  const sub = str(claims.sub);
  if (!sub) return null;
  const email = str(claims.email);
  const username = str(claims.preferred_username);
  const user: User = { sub, name: str(claims.name) ?? username ?? email ?? sub };
  if (email) user.email = email;
  if (username) user.username = username;
  return user;
}

/** `undefined` allows everyone; otherwise the username or email must equal an entry exactly. */
export function isAllowed(user: User, allowed: string[] | undefined): boolean {
  if (allowed === undefined) return true;
  return allowed.some((a) => a === user.username || a === user.email);
}

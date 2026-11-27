import { getConnInfo } from "@hono/bun";
import type { Context } from "hono";
import type { ProxyJwtUserAuth } from "../config/parse";
import { cidrContains } from "../shared/ipnet";
import type { JwtVerifier } from "./jwt";
import { isAllowed, userFromClaims } from "./user";
import type { UserAuthStrategy } from "./user";

export type PeerResolver = (context: Context) => string | undefined;

const defaultPeer: PeerResolver = (context) => {
  try {
    return getConnInfo(context).remote.address;
  } catch {
    return undefined;
  }
};

export function proxyJwtUserAuth(options: {
  settings: ProxyJwtUserAuth;
  verify: JwtVerifier;
  peer?: PeerResolver;
}): UserAuthStrategy {
  const { settings, verify } = options;
  const peer = options.peer ?? defaultPeer;
  return {
    ...(settings.logoutUrl ? { logoutUrl: settings.logoutUrl } : {}),
    middleware: async (context, next) => {
      if (settings.trustedPeers.length > 0) {
        const peerAddress = peer(context);
        if (peerAddress === undefined || !cidrContains(settings.trustedPeers, peerAddress))
          return context.json({ error: "forbidden" }, 403);
      }

      const token = context.req.header(settings.header);
      if (!token) return context.json({ error: "unauthenticated" }, 401);
      let claims;

      try {
        claims = await verify(token);
      } catch {
        return context.json({ error: "unauthenticated" }, 401);
      }

      const user = userFromClaims(claims, settings.roles);
      if (!user) return context.json({ error: "unauthenticated" }, 401);
      if (!isAllowed(user, settings.allowedUsers)) return context.json({ error: "user is not allowed" }, 403);
      if (user.role === "none") return context.json({ error: "access refused" }, 403);
      context.set("user" as never, user as never);
      await next();
    },
  };
}

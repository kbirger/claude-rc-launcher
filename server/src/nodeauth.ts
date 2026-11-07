import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { JwtVerifier } from "./jwt";

export type NodeAuthSettings = {
  oidc?: { verify: JwtVerifier; callerClaim: string; callerValue: string };
  secretHashes: string[];
};

export const hashSecret = (secret: string): string => createHash("sha256").update(secret).digest("hex");

export function generateSecret(): { secret: string; sha256: string } {
  const secret = randomBytes(32).toString("hex");
  return { secret, sha256: hashSecret(secret) };
}

const hexEqual = (a: string, b: string) => {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
};

/**
 * Bearer authentication for a node. The token's shape picks the verifier (two dots => JWT => OIDC only;
 * anything else => shared secret only). There is no fallback from one method to the other.
 */
export function nodeAuth(s: NodeAuthSettings): MiddlewareHandler {
  const deny = (c: Parameters<MiddlewareHandler>[0]) => c.json({ error: "unauthorized" }, 401);
  return async (c, next) => {
    const m = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "");
    if (!m) return deny(c);
    const token = m[1]!;
    const isJwt = token.split(".").length === 3;
    if (isJwt) {
      if (!s.oidc) return deny(c);
      try {
        const claims = await s.oidc.verify(token);
        if (claims[s.oidc.callerClaim] !== s.oidc.callerValue) return deny(c);
        c.set("caller" as never, String(claims.sub ?? s.oidc.callerValue) as never);
      } catch {
        return deny(c);
      }
    } else {
      const h = hashSecret(token);
      let ok = false;
      for (const stored of s.secretHashes) ok = hexEqual(h, stored) || ok; // no early exit
      if (!ok) return deny(c);
      c.set("caller" as never, "secret" as never);
    }
    await next();
  };
}

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { createProofVerifier } from "./hubproof";

export type NodeAuthSettings = {
  hubKeys: string[];
  selfFingerprint: string;
  secretHashes: string[];
  now?: () => number;
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

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Authentication for a node. The Authorization scheme picks the check and there is no fallback:
 * `Hub-Proof <jwt>` is a hub-signed proof for this exact request; `Bearer <secret>` is a shared secret.
 */
export function nodeAuth(s: NodeAuthSettings): MiddlewareHandler {
  const deny = (c: Parameters<MiddlewareHandler>[0]) => c.json({ error: "unauthorized" }, 401);
  const verifyProof = createProofVerifier({ keys: s.hubKeys, selfFingerprint: s.selfFingerprint, ...(s.now ? { now: s.now } : {}) });
  return async (c, next) => {
    const m = /^(Hub-Proof|Bearer) (\S+)$/.exec(c.req.header("authorization") ?? "");
    if (!m) return deny(c);
    const token = m[2]!;
    if (m[1] === "Hub-Proof") {
      const declared = Number(c.req.header("content-length") ?? 0);
      if (declared > MAX_BODY_BYTES) return c.json({ error: "request body too large" }, 413);
      const body = await c.req.text(); // Hono caches it, so handlers can still call c.req.json()
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) return c.json({ error: "request body too large" }, 413);
      const url = new URL(c.req.url);
      try {
        await verifyProof(token, { method: c.req.method, pathAndQuery: url.pathname + url.search, body });
      } catch {
        return deny(c);
      }
      c.set("caller" as never, "hub" as never);
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

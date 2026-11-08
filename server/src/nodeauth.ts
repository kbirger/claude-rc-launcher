import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { createProofVerifier, ProofError } from "./hubproof";

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

const WARN_INTERVAL_MS = 10_000;

const MAX_BODY_BYTES = 1024 * 1024;

/** Reads a body stream as UTF-8 text; returns null as soon as it exceeds `max` bytes (the rest is not read). */
async function readCapped(stream: ReadableStream<Uint8Array> | null, max: number): Promise<string | null> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Authentication for a node. The Authorization scheme picks the check and there is no fallback:
 * `Hub-Proof <jwt>` is a hub-signed proof for this exact request; `Bearer <secret>` is a shared secret.
 */
export function nodeAuth(s: NodeAuthSettings): MiddlewareHandler {
  const deny = (c: Parameters<MiddlewareHandler>[0]) => c.json({ error: "unauthorized" }, 401);
  const verifyProof = createProofVerifier({ keys: s.hubKeys, selfFingerprint: s.selfFingerprint, ...(s.now ? { now: s.now } : {}) });
  const now = s.now ?? Date.now;
  const warned = new Map<string, number>(); // message -> time of the last log line (ms)
  /** Logs why a proof was rejected, at most once per message per 10 s. Only fixed texts are logged: never the token, a claim value or a key. */
  const warn = (e: unknown) => {
    const reason = e instanceof ProofError ? e.message : "invalid hub proof";
    const t = now();
    const last = warned.get(reason);
    if (last !== undefined && t - last < WARN_INTERVAL_MS) return;
    warned.set(reason, t);
    console.warn(`hub proof rejected: ${reason}`);
  };
  return async (c, next) => {
    const m = /^(Hub-Proof|Bearer) (\S+)$/.exec(c.req.header("authorization") ?? "");
    if (!m) return deny(c);
    const token = m[2]!;
    if (m[1] === "Hub-Proof") {
      const declared = Number(c.req.header("content-length") ?? 0);
      if (declared > MAX_BODY_BYTES) return c.json({ error: "request body too large" }, 413);
      const body = await readCapped(c.req.raw.body, MAX_BODY_BYTES);
      if (body === null) return c.json({ error: "request body too large" }, 413);
      (c.req.bodyCache as Record<string, unknown>).text = Promise.resolve(body); // handlers can still call c.req.text() / c.req.json()
      const url = new URL(c.req.url);
      try {
        await verifyProof(token, { method: c.req.method, pathAndQuery: url.pathname + url.search, body });
      } catch (e) {
        warn(e);
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

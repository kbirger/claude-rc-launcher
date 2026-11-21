import type { MiddlewareHandler } from "hono";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createProofVerifier, ProofError } from "./hubproof";
import type { ProofActor } from "./hubproof";

export interface NodeAuthSettings {
  hubKeys: string[];
  selfFingerprint: string;
  secretHashes: string[];
  now?: () => number;
}

export const hashSecret = (secret: string): string => createHash("sha256").update(secret).digest("hex");

export function generateSecret(): { secret: string; sha256: string } {
  const secret = randomBytes(32).toString("hex");
  return { secret, sha256: hashSecret(secret) };
}

const hexEqual = (left: string, right: string) => {
  const ab = Buffer.from(left, "hex");
  const bb = Buffer.from(right, "hex");
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
};

const WARN_INTERVAL_MS = 10_000;

const MAX_BODY_BYTES = 1024 * 1024;

/** Reads a body stream as UTF-8 text; returns null as soon as it exceeds `max` bytes (the rest is not read). */
async function readCapped(stream: ReadableStream<Uint8Array> | null, max: number): Promise<string | null> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let count = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    count += value.byteLength;

    if (count > max) {
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
export function nodeAuth(nodeAuthSettings: NodeAuthSettings): MiddlewareHandler {
  const deny = (context: Parameters<MiddlewareHandler>[0]) => context.json({ error: "unauthorized" }, 401);
  const verifyProof = createProofVerifier({
    keys: nodeAuthSettings.hubKeys,
    selfFingerprint: nodeAuthSettings.selfFingerprint,
    ...(nodeAuthSettings.now ? { now: nodeAuthSettings.now } : {}),
  });
  const now = nodeAuthSettings.now ?? Date.now;
  const warned = new Map<string, number>(); // message -> time of the last log line (ms)

  /** Logs why a proof was rejected, at most once per message per 10 s. Only fixed texts are logged: never the token, a claim value or a key. */
  const warn = (entry: unknown) => {
    const reason = entry instanceof ProofError ? entry.message : "invalid hub proof";
    const current = now();
    const last = warned.get(reason);
    if (last !== undefined && current - last < WARN_INTERVAL_MS) return;
    warned.set(reason, current);
    console.warn(`hub proof rejected: ${reason}`);
  };

  return async (context, next) => {
    const match = /^(Hub-Proof|Bearer) (\S+)$/.exec(context.req.header("authorization") ?? "");
    if (!match) return deny(context);
    const token = match[2];

    if (match[1] === "Hub-Proof") {
      const declared = Number(context.req.header("content-length") ?? 0);
      if (declared > MAX_BODY_BYTES) return context.json({ error: "request body too large" }, 413);
      const body = await readCapped(context.req.raw.body, MAX_BODY_BYTES);
      if (body === null) return context.json({ error: "request body too large" }, 413);
      (context.req.bodyCache as Record<string, unknown>).text = Promise.resolve(body); // handlers can still call c.req.text() / c.req.json()
      const url = new URL(context.req.url);
      let act: ProofActor;

      try {
        act = await verifyProof(token, { method: context.req.method, pathAndQuery: url.pathname + url.search, body });
      } catch (error) {
        warn(error);
        return deny(context);
      }

      context.set("caller" as never, "hub" as never);
      context.set("act" as never, act as never);
    } else {
      const hash = hashSecret(token);
      let ok = false;
      for (const stored of nodeAuthSettings.secretHashes) ok = hexEqual(hash, stored) || ok; // no early exit
      if (!ok) return deny(context);
      context.set("caller" as never, "secret" as never);
    }

    await next();
  };
}

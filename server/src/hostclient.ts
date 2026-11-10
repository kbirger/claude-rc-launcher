import { readSse, type SseEvent } from "./ssereader";
import { certFingerprint, signProof, type HubKey, type ProofRequest } from "./hubproof";

export type HostAuth = { type: "hub_key" } | { type: "secret"; secret: string };
export type HostConfig = { id: string; name: string; url: string; ca: string; serverName?: string; auth: HostAuth };

export type HostFailure = "unreachable" | "timeout" | "certificate mismatch" | "rejected our credentials" | "bad response";

export class HostError extends Error {
  constructor(
    public host: string,
    public reason: HostFailure,
  ) {
    super(`host ${host}: ${reason}`);
    this.name = "HostError";
  }
}

export interface HostClient {
  call(
    method: "GET" | "POST" | "DELETE",
    path: string,
    o?: { query?: Record<string, string>; json?: unknown; timeoutMs?: number },
  ): Promise<{ status: number; body: unknown }>;
  /**
   * Opens `GET <path>` as an event stream. No body timeout. Aborting `signal` ends the iteration without an error.
   * Breaking out of the loop closes the connection.
   */
  stream(path: string, o?: { signal?: AbortSignal }): Promise<AsyncIterable<SseEvent>>;
}

/** Returns the full `Authorization` header value for one exact request. */
export type Authorizer = (req: ProofRequest) => Promise<string>;

/** `Hub-Proof <jwt>` signed for the node whose certificate is `host.ca`. */
export function hubAuthorizer(key: HubKey, host: HostConfig): Authorizer {
  const aud = certFingerprint(host.ca);
  return async (req) => `Hub-Proof ${await signProof(key, req, aud)}`;
}

export function secretAuthorizer(secret: string): Authorizer {
  return async () => `Bearer ${secret}`;
}

export const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

const TLS_CODES = new Set([
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "HOSTNAME_MISMATCH",
]);

function classify(e: unknown): "timeout" | "certificate mismatch" | "unreachable" {
  const err = e as { name?: string; code?: string; message?: string };
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return "timeout";
  const text = `${err?.code ?? ""} ${err?.message ?? ""}`;
  if ((err?.code && TLS_CODES.has(err.code)) || /certificate|self[- ]signed|unable to verify|altname|hostname/i.test(text)) {
    return "certificate mismatch";
  }
  return "unreachable";
}

async function readCapped(res: Response): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Pinned HTTPS client for one node. Trust is exactly `host.ca` (the node's own certificate); the hostname is
 * still checked against its SAN (or `serverName`). Never disables verification.
 */
export function createHostClient(host: HostConfig, authorize: Authorizer, o: { fetch?: typeof fetch } = {}): HostClient {
  const doFetch = o.fetch ?? fetch;
  const fail = (reason: HostFailure, detail?: unknown): never => {
    if (detail !== undefined) console.error(`host ${host.id}: ${reason}:`, detail instanceof Error ? detail.message : detail);
    throw new HostError(host.id, reason);
  };
  return {
    async call(method, path, opts = {}) {
      const url = new URL(path, host.url);
      for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
      const headers: Record<string, string> = { accept: "application/json" };
      let body: string | undefined;
      if (opts.json !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(opts.json);
      } else if (method !== "GET") {
        headers["content-type"] = "application/json";
      }
      try {
        headers.authorization = await authorize({ method, pathAndQuery: url.pathname + url.search, body: body ?? "" });
      } catch (e) {
        return fail("rejected our credentials", e);
      }
      let res: Response;
      try {
        res = await doFetch(url, {
          method,
          headers,
          ...(body !== undefined ? { body } : {}),
          redirect: "manual",
          signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
          tls: { ca: host.ca, ...(host.serverName ? { serverName: host.serverName } : {}) },
        } as RequestInit);
      } catch (e) {
        return fail(classify(e), e);
      }
      if (res.status === 401) return fail("rejected our credentials");
      if (res.status >= 300 && res.status < 400) return fail("bad response", `redirect ${res.status}`);
      let text: string | null;
      try {
        text = await readCapped(res);
      } catch (e) {
        return fail(classify(e) === "timeout" ? "timeout" : "bad response", e);
      }
      if (text === null) return fail("bad response", "response too large");
      if (res.status === 204) return { status: 204, body: null };
      if (text === "") return fail("bad response", "empty body");
      try {
        return { status: res.status, body: JSON.parse(text) };
      } catch {
        return fail("bad response", "non-JSON body");
      }
    },
    async stream(path, opts = {}) {
      const url = new URL(path, host.url);
      const headers: Record<string, string> = { accept: "text/event-stream" };
      try {
        headers.authorization = await authorize({ method: "GET", pathAndQuery: url.pathname + url.search, body: "" });
      } catch (e) {
        return fail("rejected our credentials", e);
      }
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "GET",
          headers,
          redirect: "manual",
          ...(opts.signal ? { signal: opts.signal } : {}),
          tls: { ca: host.ca, ...(host.serverName ? { serverName: host.serverName } : {}) },
        } as RequestInit);
      } catch (e) {
        return fail(classify(e), e);
      }
      const drop = () => void res.body?.cancel().catch(() => {});
      if (res.status === 401) {
        drop();
        return fail("rejected our credentials");
      }
      const media = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (res.status !== 200 || media !== "text/event-stream" || !res.body) {
        drop();
        return fail("bad response", `status ${res.status}, content-type ${media || "none"}`);
      }
      const body = res.body;
      return (async function* () {
        try {
          yield* readSse(body);
        } catch (e) {
          if (opts.signal?.aborted) return;
          return fail("bad response", e);
        }
      })();
    },
  };
}

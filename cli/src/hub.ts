import { ExitError, LOGIN_MESSAGE, type Credentials } from "./creds";
import { readSse, type SseEvent } from "../../server/src/ssereader";

/** A non-2xx answer from the hub, keeping the status and parsed body so callers can react to it. */
export class HubError extends ExitError {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message, 1);
  }
}

export type Renew = (c: Credentials) => Promise<Credentials>;

const RENEW_WINDOW_S = 60;

/** Calls the hub's `/cli/api` with the ID token, renewing it before it expires and once after a 401. */
export function hubClient(o: { creds: Credentials; save: (c: Credentials) => void; renew: Renew; fetch?: typeof fetch; now?: () => number }) {
  const doFetch = o.fetch ?? fetch;
  const now = o.now ?? (() => Date.now() / 1000);
  let creds = o.creds;

  const refresh = async () => {
    try {
      creds = await o.renew(creds);
    } catch (e) {
      // `renew` reports a rejected refresh token as code 2. Any other failure (the identity provider is down, an
      // unexpected error) is not an expired login, so it keeps its own message and does not tell the user to log in.
      throw e instanceof ExitError ? e : new ExitError(`could not renew the login: ${(e as Error)?.message ?? String(e)}`, 1);
    }
    o.save(creds);
  };

  const send = async (method: string, path: string, body: unknown, timeoutMs?: number): Promise<Response> => {
    const headers: Record<string, string> = { authorization: `Bearer ${creds.idToken}`, accept: "application/json" };
    if (method !== "GET") headers["content-type"] = "application/json";
    try {
      return await doFetch(new URL(path, creds.hub), {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: "manual",
        ...(timeoutMs !== undefined ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      });
    } catch (e) {
      throw new ExitError(`cannot reach ${creds.hub}: ${(e as Error).message}`, 1);
    }
  };

  /** Opens a GET that stays open. The signal cancels the connect and the reading. */
  const sendStream = async (path: string, signal: AbortSignal | undefined): Promise<Response> => {
    try {
      return await doFetch(new URL(path, creds.hub), {
        method: "GET",
        headers: { authorization: `Bearer ${creds.idToken}`, accept: "text/event-stream" },
        redirect: "manual",
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      throw new ExitError(`cannot reach ${creds.hub}: ${(e as Error).message}`, 1);
    }
  };

  return {
    /**
     * Server-Sent Events from the hub. The login renews as in `request`, and one 401 renews once and retries. A
     * non-2xx answer throws. The stream ends when the hub closes it or when `opts.signal` aborts.
     */
    async *stream(path: string, opts?: { signal?: AbortSignal }): AsyncGenerator<SseEvent> {
      if (creds.expiresAt - now() < RENEW_WINDOW_S) await refresh();
      let res = await sendStream(path, opts?.signal);
      if (res.status === 401) {
        await res.body?.cancel().catch(() => {});
        await refresh();
        res = await sendStream(path, opts?.signal);
        if (res.status === 401) throw new ExitError(LOGIN_MESSAGE, 2);
      }
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        throw new HubError(`HTTP ${res.status}`, res.status, undefined);
      }
      try {
        yield* readSse(res.body);
      } catch (e) {
        if (opts?.signal?.aborted) return;
        throw e;
      }
    },

    /** `opts.timeoutMs` limits each attempt. Without it, a call has no time limit of its own. */
    async request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, opts?: { timeoutMs?: number }): Promise<T> {
      if (creds.expiresAt - now() < RENEW_WINDOW_S) await refresh();
      let res = await send(method, path, body, opts?.timeoutMs);
      if (res.status === 401) {
        await refresh();
        res = await send(method, path, body, opts?.timeoutMs);
        if (res.status === 401) throw new ExitError(LOGIN_MESSAGE, 2);
      }
      if (res.status === 204) return undefined as T;
      let parsed: any = undefined;
      try {
        parsed = await res.json();
      } catch {
        /* handled below */
      }
      if (!res.ok) throw new HubError(typeof parsed?.error === "string" ? parsed.error : `HTTP ${res.status}`, res.status, parsed);
      return parsed as T;
    },
  };
}

export type HubClient = ReturnType<typeof hubClient>;

import { readSse } from "../../server/src/ssereader";
import type { SseEvent } from "../../server/src/ssereader";
import { ExitError, LOGIN_MESSAGE } from "./creds";
import type { Credentials } from "./creds";

/** A non-2xx answer from the hub, keeping the status and parsed body so callers can react to it. */
export class HubError extends ExitError {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message, 1);
  }
}

export type Renew = (credentials: Credentials) => Promise<Credentials>;

const RENEW_WINDOW_S = 60;

/** Calls the hub's `/cli/api` with the ID token, renewing it before it expires and once after a 401. */
export function hubClient(options: {
  creds: Credentials;
  save: (credentials: Credentials) => void;
  renew: Renew;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => Date.now() / 1000);
  let creds = options.creds;

  // Two calls near expiry share one renewal: the second one waits for the first.
  let renewing: Promise<void> | undefined;
  const refresh = (): Promise<void> => (renewing ??= renewOnce().finally(() => (renewing = undefined)));

  const renewOnce = async () => {
    try {
      creds = await options.renew(creds);
    } catch (error) {
      // `renew` reports a rejected refresh token as code 2. Any other failure (the identity provider is down, an
      // unexpected error) is not an expired login, so it keeps its own message and does not tell the user to log in.
      throw error instanceof ExitError
        ? error
        : new ExitError(`could not renew the login: ${(error as Error)?.message ?? String(error)}`, 1);
    }

    options.save(creds);
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
    } catch (error) {
      throw new ExitError(`cannot reach ${creds.hub}: ${(error as Error).message}`, 1);
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
    } catch (error) {
      throw new ExitError(`cannot reach ${creds.hub}: ${(error as Error).message}`, 1);
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
      } catch (error) {
        if (opts?.signal?.aborted) return;
        throw error;
      }
    },

    /** `opts.timeoutMs` limits each attempt. Without it, a call has no time limit of its own. */
    async request<Value>(
      method: "GET" | "POST" | "PATCH" | "DELETE",
      path: string,
      body?: unknown,
      opts?: { timeoutMs?: number },
    ): Promise<Value> {
      if (creds.expiresAt - now() < RENEW_WINDOW_S) await refresh();
      let res = await send(method, path, body, opts?.timeoutMs);

      if (res.status === 401) {
        await refresh();
        res = await send(method, path, body, opts?.timeoutMs);
        if (res.status === 401) throw new ExitError(LOGIN_MESSAGE, 2);
      }

      if (res.status === 204) return undefined as Value;
      let parsed: any = undefined;

      try {
        parsed = await res.json();
      } catch {
        /* handled below */
      }

      if (!res.ok)
        throw new HubError(typeof parsed?.error === "string" ? parsed.error : `HTTP ${res.status}`, res.status, parsed);
      return parsed as Value;
    },
  };
}

export type HubClient = ReturnType<typeof hubClient>;

import { ExitError, LOGIN_MESSAGE, type Credentials } from "./creds";

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

  const send = async (method: string, path: string, body: unknown): Promise<Response> => {
    const headers: Record<string, string> = { authorization: `Bearer ${creds.idToken}`, accept: "application/json" };
    if (method !== "GET") headers["content-type"] = "application/json";
    try {
      return await doFetch(new URL(path, creds.hub), { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: "manual" });
    } catch (e) {
      throw new ExitError(`cannot reach ${creds.hub}: ${(e as Error).message}`, 1);
    }
  };

  return {
    async request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
      if (creds.expiresAt - now() < RENEW_WINDOW_S) await refresh();
      let res = await send(method, path, body);
      if (res.status === 401) {
        await refresh();
        res = await send(method, path, body);
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

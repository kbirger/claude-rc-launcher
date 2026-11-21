export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function request<Value>(method: string, url: string, body?: unknown): Promise<Value> {
  const init: RequestInit = { method, headers: {} };

  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  } else if (method !== "GET") {
    init.headers = { "Content-Type": "application/json" };
  }

  const res = await fetch(url, init);

  if (res.status === 401) {
    const loc: Location | undefined = globalThis.location;
    // "/" starts login in oidc mode (redirect to /auth/login) and hands over to the proxy in proxy-jwt mode,
    // where /auth/login does not exist.
    if (loc) loc.href = "/";
  }

  if (!res.ok) {
    let parsed: Record<string, unknown> = {};

    try {
      const json: unknown = await res.json();
      if (typeof json === "object" && json !== null && !Array.isArray(json)) parsed = json as Record<string, unknown>;
    } catch {
      /* keep the empty body */
    }

    throw new ApiError(
      res.status,
      typeof parsed.error === "string" ? parsed.error : res.statusText || `HTTP ${res.status}`,
      parsed,
    );
  }

  if (res.status === 204) return undefined as Value;
  return (await res.json()) as Value;
}

export const hostUrl = (host: string) => `/api/hosts/${encodeURIComponent(host)}`;

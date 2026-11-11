export class ApiError extends Error {
  constructor(public status: number, message: string, public body: any = {}) {
    super(message);
    this.name = "ApiError";
  }
}

export async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  } else if (method !== "GET") {
    init.headers = { "Content-Type": "application/json" };
  }
  const res = await fetch(url, init);
  if (res.status === 401) {
    const loc = (globalThis as any).location;
    // "/" starts login in oidc mode (redirect to /auth/login) and hands over to the proxy in proxy-jwt mode,
    // where /auth/login does not exist.
    if (loc) loc.href = "/";
  }
  if (!res.ok) {
    let parsed: any = {};
    try {
      parsed = await res.json();
    } catch {}
    throw new ApiError(res.status, typeof parsed?.error === "string" ? parsed.error : res.statusText || `HTTP ${res.status}`, parsed);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const hostUrl = (host: string) => `/api/hosts/${encodeURIComponent(host)}`;

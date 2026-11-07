export type Instance = { id: string; path: string; name: string; state: string; startedAt: string | null };
export type DirListing = { path: string; parent: string | null; dirs: { name: string; path: string }[] };
export type Me = { sub: string; name: string; email?: string; username?: string; logoutUrl?: string };
export type HostInfo = { id: string; name: string; status: "ok" | "offline" | "error"; error?: string };

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: any = {}) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
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

const h = (host: string) => `/api/hosts/${encodeURIComponent(host)}`;
export const listHosts = () => request<HostInfo[]>("GET", "/api/hosts");
export const listInstances = (host: string) => request<Instance[]>("GET", `${h(host)}/instances`);
export const startInstance = (host: string, path: string, name?: string) =>
  request<Instance>("POST", `${h(host)}/instances`, name ? { path, name } : { path });
export const stopInstance = (host: string, id: string) => request<void>("DELETE", `${h(host)}/instances/${encodeURIComponent(id)}`);
export const getLogs = async (host: string, id: string, lines = 100) =>
  (await request<{ log: string }>("GET", `${h(host)}/instances/${encodeURIComponent(id)}/logs?lines=${lines}`)).log;
export const browse = (host: string, path?: string) =>
  request<DirListing>("GET", path ? `${h(host)}/fs?path=${encodeURIComponent(path)}` : `${h(host)}/fs`);
export const mkdir = (host: string, parent: string, name: string) =>
  request<{ path: string }>("POST", `${h(host)}/fs/mkdir`, { parent, name });
export const getMe = () => request<Me>("GET", "/api/me");

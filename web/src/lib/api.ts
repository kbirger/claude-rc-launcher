export type Instance = { id: string; path: string; name: string; state: string; startedAt: string | null };
export type DirListing = { path: string; parent: string | null; dirs: { name: string; path: string }[] };
export type Me = { sub: string; name: string; email?: string };

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
    if (loc) loc.href = "/auth/login";
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

export const listInstances = () => request<Instance[]>("GET", "/api/instances");
export const startInstance = (path: string, name?: string) =>
  request<Instance>("POST", "/api/instances", name ? { path, name } : { path });
export const stopInstance = (id: string) => request<void>("DELETE", `/api/instances/${encodeURIComponent(id)}`);
export const getLogs = async (id: string, lines = 100) =>
  (await request<{ log: string }>("GET", `/api/instances/${encodeURIComponent(id)}/logs?lines=${lines}`)).log;
export const browse = (path?: string) =>
  request<DirListing>("GET", path ? `/api/fs?path=${encodeURIComponent(path)}` : "/api/fs");
export const mkdir = (parent: string, name: string) => request<{ path: string }>("POST", "/api/fs/mkdir", { parent, name });
export const getMe = () => request<Me>("GET", "/api/me");

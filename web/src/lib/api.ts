export type Instance = { id: string; path: string; name: string; state: string; startedAt: string | null; user?: string };
export type DirListing = { path: string; parent: string | null; dirs: { name: string; path: string; trusted?: boolean; kind?: "git" | "github" }[] };
export type UsersInfo = { selectable: boolean; default: string; users: { name: string }[] };
export type Me = { sub: string; name: string; email?: string; username?: string; logoutUrl?: string };
export type HostInfo = { id: string; name: string; status: "ok" | "offline" | "restarting" | "error"; error?: string; source?: string; version?: string; clientVersion?: string; noClient?: boolean; stale?: boolean; target?: string };
export type UpdateEntry = {
  host: string;
  startedAt: string;
  finishedAt?: string;
  startedBy: string;
  from: string;
  to?: string;
  status: "running" | "updated" | "up-to-date" | "failed" | "rolled back" | "unknown";
  error?: string;
  step?: string;
  stepDetail?: string;
};
export type LogLine = { line: string; at: string };
export type Presence = { host: string; status: "online" | "offline" | "restarting" | "error"; version?: string; reason?: string; at: string };
export type Latest = { version: string; checkedAt: string };

export type RepoGroup = { owner: string; repos: { name: string; private: boolean; pushedAt: string }[] };

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
export const startInstance = (host: string, path: string, name?: string, opts?: { user?: string; addTrust?: boolean }) =>
  request<Instance>("POST", `${h(host)}/instances`, {
    path,
    ...(name ? { name } : {}),
    ...(opts?.user ? { user: opts.user } : {}),
    ...(opts?.addTrust ? { addTrust: true } : {}),
  });
export const listUsers = (host: string) => request<UsersInfo>("GET", `${h(host)}/users`);
export const stopInstance = (host: string, id: string) => request<void>("DELETE", `${h(host)}/instances/${encodeURIComponent(id)}`);
export const getLogs = async (host: string, id: string, lines = 100) =>
  (await request<{ log: string }>("GET", `${h(host)}/instances/${encodeURIComponent(id)}/logs?lines=${lines}`)).log;
export const browse = (host: string, path?: string, user?: string) => {
  const q = [path ? `path=${encodeURIComponent(path)}` : "", user ? `user=${encodeURIComponent(user)}` : ""].filter(Boolean).join("&");
  return request<DirListing>("GET", q ? `${h(host)}/fs?${q}` : `${h(host)}/fs`);
};
export const mkdir = (host: string, parent: string, name: string, user?: string) =>
  request<{ path: string }>("POST", `${h(host)}/fs/mkdir`, { parent, name, ...(user ? { user } : {}) });
export const getMe = () => request<Me>("GET", "/api/me");
export const getNode = (host: string) => request<{ clone?: boolean }>("GET", `${h(host)}/node`);
export const cloneStart = (host: string, repo: string, parent: string, user?: string) =>
  request<{ id: string; path: string }>("POST", `${h(host)}/clone`, { repo, parent, ...(user ? { user } : {}) });
export const cloneStatus = (host: string, id: string) =>
  request<{ state: "running" | "done" | "failed"; path?: string; error?: string }>("GET", `${h(host)}/clone/${encodeURIComponent(id)}`);
export const listRepos = (host: string, user?: string) =>
  request<{ groups: RepoGroup[] }>("GET", `${h(host)}/github/repos${user ? `?user=${encodeURIComponent(user)}` : ""}`);
// The body is always sent: the server rejects an empty body.
export const githubLoginStart = (host: string, user?: string) =>
  request<{ id: string; code: string; url: string }>("POST", `${h(host)}/github/login`, user ? { user } : {});
export const githubLoginStatus = (host: string, id: string) =>
  request<{ state: string; error?: string }>("GET", `${h(host)}/github/login/${encodeURIComponent(id)}`);
export const getLatest = () => request<Latest>("GET", "/api/latest");
export const getUpdates = () => request<UpdateEntry[]>("GET", "/api/updates");
// The body carries at most the release; the hub picks the download itself.
export const updateHost = (host: string, release?: string) =>
  request<{ status: string; from: string; to?: string; clients?: unknown; error?: string }>("POST", `${h(host)}/update`, release ? { release } : {});

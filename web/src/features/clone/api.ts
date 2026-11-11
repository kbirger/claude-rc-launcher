import { hostUrl, request } from "../../shared/http";

export type RepoGroup = { owner: string; repos: { name: string; private: boolean; pushedAt: string }[] };

export const cloneStart = (host: string, repo: string, parent: string, user?: string) =>
  request<{ id: string; path: string }>("POST", `${hostUrl(host)}/clone`, { repo, parent, ...(user ? { user } : {}) });
export const cloneStatus = (host: string, id: string) =>
  request<{ state: "running" | "done" | "failed"; path?: string; error?: string }>("GET", `${hostUrl(host)}/clone/${encodeURIComponent(id)}`);
export const listRepos = (host: string, user?: string) =>
  request<{ groups: RepoGroup[] }>("GET", `${hostUrl(host)}/github/repos${user ? `?user=${encodeURIComponent(user)}` : ""}`);
// The body is always sent: the server rejects an empty body.
export const githubLoginStart = (host: string, user?: string) =>
  request<{ id: string; code: string; url: string }>("POST", `${hostUrl(host)}/github/login`, user ? { user } : {});
export const githubLoginStatus = (host: string, id: string) =>
  request<{ state: string; error?: string }>("GET", `${hostUrl(host)}/github/login/${encodeURIComponent(id)}`);

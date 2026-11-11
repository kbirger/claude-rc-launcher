import { hostUrl, request } from "../../shared/http";

export type DirListing = { path: string; parent: string | null; dirs: { name: string; path: string; trusted?: boolean; kind?: "git" | "github" }[] };
export type UsersInfo = { selectable: boolean; default: string; users: { name: string }[] };

export const listUsers = (host: string) => request<UsersInfo>("GET", `${hostUrl(host)}/users`);
export const browse = (host: string, path?: string, user?: string) => {
  const q = [path ? `path=${encodeURIComponent(path)}` : "", user ? `user=${encodeURIComponent(user)}` : ""].filter(Boolean).join("&");
  return request<DirListing>("GET", q ? `${hostUrl(host)}/fs?${q}` : `${hostUrl(host)}/fs`);
};
export const mkdir = (host: string, parent: string, name: string, user?: string) =>
  request<{ path: string }>("POST", `${hostUrl(host)}/fs/mkdir`, { parent, name, ...(user ? { user } : {}) });
export const getNode = (host: string) => request<{ clone?: boolean }>("GET", `${hostUrl(host)}/node`);

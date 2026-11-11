import { ApiError, hostUrl, request } from "../../shared/http";

export type Session = { id: string; root: string; name?: string; branch?: string; startedAt: string; lastActiveAt: string };
export type TouchedFile = { path: string; inside: boolean; tool: "write" | "edit"; at: string };
export type Entry = { name: string; kind: "dir" | "file" | "other"; size?: number; mtime: string };
export type Listing = { path: string; parent: string | null; entries: Entry[] };
export type Preview = { name: string; size: number; kind: "text" | "binary"; text?: string; truncated?: boolean };

const base = (host: string, instance: string) => `${hostUrl(host)}/instances/${encodeURIComponent(instance)}/sessions`;
const sessionBase = (host: string, instance: string, session: string) => `${base(host, instance)}/${encodeURIComponent(session)}`;

export const listSessions = (host: string, instance: string) => request<Session[]>("GET", base(host, instance));

export const getTouched = (host: string, instance: string, session: string) =>
  request<TouchedFile[]>("GET", `${sessionBase(host, instance, session)}/touched`);

export const listFiles = (host: string, instance: string, session: string, path: string, hidden: boolean) => {
  const q = new URLSearchParams();
  if (path) q.set("path", path);
  if (hidden) q.set("hidden", "1");
  const qs = q.toString();
  return request<Listing>("GET", `${sessionBase(host, instance, session)}/files${qs ? `?${qs}` : ""}`);
};

export const getPreview = (host: string, instance: string, session: string, path: string) =>
  request<Preview>("GET", `${sessionBase(host, instance, session)}/file?${new URLSearchParams({ path })}`);

/** A plain link: the browser sends its login cookie with it. */
export const downloadUrl = (host: string, instance: string, session: string, path: string) =>
  `${sessionBase(host, instance, session)}/download?path=${encodeURIComponent(path)}`;

/** True when the node has no session files feature (404 or 501). */
export const isUnsupported = (e: unknown): boolean => e instanceof ApiError && (e.status === 404 || e.status === 501);

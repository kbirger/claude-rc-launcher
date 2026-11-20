import { hostUrl, request } from "../../shared/http";

/** `live`: set only while the session runs. `status` is "busy" or "idle", or absent for a status the node does not know. `remoteControl`: attached to Remote Control. */
export type Session = { id: string; root: string; name?: string; branch?: string; startedAt: string; lastActiveAt: string; live?: { status?: string; remoteControl: boolean }; earlier?: string[] };
/** `confirmed`: the write succeeded. A denied, failed or unanswered call is false. A node older than this field sends none. */
export type TouchedFile = { path: string; inside: boolean; tool: "write" | "edit"; at: string; confirmed?: boolean };
export type Entry = { name: string; kind: "dir" | "file" | "other"; size?: number; mtime: string };
export type Listing = { path: string; parent: string | null; entries: Entry[] };
export type Preview = { name: string; size: number; kind: "text" | "binary"; text?: string; truncated?: boolean };

const base = (host: string, instance: string) => `${hostUrl(host)}/instances/${encodeURIComponent(instance)}/sessions`;
const sessionBase = (host: string, instance: string, session: string) => `${base(host, instance)}/${encodeURIComponent(session)}`;

/** A session of the hub list: the node and the instance it belongs to come with it. */
export type GlobalSession = Session & { instance: { id: string; name: string; path: string; state: string }; host: { id: string; name: string } };
/** What the hub knows about one node's part of the list. `unavailable`: the node cannot list sessions. `loading`: no list yet. */
export type HostSessions = { id: string; name: string; status: "ok" | "offline" | "error" | "unavailable" | "loading"; error?: string; scannedAt?: string };
export type AllSessions = { sessions: GlobalSession[]; hosts: HostSessions[] };
/** One host's part of the list: the `host` event of the sessions stream. */
export type HostPart = { host: HostSessions; rows: GlobalSession[] };

/** The sessions of every node and instance, from the hub (each node answers from its own cached list). */
export const listAllSessions = () => request<AllSessions>("GET", "/api/sessions");

export const getTouched = (host: string, instance: string, session: string) =>
  request<TouchedFile[]>("GET", `${sessionBase(host, instance, session)}/touched`);

/** A file that git shows as changed in the session folder since the session started (the node sends it from /changed). */
export type ChangedFile = TouchedFile & { state: "uncommitted" | "committed" | "deleted" };

export const getChanged = (host: string, instance: string, session: string) =>
  request<ChangedFile[]>("GET", `${sessionBase(host, instance, session)}/changed`);

export const listFiles = (host: string, instance: string, session: string, path: string, hidden: boolean) => {
  const q = new URLSearchParams();
  if (path) q.set("path", path);
  if (hidden) q.set("hidden", "1");
  const qs = q.toString();
  return request<Listing>("GET", `${sessionBase(host, instance, session)}/files${qs ? `?${qs}` : ""}`);
};

/** `abs: true`: `path` is the absolute path of a touched file (it may be outside the session folder). */
export type FileOpts = { abs?: boolean };
const fileKey = (o: FileOpts) => (o.abs ? "abs" : "path");

export const getPreview = (host: string, instance: string, session: string, path: string, o: FileOpts = {}) =>
  request<Preview>("GET", `${sessionBase(host, instance, session)}/file?${new URLSearchParams({ [fileKey(o)]: path })}`);

/** A plain link: the browser sends its login cookie with it. */
export const downloadUrl = (host: string, instance: string, session: string, path: string, o: FileOpts = {}) =>
  `${sessionBase(host, instance, session)}/download?${fileKey(o)}=${encodeURIComponent(path)}`;

import { request } from "../../shared/http";

export type HostInfo = { id: string; name: string; status: "ok" | "offline" | "restarting" | "error"; error?: string; source?: string; version?: string; clientVersion?: string; noClient?: boolean; platform?: string; definition?: { installed: number; required: number }; stale?: boolean; target?: string };

export const listHosts = () => request<HostInfo[]>("GET", "/api/hosts");

export const renameHost = (id: string, name: string) => request<{ id: string; name: string }>("PATCH", `/api/hosts/${encodeURIComponent(id)}`, { name });

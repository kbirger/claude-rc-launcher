import { hostUrl, request } from "../../shared/http";

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
export type Latest = { version: string; checkedAt: string };
export type HistoryItem = { entry: UpdateEntry; lines: LogLine[] };

export const getLatest = () => request<Latest>("GET", "/api/latest");
export const getHistory = () => request<Record<string, HistoryItem[]>>("GET", "/api/updates/history");
export const getUpdates = () => request<UpdateEntry[]>("GET", "/api/updates");
// The body carries at most the release; the hub picks the download itself.
export const updateHost = (host: string, release?: string) =>
  request<{ status: string; from: string; to?: string; clients?: unknown; error?: string }>("POST", `${hostUrl(host)}/update`, release ? { release } : {});

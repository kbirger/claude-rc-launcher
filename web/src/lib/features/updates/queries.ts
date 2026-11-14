import { commonQuery } from "../../shared/query";
import { type LogLine, getHistory, getLatest, getReleaseNotes, getUpdates } from "./api";

export const UPDATES_KEY = ["updates"] as const;
export const HISTORY_KEY = ["history"] as const;
export const LOGS_KEY = ["logs"] as const;
export const LATEST_KEY = ["latest"] as const;

/** After a failure the hub waits 60 seconds before it asks GitHub again, so the page asks again every 30 seconds. */
export const latestQuery = () => ({ queryKey: LATEST_KEY, queryFn: getLatest, ...commonQuery, retry: false, refetchInterval: (q: { state: { status: string } }) => (q.state.status === "error" ? 30_000 : false) });
export const POLL_MS = 3000;
/** While an update runs, read the record again every 3 seconds, in case the stream missed an event. */
export const pollWhileRunning = (data: { status: string }[] | undefined): number | false => (data?.some((e) => e.status === "running") ? POLL_MS : false);
export const updatesQuery = () => ({ queryKey: UPDATES_KEY, queryFn: getUpdates, ...commonQuery, refetchInterval: (q: { state: { data: { status: string }[] | undefined } }) => pollWhileRunning(q.state.data) });
export const historyQuery = () => ({ queryKey: HISTORY_KEY, queryFn: getHistory, ...commonQuery, retry: false });
// The lines only come from the event stream, so the query never fetches by itself. No observer exists while the panel is closed, so the cache must not be collected.
export const logsQuery = () => ({ queryKey: LOGS_KEY, queryFn: async (): Promise<Record<string, LogLine[]>> => ({}), enabled: false, gcTime: Infinity });
export const RELEASE_NOTES_KEY = ["release-notes"] as const;
/** The notes of two fixed releases do not change, so they never go stale. */
export const releaseNotesQuery = (from: string, to: string) => ({ queryKey: [...RELEASE_NOTES_KEY, from, to] as const, queryFn: () => getReleaseNotes(from, to), ...commonQuery, retry: false, staleTime: Infinity });

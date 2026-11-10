import { type LogLine, getHistory, getLatest, getUpdates, listHosts } from "./api";

export const STALE_MS = 300_000;

const common = { staleTime: STALE_MS, refetchOnWindowFocus: true } as const;

export const hostsQuery = () => ({ queryKey: ["hosts"] as const, queryFn: listHosts, ...common });
/** After a failure the hub waits 60 seconds before it asks GitHub again, so the page asks again every 30 seconds. */
export const latestQuery = () => ({ queryKey: ["latest"] as const, queryFn: getLatest, ...common, retry: false, refetchInterval: (q: { state: { status: string } }) => (q.state.status === "error" ? 30_000 : false) });
export const POLL_MS = 3000;
/** While an update runs, read the record again every 3 seconds, in case the stream missed an event. */
export const pollWhileRunning = (data: { status: string }[] | undefined): number | false => (data?.some((e) => e.status === "running") ? POLL_MS : false);
export const updatesQuery = () => ({ queryKey: ["updates"] as const, queryFn: getUpdates, ...common, refetchInterval: (q: { state: { data: { status: string }[] | undefined } }) => pollWhileRunning(q.state.data) });
export const historyQuery = () => ({ queryKey: ["history"] as const, queryFn: getHistory, ...common, retry: false });
// The lines only come from the event stream, so the query never fetches by itself. No observer exists while the panel is closed, so the cache must not be collected.
export const logsQuery = () => ({ queryKey: ["logs"] as const, queryFn: async (): Promise<Record<string, LogLine[]>> => ({}), enabled: false, gcTime: Infinity });

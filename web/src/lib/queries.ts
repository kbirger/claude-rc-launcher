import { type LogLine, getLatest, getUpdates, listHosts } from "./api";

export const STALE_MS = 300_000;

const common = { staleTime: STALE_MS, refetchOnWindowFocus: true } as const;

export const hostsQuery = () => ({ queryKey: ["hosts"] as const, queryFn: listHosts, ...common });
export const latestQuery = () => ({ queryKey: ["latest"] as const, queryFn: getLatest, ...common, retry: false });
export const updatesQuery = () => ({ queryKey: ["updates"] as const, queryFn: getUpdates, ...common });
// The lines only come from the event stream, so the query never fetches by itself.
export const logsQuery = () => ({ queryKey: ["logs"] as const, queryFn: async (): Promise<Record<string, LogLine[]>> => ({}), enabled: false });

import { getLatest, getUpdates, listHosts } from "./api";

export const STALE_MS = 300_000;

const common = { staleTime: STALE_MS, refetchOnWindowFocus: true } as const;

export const hostsQuery = () => ({ queryKey: ["hosts"] as const, queryFn: listHosts, ...common });
export const latestQuery = () => ({ queryKey: ["latest"] as const, queryFn: getLatest, ...common, retry: false });
export const updatesQuery = () => ({ queryKey: ["updates"] as const, queryFn: getUpdates, ...common });

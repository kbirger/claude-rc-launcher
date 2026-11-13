import { getChanged, getPreview, getTouched, listFiles, listSessions } from "./api";

export const SESSIONS_POLL_MS = 15000;
export const SESSIONS_STALE_MS = 5000;

export const sessionsQuery = (host: string, instance: string) => ({
  queryKey: ["sessions", host, instance] as const,
  queryFn: () => listSessions(host, instance),
  staleTime: SESSIONS_STALE_MS,
  refetchInterval: SESSIONS_POLL_MS,
  refetchOnWindowFocus: true,
  retry: false as const,
});

export const touchedQuery = (host: string, instance: string, session: string) => ({
  queryKey: ["session-touched", host, instance, session] as readonly string[],
  queryFn: () => getTouched(host, instance, session),
  staleTime: SESSIONS_STALE_MS,
  refetchOnWindowFocus: true,
  retry: false as const,
});

export const changedQuery = (host: string, instance: string, session: string) => ({
  queryKey: ["session-changed", host, instance, session] as readonly string[],
  queryFn: () => getChanged(host, instance, session),
  staleTime: SESSIONS_STALE_MS,
  refetchOnWindowFocus: true,
  retry: false as const,
});

export const filesQuery = (host: string, instance: string, session: string, path: string, hidden: boolean) => ({
  queryKey: ["session-files", host, instance, session, path, hidden] as const,
  queryFn: () => listFiles(host, instance, session, path, hidden),
  staleTime: SESSIONS_STALE_MS,
  refetchOnWindowFocus: true,
  retry: false as const,
});

// One read each time a file opens: no cache is kept once it closes.
export const previewQuery = (host: string, instance: string, session: string, path: string, abs = false) => ({
  queryKey: (abs ? ["session-preview", host, instance, session, "abs", path] : ["session-preview", host, instance, session, path]) as readonly string[],
  queryFn: () => getPreview(host, instance, session, path, { abs }),
  staleTime: 0,
  gcTime: 0,
  retry: false as const,
  refetchOnWindowFocus: false,
});

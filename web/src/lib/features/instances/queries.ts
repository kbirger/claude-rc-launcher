import { getInstanceSettingsHelp, getLogs, listInstances } from "./api";

export const INSTANCES_POLL_MS = 5000;
export const INSTANCES_STALE_MS = 2000;

export const instancesQuery = (host: string) => ({
  queryKey: ["instances", host] as const,
  queryFn: () => listInstances(host),
  staleTime: INSTANCES_STALE_MS,
  refetchInterval: INSTANCES_POLL_MS,
  refetchOnWindowFocus: true,
  retry: false as const,
});

// One read each time the panel opens: no cache is kept once it closes.
export const instanceLogsQuery = (host: string, id: string) => ({
  queryKey: ["instance-logs", host, id] as const,
  queryFn: () => getLogs(host, id, 100),
  staleTime: 0,
  gcTime: 0,
  retry: false as const,
  refetchOnWindowFocus: false,
});

// The help text changes only with a node update. Its key is not under ["instances", host], so a list refresh does not read it again.
// An old node gives null. Any other failure also hides the settings controls, with no message.
export const settingsHelpQuery = (host: string) => ({
  queryKey: ["instance-settings", host] as const,
  queryFn: () => getInstanceSettingsHelp(host),
  staleTime: 5 * 60_000,
  retry: false as const,
  refetchOnWindowFocus: false,
});

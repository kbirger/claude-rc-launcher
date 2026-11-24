import { getStatus, listGrants, listTargets } from "./api";

export const SSH_STALE_MS = 5000;
export const SSH_KEY = ["ssh"] as const;

const live = { staleTime: SSH_STALE_MS, refetchOnWindowFocus: true, retry: false as const };

export const statusQuery = () => ({
  queryKey: [...SSH_KEY, "status"] as readonly string[],
  queryFn: getStatus,
  ...live,
});

export const targetsQuery = () => ({
  queryKey: [...SSH_KEY, "targets"] as readonly string[],
  queryFn: listTargets,
  ...live,
});

export const grantsQuery = () => ({
  queryKey: [...SSH_KEY, "grants"] as readonly string[],
  queryFn: listGrants,
  ...live,
});

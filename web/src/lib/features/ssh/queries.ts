import { getProvision, getStatus, getTarget, listGrants, listTargets } from "./api";

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

// One target with its notes, read fresh each time a sheet mounts. The wizard and the provisioner key card use it.
export const targetQuery = (id: string, enabled = true) => ({
  queryKey: [...SSH_KEY, "target", id] as readonly string[],
  queryFn: () => getTarget(id),
  enabled,
  retry: false as const,
  staleTime: 0,
});

// The install script of an external target, for the install step of the wizard when the line is not on screen.
export const provisionQuery = (id: string, enabled: boolean) => ({
  queryKey: [...SSH_KEY, "provision", id] as readonly string[],
  queryFn: () => getProvision(id),
  enabled,
  retry: false as const,
});

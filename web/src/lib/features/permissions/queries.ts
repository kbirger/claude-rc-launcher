import { getBlocked, getSessionPermissions, getUserPermissions } from "./api";

export const PERMISSIONS_STALE_MS = 5000;

export const userPermissionsQuery = (host: string, instance: string) => ({
  queryKey: ["permissions", host, instance] as readonly string[],
  queryFn: () => getUserPermissions(host, instance),
  staleTime: PERMISSIONS_STALE_MS,
  refetchOnWindowFocus: true,
  retry: false as const,
});

export const sessionPermissionsQuery = (host: string, instance: string, session: string) => ({
  queryKey: ["session-permissions", host, instance, session] as readonly string[],
  queryFn: () => getSessionPermissions(host, instance, session),
  staleTime: PERMISSIONS_STALE_MS,
  refetchOnWindowFocus: true,
  retry: false as const,
});

export const blockedQuery = (host: string, instance: string, session: string) => ({
  queryKey: ["session-blocked", host, instance, session] as readonly string[],
  queryFn: () => getBlocked(host, instance, session),
  staleTime: PERMISSIONS_STALE_MS,
  refetchOnWindowFocus: true,
  retry: false as const,
});

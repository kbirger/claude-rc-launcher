import type { QueryClient } from "@tanstack/svelte-query";
import { STALE_MS } from "../../shared/query";
import { browse, getNode, listUsers, mkdir } from "./api";

export const usersQuery = (host: string) => ({
  queryKey: ["users", host] as const,
  queryFn: () => listUsers(host),
  staleTime: STALE_MS,
  retry: false as const,
});

export const nodeQuery = (host: string) => ({
  queryKey: ["node", host] as const,
  queryFn: () => getNode(host),
  staleTime: STALE_MS,
  retry: false as const,
});

// No placeholderData: a listing of another folder or user must never show while the next one loads, because Start would use it.
export const browseQuery = (host: string, path?: string, user?: string) => ({
  queryKey: ["browse", host, path ?? "", user ?? ""] as const,
  queryFn: () => browse(host, path, user),
  staleTime: 5000,
  retry: false as const,
});

export type MkdirArgs = { parent: string; name: string; user?: string };

export const mkdirMutation = (host: string, client: QueryClient) => ({
  mutationKey: ["mkdir", host] as const,
  mutationFn: (v: MkdirArgs) => mkdir(host, v.parent, v.name, v.user),
  onSettled: () => client.invalidateQueries({ queryKey: ["browse", host] }),
});

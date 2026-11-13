import type { QueryClient } from "@tanstack/svelte-query";
import { pauseInstance, resumeInstance, startInstance, stopInstance } from "./api";

export type StartArgs = { path: string; name?: string; user?: string; addTrust?: boolean };

// No onSettled: the caller invalidates the list of the host it started on.
export const startInstanceMutation = (host: string) => ({
  mutationKey: ["instances", host, "start"] as const,
  mutationFn: (v: StartArgs) => startInstance(host, v.path, v.name, { user: v.user, addTrust: v.addTrust }),
});

export const stopInstanceMutation = (host: string, client: QueryClient) => ({
  mutationKey: ["instances", host, "stop"] as const,
  mutationFn: (id: string) => stopInstance(host, id),
  onSettled: () => client.invalidateQueries({ queryKey: ["instances", host] }),
});

// Pause keeps the instance (its service is stopped, its entry stays); resume starts it again.
export const pauseInstanceMutation = (host: string, client: QueryClient) => ({
  mutationKey: ["instances", host, "pause"] as const,
  mutationFn: (id: string) => pauseInstance(host, id),
  onSettled: () => client.invalidateQueries({ queryKey: ["instances", host] }),
});

export const resumeInstanceMutation = (host: string, client: QueryClient) => ({
  mutationKey: ["instances", host, "resume"] as const,
  mutationFn: (id: string) => resumeInstance(host, id),
  onSettled: () => client.invalidateQueries({ queryKey: ["instances", host] }),
});

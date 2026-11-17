import type { QueryClient } from "@tanstack/svelte-query";
import { pauseInstance, restartInstance, resumeInstance, startInstance, stopInstance, updateInstanceSettings, type SettingsPatch, type SpawnMode } from "./api";

// The settings are set only when the node has the settings route: an old node gets none.
export type StartArgs = { path: string; name?: string; user?: string; addTrust?: boolean; createSession?: boolean; spawnMode?: SpawnMode };

// No onSettled: the caller invalidates the list of the host it started on.
export const startInstanceMutation = (host: string) => ({
  mutationKey: ["instances", host, "start"] as const,
  mutationFn: (v: StartArgs) => startInstance(host, v.path, v.name, { user: v.user, addTrust: v.addTrust, createSession: v.createSession, spawnMode: v.spawnMode }),
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

export type SettingsArgs = { id: string; patch: SettingsPatch };

// A change restarts the instance and can take about a minute. The list refreshes after it, whatever the answer.
export const updateSettingsMutation = (host: string, client: QueryClient) => ({
  mutationKey: ["instances", host, "settings"] as const,
  mutationFn: (v: SettingsArgs) => updateInstanceSettings(host, v.id, v.patch),
  onSettled: () => client.invalidateQueries({ queryKey: ["instances", host] }),
});

export const restartInstanceMutation = (host: string, client: QueryClient) => ({
  mutationKey: ["instances", host, "restart"] as const,
  mutationFn: (id: string) => restartInstance(host, id),
  onSettled: () => client.invalidateQueries({ queryKey: ["instances", host] }),
});

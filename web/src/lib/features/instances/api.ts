import { ApiError, hostUrl, request } from "../../shared/http";

export type SpawnMode = "same-dir" | "worktree";
export type InstanceSettings = { createSession: boolean; spawnMode: SpawnMode };
export type SettingsPatch = Partial<InstanceSettings>;
// The values a node uses when a start names none. The node holds the same values.
export const DEFAULT_SETTINGS: InstanceSettings = { createSession: true, spawnMode: "same-dir" };

// The labels and explanations of the settings, as the node sends them. The page shows only this text: it has no copy of its own.
// The text comes from the node, so the page renders it as text, never as HTML.
export type SettingsHelp = {
  settings: {
    key: "createSession" | "spawnMode";
    label: string;
    values: { value: boolean | string; label: string; explanation: string }[];
    limits?: string;
  }[];
};

// An old node has no settings: the field is missing.
export type Instance = { id: string; path: string; name: string; state: string; startedAt: string | null; user?: string; settings?: InstanceSettings };

export type StartOpts = { user?: string; addTrust?: boolean; createSession?: boolean; spawnMode?: SpawnMode };

export const listInstances = (host: string) => request<Instance[]>("GET", `${hostUrl(host)}/instances`);
export const startInstance = (host: string, path: string, name?: string, opts?: StartOpts) =>
  request<Instance>("POST", `${hostUrl(host)}/instances`, {
    path,
    ...(name ? { name } : {}),
    ...(opts?.user ? { user: opts.user } : {}),
    ...(opts?.addTrust ? { addTrust: true } : {}),
    ...(opts?.createSession !== undefined ? { createSession: opts.createSession } : {}),
    ...(opts?.spawnMode !== undefined ? { spawnMode: opts.spawnMode } : {}),
  });
export const stopInstance = (host: string, id: string) => request<void>("DELETE", `${hostUrl(host)}/instances/${encodeURIComponent(id)}`);
export const pauseInstance = (host: string, id: string) => request<void>("POST", `${hostUrl(host)}/instances/${encodeURIComponent(id)}/pause`);
export const resumeInstance = (host: string, id: string) => request<void>("POST", `${hostUrl(host)}/instances/${encodeURIComponent(id)}/resume`);
export const getLogs = async (host: string, id: string, lines = 100) =>
  (await request<{ log: string }>("GET", `${hostUrl(host)}/instances/${encodeURIComponent(id)}/logs?lines=${lines}`)).log;

/** The settings help of the node. Null for an old node, which answers 404, or for an answer that is not a help object. */
export async function getInstanceSettingsHelp(host: string): Promise<SettingsHelp | null> {
  try {
    const h = await request<SettingsHelp>("GET", `${hostUrl(host)}/instance-settings`);
    return h && Array.isArray(h.settings) ? h : null;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}
/** Changes the settings and restarts the instance. A refused or undone change answers 409 with the reason and the old settings. */
export const updateInstanceSettings = (host: string, id: string, patch: SettingsPatch) =>
  request<{ instance: Instance; previous: InstanceSettings }>("PATCH", `${hostUrl(host)}/instances/${encodeURIComponent(id)}`, patch);
/** Restarts one instance with its current settings. */
export const restartInstance = (host: string, id: string) => request<void>("POST", `${hostUrl(host)}/instances/${encodeURIComponent(id)}/restart`);

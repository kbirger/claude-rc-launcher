import { hostUrl, request } from "../../shared/http";

export type Instance = { id: string; path: string; name: string; state: string; startedAt: string | null; user?: string };

export const listInstances = (host: string) => request<Instance[]>("GET", `${hostUrl(host)}/instances`);
export const startInstance = (host: string, path: string, name?: string, opts?: { user?: string; addTrust?: boolean }) =>
  request<Instance>("POST", `${hostUrl(host)}/instances`, {
    path,
    ...(name ? { name } : {}),
    ...(opts?.user ? { user: opts.user } : {}),
    ...(opts?.addTrust ? { addTrust: true } : {}),
  });
export const stopInstance = (host: string, id: string) => request<void>("DELETE", `${hostUrl(host)}/instances/${encodeURIComponent(id)}`);
export const pauseInstance = (host: string, id: string) => request<void>("POST", `${hostUrl(host)}/instances/${encodeURIComponent(id)}/pause`);
export const resumeInstance = (host: string, id: string) => request<void>("POST", `${hostUrl(host)}/instances/${encodeURIComponent(id)}/resume`);
export const getLogs = async (host: string, id: string, lines = 100) =>
  (await request<{ log: string }>("GET", `${hostUrl(host)}/instances/${encodeURIComponent(id)}/logs?lines=${lines}`)).log;

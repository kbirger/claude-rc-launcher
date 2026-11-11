import type { QueryClient } from "@tanstack/svelte-query";
import { stopInstance } from "./api";

export type StartArgs = { path: string; name?: string; user?: string; addTrust?: boolean };

export const stopInstanceMutation = (host: string, client: QueryClient) => ({
  mutationKey: ["instances", host, "stop"] as const,
  mutationFn: (id: string) => stopInstance(host, id),
  onSettled: () => client.invalidateQueries({ queryKey: ["instances", host] }),
});

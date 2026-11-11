import type { QueryClient } from "@tanstack/svelte-query";
import { updateHost } from "./api";
import { UPDATES_KEY } from "./queries";

// The hosts key is a literal: importing HOSTS_KEY from ../hosts would make a runtime import cycle (hosts imports updates).
const HOSTS_KEY = ["hosts"] as const;

export const updateHostMutation = (client: QueryClient) => ({
  mutationKey: ["update-host"] as const,
  mutationFn: ({ host, release }: { host: string; release?: string }) => updateHost(host, release),
  // After the call, however it ended, the host list and the update record are stale.
  onSettled: () =>
    Promise.all([client.invalidateQueries({ queryKey: HOSTS_KEY }), client.invalidateQueries({ queryKey: UPDATES_KEY })]),
});

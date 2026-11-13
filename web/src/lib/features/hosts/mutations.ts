import type { QueryClient } from "@tanstack/svelte-query";
import { renameHost } from "./api";
import { HOSTS_KEY } from "./queries";

export const renameHostMutation = (client: QueryClient) => ({
  mutationKey: ["rename-host"] as const,
  mutationFn: ({ id, name }: { id: string; name: string }) => renameHost(id, name),
  onSettled: () => client.invalidateQueries({ queryKey: HOSTS_KEY }),
});

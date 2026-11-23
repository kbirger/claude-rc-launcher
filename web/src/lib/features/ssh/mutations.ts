import type { QueryClient } from "@tanstack/svelte-query";
import { deleteTarget, patchTarget, putNode, setup, type UnlockMethod } from "./api";
import { SSH_KEY } from "./queries";

// The recovery code is in the answer of the setup call, and only there. `gcTime: 0` drops the mutation from the cache
// as soon as nothing watches it. The caller reads the code from the return value of `mutateAsync`, resets the
// mutation at once and never reads `mutation.data`. Nothing here refetches the status: the form does that after the
// owner has typed back a part of the code, because a page that shows the status would otherwise drop the form.
export const setupMutation = () => ({
  mutationKey: [...SSH_KEY, "setup"] as const,
  mutationFn: (body: { method: UnlockMethod; credentialId?: string }) => setup(body),
  gcTime: 0,
});

// The node and target changes refetch what the page shows: the status for a node, the targets for a target.
export const putNodeMutation = (client: QueryClient) => ({
  mutationKey: [...SSH_KEY, "put-node"] as const,
  mutationFn: ({ host, enabled, sourceAddress }: { host: string; enabled: boolean; sourceAddress: string }) =>
    putNode(host, { enabled, sourceAddress }),
  onSettled: () => client.invalidateQueries({ queryKey: [...SSH_KEY, "status"] }),
});

export const patchTargetMutation = (client: QueryClient) => ({
  mutationKey: [...SSH_KEY, "patch-target"] as const,
  mutationFn: ({ id, state }: { id: string; state: "disabled" | "draft" }) => patchTarget(id, state),
  onSettled: () => client.invalidateQueries({ queryKey: [...SSH_KEY, "targets"] }),
});

export const deleteTargetMutation = (client: QueryClient) => ({
  mutationKey: [...SSH_KEY, "delete-target"] as const,
  mutationFn: (id: string) => deleteTarget(id),
  onSettled: () => client.invalidateQueries({ queryKey: [...SSH_KEY, "targets"] }),
});

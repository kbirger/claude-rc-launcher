import type { QueryClient } from "@tanstack/svelte-query";
import {
  approveGrant,
  authorizeManaged,
  createKey,
  createTarget,
  deleteTarget,
  denyGrant,
  patchTarget,
  pinHostKey,
  pinManaged,
  putNode,
  revokeGrant,
  scanHostKey,
  setup,
  testTarget,
  type NewTarget,
  type Unlock,
  type UnlockMethod,
} from "./api";
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

// The wizard calls. The two that carry an unlock (`key` and `test`) keep no data: `gcTime: 0` drops the mutation as
// soon as nothing watches it, and the caller resets it in a `finally`, so that the secret in the variables lives only
// for the call. Each call refetches the targets, because the list shows the state of the target.
const refreshTargets = (client: QueryClient) => client.invalidateQueries({ queryKey: [...SSH_KEY, "targets"] });

export const createTargetMutation = (client: QueryClient) => ({
  mutationKey: [...SSH_KEY, "create-target"] as const,
  mutationFn: (body: NewTarget) => createTarget(body),
  onSettled: () => refreshTargets(client),
});

export const createKeyMutation = (client: QueryClient) => ({
  mutationKey: [...SSH_KEY, "create-key"] as const,
  mutationFn: ({ id, unlock }: { id: string; unlock: Unlock }) => createKey(id, unlock),
  gcTime: 0,
  onSettled: () => refreshTargets(client),
});

export const testTargetMutation = (client: QueryClient) => ({
  mutationKey: [...SSH_KEY, "test-target"] as const,
  mutationFn: ({ id, node, unlock }: { id: string; node: string; unlock: Unlock }) => testTarget(id, node, unlock),
  gcTime: 0,
  onSettled: () => refreshTargets(client),
});

export const scanHostKeyMutation = () => ({
  mutationKey: [...SSH_KEY, "scan-host-key"] as const,
  mutationFn: ({ id, node }: { id: string; node: string }) => scanHostKey(id, node),
});

export const pinHostKeyMutation = (client: QueryClient) => ({
  mutationKey: [...SSH_KEY, "pin-host-key"] as const,
  mutationFn: ({ id, hostKey }: { id: string; hostKey: string }) => pinHostKey(id, hostKey),
  onSettled: () => refreshTargets(client),
});

export const pinManagedMutation = (client: QueryClient) => ({
  mutationKey: [...SSH_KEY, "pin-managed"] as const,
  mutationFn: (id: string) => pinManaged(id),
  onSettled: () => refreshTargets(client),
});

export const authorizeManagedMutation = () => ({
  mutationKey: [...SSH_KEY, "authorize-managed"] as const,
  mutationFn: (id: string) => authorizeManaged(id),
});

// The grant calls. Each one refetches the grants, because the list shows the state of the grant. The approval carries an
// unlock, so it keeps no data: `gcTime: 0` drops the mutation as soon as nothing watches it, and the caller resets it in
// a `finally`, so that the secret in the variables lives only for the call.
const refreshGrants = (client: QueryClient) => client.invalidateQueries({ queryKey: [...SSH_KEY, "grants"] });

export const approveGrantMutation = (client: QueryClient) => ({
  mutationKey: [...SSH_KEY, "approve-grant"] as const,
  mutationFn: ({ id, unlock, minutes }: { id: string; unlock: Unlock; minutes?: number }) =>
    approveGrant(id, unlock, minutes),
  gcTime: 0,
  onSettled: () => refreshGrants(client),
});

export const denyGrantMutation = (client: QueryClient) => ({
  mutationKey: [...SSH_KEY, "deny-grant"] as const,
  mutationFn: (id: string) => denyGrant(id),
  onSettled: () => refreshGrants(client),
});

export const revokeGrantMutation = (client: QueryClient) => ({
  mutationKey: [...SSH_KEY, "revoke-grant"] as const,
  mutationFn: (id: string) => revokeGrant(id),
  onSettled: () => refreshGrants(client),
});

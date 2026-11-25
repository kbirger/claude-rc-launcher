<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import CheckPasskey from "./CheckPasskey.svelte";
  import { createQuery } from "@tanstack/svelte-query";
  import type { Grant } from "./api";
  import ApproveSheet from "./ApproveSheet.svelte";
  import GrantList from "./GrantList.svelte";
  import { statusQuery } from "./queries";
  import NodeAccess from "./NodeAccess.svelte";
  import NotifySwitch from "../push/NotifySwitch.svelte";
  import RecoveryFlow from "./RecoveryFlow.svelte";
  import SetupForm from "./SetupForm.svelte";
  import TargetList from "./TargetList.svelte";
  import TargetWizard from "./TargetWizard.svelte";

  // `target` is the id of the `?target=` link of a draft target: the wizard opens on it. `onclose` lets the route drop
  // the parameter, so that the same link opens the wizard again.
  let {
    target = null,
    onclose,
    canAdmin = false,
  }: { target?: string | null; onclose?: () => void; canAdmin?: boolean } = $props();

  const query = createQuery(() => statusQuery());
  // True while the setup form holds the recovery code. It wins over every other branch (a failed or a set-up status
  // included): the hub shows the code once, so the form must stay mounted until Finish. One branch holds the form, so
  // it is the same instance before and after `holding` turns on.
  let holding = $state(false);
  // The wizard is outside the branches below, so that a failed refetch of the status cannot unmount it. The status it
  // gets is the last one that loaded.
  let wizard = $state<{ id?: string } | null>(null);
  $effect(() => {
    if (target) wizard = { id: target };
  });
  const closeWizard = () => {
    wizard = null;
    onclose?.();
  };
  // The approval sheet is outside the branches too, for the same reason. It holds the grant as it was when the owner
  // opened it.
  let approving = $state<Grant | null>(null);
  // The recovery flow is outside the branches too: it holds the recovery code, so a failed refetch must not drop it.
  let recovering = $state(false);
  const pending = $derived(query.data?.pendingRewrap ?? []);
  const nodeCount = $derived(query.data?.nodes.length ?? 0);
</script>

<h2 class="font-heading mb-3 text-lg font-bold">SSH access</h2>
{#if canAdmin}
  <div class="mb-3">
    <NotifySwitch />
  </div>
{/if}
<!-- The passkey check is outside the branches below, so that a failed refetch of the status cannot drop its result. -->
{#if canAdmin && !holding && query.data?.setUp && query.data.method === "prf" && query.data.credentialId}
  <CheckPasskey credentialId={query.data.credentialId} busy={recovering || !!wizard || !!approving} />
{/if}
{#if holding || (query.data && !query.data.setUp)}
  <SetupForm bind:holding />
{:else if query.isPending}
  <p class="text-muted-foreground">Loading SSH access...</p>
{:else if query.error}
  <Alert.Root variant="destructive">
    <Alert.Description>Could not load SSH access: {query.error.message}</Alert.Description>
  </Alert.Root>
{:else if query.data}
  <p class="text-sm text-muted-foreground">
    Unlock method: {query.data.method === "prf" ? "passkey" : "passphrase"}. {nodeCount}
    {nodeCount === 1 ? "node" : "nodes"}.
  </p>
  <div class="mt-2">
    <Button variant="outline" size="touch" onclick={() => (recovering = true)}>
      {query.data.method === "passphrase" ? "Forgot your passphrase? Recover" : "Lost your passkey? Recover"}
    </Button>
  </div>
  {#if pending.length > 0}
    <Alert.Root class="mt-3" role="status">
      <Alert.Description class="flex flex-wrap items-center justify-between gap-3">
        <span>
          {pending.length}
          {pending.length === 1 ? "target needs its key recovered." : "targets need their keys recovered."}
        </span>
        <Button size="touch" onclick={() => (recovering = true)}>Recover keys</Button>
      </Alert.Description>
    </Alert.Root>
  {/if}
  <div class="mt-4 grid gap-6">
    <GrantList onapprove={(grant) => (approving = grant)} />
    <NodeAccess nodes={query.data.nodes} />
    <TargetList />
    <div>
      <Button size="touch" onclick={() => (wizard = {})}>Add target</Button>
    </div>
  </div>
{/if}
{#if wizard && query.data?.setUp && !holding}
  {#key wizard.id ?? ""}
    <TargetWizard targetId={wizard.id} status={query.data} onclose={closeWizard} />
  {/key}
{/if}
{#if recovering && query.data?.setUp && !holding}
  <RecoveryFlow status={query.data} onclose={() => (recovering = false)} />
{/if}
{#if approving && query.data?.setUp && !holding}
  {#key approving.id}
    <ApproveSheet grant={approving} status={query.data} onclose={() => (approving = null)} />
  {/key}
{/if}

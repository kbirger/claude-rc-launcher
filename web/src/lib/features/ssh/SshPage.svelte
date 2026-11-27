<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import CheckPasskey from "./CheckPasskey.svelte";
  import { useQueryClient } from "@tanstack/svelte-query";
  import ApproveSheet from "./ApproveSheet.svelte";
  import GrantList from "./GrantList.svelte";
  import NodeAccess from "./NodeAccess.svelte";
  import { createSshPageModel } from "./page.svelte";
  import ProvisionerKey from "./ProvisionerKey.svelte";
  import NotifySwitch from "../push/NotifySwitch.svelte";
  import RecoveryFlow from "./RecoveryFlow.svelte";
  import SetupForm from "./SetupForm.svelte";
  import TargetList from "./TargetList.svelte";
  import TargetWizard from "./TargetWizard.svelte";

  // The SSH page. The page model chooses the open sheet from the link (`target`, `provisioner`) and the buttons.
  let {
    target = null,
    provisioner = false,
    onclose,
    canAdmin = false,
  }: { target?: string | null; provisioner?: boolean; onclose?: () => void; canAdmin?: boolean } = $props();

  const model = createSshPageModel({
    client: useQueryClient(),
    target: () => target,
    provisioner: () => provisioner,
    onclose: () => onclose?.(),
  });
  const query = model.status;
  const sheet = $derived(model.sheet);
</script>

<h2 class="font-heading mb-3 text-lg font-bold">SSH access</h2>
{#if canAdmin}
  <div class="mb-3">
    <NotifySwitch />
  </div>
{/if}
<!-- The passkey check is outside the branches below, so that a failed refetch of the status cannot drop its result. -->
{#if canAdmin && !model.holding && query.data?.setUp && query.data.method === "prf" && query.data.credentialId}
  <CheckPasskey credentialId={query.data.credentialId} busy={model.busy} />
{/if}
{#if model.holding || (query.data && !query.data.setUp)}
  <SetupForm bind:holding={model.holding} />
{:else if query.isPending}
  <p class="text-muted-foreground">Loading SSH access...</p>
{:else if query.error}
  <Alert.Root variant="destructive">
    <Alert.Description>Could not load SSH access: {query.error.message}</Alert.Description>
  </Alert.Root>
{:else if query.data}
  <p class="text-sm text-muted-foreground">
    Unlock method: {query.data.method === "prf" ? "passkey" : "passphrase"}. {model.nodeCount}
    {model.nodeCount === 1 ? "node" : "nodes"}.
  </p>
  <div class="mt-2">
    <Button variant="outline" size="touch" onclick={model.recover}>
      {query.data.method === "passphrase" ? "Forgot your passphrase? Recover" : "Lost your passkey? Recover"}
    </Button>
  </div>
  {#if model.pending.length > 0}
    <Alert.Root class="mt-3" role="status">
      <Alert.Description class="flex flex-wrap items-center justify-between gap-3">
        <span>
          {model.pending.length}
          {model.pending.length === 1 ? "target needs its key recovered." : "targets need their keys recovered."}
        </span>
        <Button size="touch" onclick={model.recover}>Recover keys</Button>
      </Alert.Description>
    </Alert.Root>
  {/if}
  <div class="mt-4 grid gap-6">
    <GrantList onapprove={model.approve} />
    <NodeAccess nodes={query.data.nodes} />
    <TargetList onapprove={model.approve} />
    <div>
      <Button size="touch" onclick={model.addTarget}>Add target</Button>
    </div>
  </div>
{/if}
<!-- Each sheet reads its props once, so #key mounts a fresh one for each id. -->
{#if sheet?.kind === "wizard" && query.data?.setUp && !model.holding}
  {#key sheet.id ?? ""}
    <TargetWizard targetId={sheet.id} status={query.data} onclose={model.closeSheet} />
  {/key}
{/if}
{#if sheet?.kind === "provisioner" && query.data?.setUp && !model.holding}
  {#key sheet.id}
    <ProvisionerKey targetId={sheet.id} status={query.data} onclose={model.closeSheet} />
  {/key}
{/if}
{#if model.recovering && query.data?.setUp && !model.holding}
  <RecoveryFlow status={query.data} onclose={model.closeRecovery} />
{/if}
{#if sheet?.kind === "approve" && query.data?.setUp && !model.holding}
  {#key sheet.grant.id}
    <ApproveSheet grant={sheet.grant} status={query.data} onclose={model.closeSheet} />
  {/key}
{/if}

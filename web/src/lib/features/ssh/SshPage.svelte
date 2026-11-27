<script lang="ts">
  import * as Accordion from "#lib/components/ui/accordion/index.js";
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { Badge } from "#lib/components/ui/badge/index.js";
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

  // The SSH page. The page model chooses the open sheet from the link (`target`, `provisioner`) and the buttons, and
  // which accordion sections are open.
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
  // A set-up hub shows its content in accordion sections. The setup form keeps its own page.
  const grouped = $derived(!model.holding && query.data?.setUp === true);
</script>

<h2 class="font-heading mb-3 text-lg font-bold">SSH access</h2>
<!-- On a set-up hub, the notify switch is in Settings. Elsewhere (setup, loading, error) it stays on top, as before. -->
{#if canAdmin && !grouped}
  <div class="mb-3">
    <NotifySwitch />
  </div>
{/if}
{#if model.holding || (query.data && !query.data.setUp)}
  <SetupForm bind:holding={model.holding} />
{:else if query.isPending}
  <p class="text-muted-foreground">Loading SSH access...</p>
{:else}
  {#if query.error}
    <Alert.Root variant="destructive">
      <Alert.Description>Could not load SSH access: {query.error.message}</Alert.Description>
    </Alert.Root>
  {/if}
  {#if grouped && query.data}
    {#if !query.error}
      <p class="text-sm text-muted-foreground">
        Unlock method: {query.data.method === "prf" ? "passkey" : "passphrase"}. {model.nodeCount}
        {model.nodeCount === 1 ? "node" : "nodes"}.
      </p>
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
    {/if}
    <!-- The accordion is outside the status branches, so that a failed refetch keeps the passkey check result. -->
    <Accordion.Root
      type="multiple"
      class="mt-2"
      bind:value={() => model.sections.open, (value) => model.sections.setOpen(value)}
    >
      <Accordion.Item value="requests">
        <Accordion.Trigger>
          <span class="flex min-w-0 flex-wrap items-center gap-2">
            Access requests
            {#if model.pendingRequests > 0}
              <Badge>{model.pendingRequests} pending</Badge>
            {/if}
          </span>
        </Accordion.Trigger>
        <Accordion.Content>
          <GrantList onapprove={model.approve} />
        </Accordion.Content>
      </Accordion.Item>
      <Accordion.Item value="targets">
        <Accordion.Trigger>Targets</Accordion.Trigger>
        <Accordion.Content class="grid gap-3">
          <p class="text-muted-foreground">
            A target is a machine that you connect to. The hub holds one key for each target.
          </p>
          <TargetList onapprove={model.approve} />
          <div>
            <Button size="touch" onclick={model.addTarget}>Add target</Button>
          </div>
        </Accordion.Content>
      </Accordion.Item>
      <Accordion.Item value="nodes">
        <Accordion.Trigger>Nodes</Accordion.Trigger>
        <Accordion.Content class="grid gap-3">
          <p class="text-muted-foreground">
            A node is a machine that runs the launcher. Choose which nodes can ask for SSH access, and the address that
            targets see for each.
          </p>
          <NodeAccess nodes={query.data.nodes} />
        </Accordion.Content>
      </Accordion.Item>
      <Accordion.Item value="settings">
        <Accordion.Trigger>Settings</Accordion.Trigger>
        <Accordion.Content class="grid gap-3">
          {#if canAdmin}
            <NotifySwitch />
          {/if}
          {#if canAdmin && query.data.method === "prf" && query.data.credentialId}
            <CheckPasskey credentialId={query.data.credentialId} busy={model.busy} />
          {/if}
          {#if !query.error}
            <div>
              <Button variant="outline" size="touch" onclick={model.recover}>
                {query.data.method === "passphrase" ? "Forgot your passphrase? Recover" : "Lost your passkey? Recover"}
              </Button>
            </div>
          {/if}
        </Accordion.Content>
      </Accordion.Item>
    </Accordion.Root>
  {/if}
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

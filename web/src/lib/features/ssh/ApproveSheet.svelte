<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import UsernameHint from "./UsernameHint.svelte";
  import { PASSPHRASE_NAME } from "./passphrase";
  import * as Sheet from "#lib/components/ui/sheet/index.js";
  import { untrack } from "svelte";
  import { useQueryClient } from "@tanstack/svelte-query";
  import type { Grant, Maintenance, SshStatus } from "./api";
  import { createApproveModel, listText as list, maintenanceHeadline as headline } from "./approve.svelte";

  // The owner reads one request and approves it. The approve model holds the state. Mount it fresh for each grant: it
  // reads `grant` once. The node cannot prove which instance asked, so the instance is only "claimed by the session".
  let {
    grant,
    status,
    onclose,
  }: {
    grant: Grant;
    /** The last status that loaded. A failed refetch keeps it. */
    status: SshStatus;
    onclose: () => void;
  } = $props();

  const model = createApproveModel({
    client: useQueryClient(),
    grant: untrack(() => grant),
    status: () => status,
    onclose: () => onclose(),
  });
  const uid = $props.id();
  const wrap = "min-w-0 [overflow-wrap:anywhere]";
  const WARNING = "This gives the full power of the account on the target. The target cannot limit it to read-only.";
  const MAINTENANCE_WARNING =
    "It uses the provisioner key, not the key of a session. The change runs as soon as you approve.";
  const ACTIONS: Record<Maintenance["action"], string> = {
    sources: "Change the nodes",
    uninstall: "Retire: remove the key lines",
    install: "Put the key line back",
  };
  const ROUTER_NO_LIMIT = "The router does not limit this key by address. Your approval is the control.";
  const ROUTER_SAME_LINE = "The key line on the router stays the same. Only the list of the router script changes.";
  const work = model.work;
  const target = $derived(model.target);
  const router = $derived(model.router);
</script>

<Sheet.Root
  open={true}
  onOpenChange={(value) => {
    if (!value && !model.busy) onclose();
  }}
>
  <Sheet.Content
    side="bottom"
    class="mx-auto max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-2xl border-x pb-[calc(1rem+env(safe-area-inset-bottom))]"
  >
    <Sheet.Header>
      <Sheet.Title>{work ? "Approve SSH maintenance" : "Approve SSH access"}</Sheet.Title>
      <Sheet.Description class="sr-only">Check the request, unlock, and approve it.</Sheet.Description>
    </Sheet.Header>
    <div class="grid min-w-0 gap-3 px-4">
      <dl class="grid min-w-0 gap-1.5 text-sm">
        {#if work}
          <div class="flex min-w-0 justify-between gap-3">
            <dt class="text-muted-foreground">Action</dt>
            <dd class="{wrap} font-semibold">{ACTIONS[work.action]}</dd>
          </div>
        {:else}
          <div class="flex min-w-0 justify-between gap-3">
            <dt class="text-muted-foreground">Node</dt>
            <dd class={wrap}>{model.hostName(grant.nodeId)}</dd>
          </div>
          <div class="flex min-w-0 justify-between gap-3">
            <dt class="text-muted-foreground">Instance</dt>
            <dd class={wrap}>{grant.instanceId} (claimed by the session)</dd>
          </div>
        {/if}
        <div class="flex min-w-0 justify-between gap-3">
          <dt class="text-muted-foreground">Target</dt>
          <dd class={wrap}>
            {grant.targetId}{#if target}
              <span class="block font-mono text-xs">{target.account}@{target.address}:{target.port}</span>
            {/if}
          </dd>
        </div>
        {#if !work}
          <div class="flex min-w-0 justify-between gap-3">
            <dt class="text-muted-foreground">Requested</dt>
            <dd>{grant.minutes} minutes</dd>
          </div>
        {/if}
        {#if grant.reason}
          <div class="flex min-w-0 justify-between gap-3">
            <dt class="text-muted-foreground">Reason</dt>
            <dd class={wrap}>{grant.reason}</dd>
          </div>
        {/if}
      </dl>
      {#if work}
        <Alert.Root role="note" variant="destructive">
          <Alert.Description class="{wrap} grid gap-1">
            <span class="font-semibold">{headline(work, grant.targetId, router)}</span>
            {#if router}
              {#if work.action === "sources"}
                <span data-router-text>{ROUTER_SAME_LINE}</span>
                <span class="text-xs">
                  Nodes now: {model.nodeNames(work.fromNodes)}. Nodes after: {model.nodeNames(work.toNodes ?? [])}.
                </span>
              {:else}
                <span class="text-xs">Nodes: {model.nodeNames(work.fromNodes)}</span>
              {/if}
              <span data-router-text>{ROUTER_NO_LIMIT}</span>
            {:else if work.action === "sources"}
              {#if model.sameAddresses}
                <span>The list of addresses does not change: {list(work.fromSources)}</span>
              {:else}
                <span>SSH will be allowed only from: {list(work.toSources ?? [])}</span>
                <span>from: {list(work.fromSources)}</span>
              {/if}
              <span class="text-xs">
                Nodes now: {model.nodeNames(work.fromNodes)}. Nodes after: {model.nodeNames(work.toNodes ?? [])}.
              </span>
            {:else if work.action === "install"}
              <span>SSH will be allowed only from: {list(work.fromSources)}</span>
              <span class="text-xs">Nodes: {model.nodeNames(work.fromNodes)}</span>
            {:else}
              <span>The addresses now allowed: {list(work.fromSources)}</span>
              <span class="text-xs">Nodes: {model.nodeNames(work.fromNodes)}</span>
            {/if}
            <span>{MAINTENANCE_WARNING}</span>
          </Alert.Description>
        </Alert.Root>
      {:else}
        <Alert.Root role="note" variant="destructive">
          <Alert.Description class={wrap}>{WARNING}</Alert.Description>
        </Alert.Root>
      {/if}
      {#if !work}
        <div class="grid gap-1">
          <Label for="{uid}-minutes">Minutes (1 to 480)</Label>
          <Input
            id="{uid}-minutes"
            type="number"
            inputmode="numeric"
            min="1"
            max="480"
            step="1"
            class="h-11"
            disabled={model.busy}
            bind:value={model.minutes}
          />
        </div>
      {/if}
      {#if model.finished}
        <!-- The run is over: nothing to unlock. -->
      {:else if status.method === "prf"}
        <p class="text-sm text-muted-foreground">The passkey asks you to confirm.</p>
      {:else}
        <div class="grid gap-1">
          <Label for="{uid}-pass">Passphrase</Label>
          <UsernameHint />
          <Input
            id="{uid}-pass"
            name={PASSPHRASE_NAME}
            type="password"
            class="h-11"
            autocomplete="current-password"
            autocapitalize="off"
            spellcheck={false}
            disabled={model.busy}
            bind:value={model.passphrase}
          />
        </div>
      {/if}
      {#if model.notice}
        <Alert.Root role="status">
          <Alert.Description class={wrap}>{model.notice}</Alert.Description>
        </Alert.Root>
      {/if}
      {#if model.problem}
        <Alert.Root variant="destructive" role="alert">
          <Alert.Description class={wrap}>{model.problem}</Alert.Description>
        </Alert.Root>
      {/if}
    </div>
    <Sheet.Footer class="px-4">
      {#if !model.finished}
        <Button type="button" size="touch" disabled={model.busy} onclick={model.submit}>
          {model.busy ? "Approving..." : "Approve"}
        </Button>
      {/if}
      <Button type="button" variant="outline" size="touch" disabled={model.busy} onclick={onclose}>
        {model.finished ? "Close" : "Cancel"}
      </Button>
    </Sheet.Footer>
  </Sheet.Content>
</Sheet.Root>

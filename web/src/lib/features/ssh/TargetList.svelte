<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { Badge, type BadgeVariant } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { resolve } from "$app/paths";
  import { useQueryClient } from "@tanstack/svelte-query";
  import ConfirmDialog from "../../shared/ui/ConfirmDialog.svelte";
  import type { Grant, Target, TargetState } from "./api";
  import { hostLabel } from "./hostlabel";
  import { createTargetListModel, hasProvisioner, MAINTENANCE_ACTIONS as ACTIONS, stuckText } from "./targets.svelte";
  import TargetNodesEdit from "./TargetNodesEdit.svelte";

  // The targets of SSH delegation with their state and the actions for it. The target list model holds the rules. An
  // admin can change the nodes of a target. A retire deletes the target. A one-time notice tells what happened to the
  // key line on the machine. A target with a provisioner shows the request that waits for the approval.
  let { onapprove }: { onapprove?: (grant: Grant) => void } = $props();

  const model = createTargetListModel({ client: useQueryClient() });
  const targets = model.targets;
  const VARIANT: Record<TargetState, BadgeVariant> = {
    draft: "outline",
    ready: "default",
    disabled: "secondary",
  };
</script>

{#snippet retireWays(target: Target, again = true)}
  <div class="flex flex-wrap gap-2">
    {#if again}
      <Button size="touch" onclick={() => model.askRetire(target)}>Retire again</Button>
    {/if}
    <Button
      variant="outline"
      size="touch"
      class="text-destructive"
      onclick={() => model.askRetireWithoutCleanup(target)}
    >
      Retire without cleanup
    </Button>
  </div>
{/snippet}

<section class="grid gap-3">
  <h3 class="font-heading text-base font-bold">Targets</h3>
  {#if model.problem}
    <Alert.Root variant="destructive" role="alert"><Alert.Description>{model.problem}</Alert.Description></Alert.Root>
  {/if}
  {#if model.notice}
    <Alert.Root role="status" class="flex items-start justify-between gap-2">
      <Alert.Description class="min-w-0 [overflow-wrap:anywhere]">{model.notice}</Alert.Description>
      <Button variant="outline" size="sm" onclick={model.dismissNotice}>Dismiss</Button>
    </Alert.Root>
  {/if}
  {#if targets.isPending}
    <p class="text-sm text-muted-foreground">Loading targets...</p>
  {:else if targets.error}
    <Alert.Root variant="destructive">
      <Alert.Description>Could not load targets: {targets.error.message}</Alert.Description>
    </Alert.Root>
  {:else if targets.data}
    {#if targets.data.length === 0}
      <p class="text-sm text-muted-foreground">No targets yet.</p>
    {/if}
    <ul class="grid min-w-0 gap-2">
      {#each targets.data as target (target.id)}
        <li data-target class="grid min-w-0 gap-2 rounded-lg border bg-card p-3">
          <div class="flex min-w-0 items-center justify-between gap-2">
            <span class="min-w-0 font-medium [overflow-wrap:anywhere]">{target.id}</span>
            <span class="flex shrink-0 items-center gap-1">
              {#if hasProvisioner(target)}<Badge variant="outline">provisioner</Badge>{/if}
              <Badge variant={VARIANT[target.state]}>{target.state}</Badge>
            </span>
          </div>
          <div class="grid min-w-0 gap-0.5 text-sm text-muted-foreground">
            <span class="font-mono [overflow-wrap:anywhere]">{target.address}:{target.port}</span>
            <span>{target.account} · {target.systemType}</span>
            <span class="[overflow-wrap:anywhere]">
              Nodes: {target.nodes.length > 0
                ? target.nodes.map((node) => hostLabel(node, model.hosts)).join(", ")
                : "none"}
            </span>
          </div>
          {#if model.pendingOf(target)}
            {@const waiting = model.pendingOf(target)!}
            <div data-pending class="grid gap-2 rounded-lg border border-primary/40 bg-muted p-3 text-sm">
              <span class="font-medium">
                Waiting for your approval: {ACTIONS[waiting.maintenance!.action]}.
              </span>
              <span class="text-muted-foreground">Nothing has changed yet.</span>
              {#if onapprove}
                <div><Button size="touch" onclick={() => onapprove(waiting)}>Approve</Button></div>
              {/if}
            </div>
          {/if}
          {#if model.stuckRetireOf(target)}
            <div data-stuck-retire class="grid gap-2 rounded-lg border border-destructive/40 p-3 text-sm">
              <span class="[overflow-wrap:anywhere]">{stuckText(model.stuckRetireOf(target)!)}</span>
              {@render retireWays(target)}
            </div>
          {/if}
          {#if model.refusedOf(target)}
            <div data-retire-refused class="grid gap-2 rounded-lg border border-destructive/40 p-3 text-sm">
              <span class="[overflow-wrap:anywhere]">The hub did not start the retire: {model.refusedOf(target)}</span>
              <span class="text-muted-foreground">Nothing was removed. You can retire without cleanup.</span>
              {@render retireWays(target, false)}
            </div>
          {/if}
          {#if model.staleSource(target)}
            <Alert.Root variant="destructive" role="alert" data-stale-source>
              <Alert.Description class="grid gap-1 [overflow-wrap:anywhere]">
                {#if model.localOff}
                  <span>
                    Access is turned off for the node local. The hub reaches this target through it, so it cannot change
                    this target now. Turn on access for local, with its source address, in the list of nodes above.
                  </span>
                {:else}
                  <span>
                    The source address of the node local changed after the provisioner was installed. The hub cannot
                    change this target until you install the provisioner again. On your own machine, run:
                  </span>
                  <code class="block rounded border bg-muted p-2 font-mono text-xs select-all">
                    claude-rc ssh target provisioner {target.id} --identity &lt;file&gt;
                  </code>
                {/if}
                {#if !model.stuckRetireOf(target) && !model.refusedOf(target) && !model.pendingOf(target)}
                  <span>If you want to give up on this target, you can retire it without cleanup.</span>
                  {@render retireWays(target, false)}
                {/if}
              </Alert.Description>
            </Alert.Root>
          {/if}
          <div class="flex flex-wrap gap-2">
            {#if target.state === "draft"}
              <Button variant="outline" size="touch" href={resolve(`/ssh?target=${encodeURIComponent(target.id)}`)}>
                Continue setup
              </Button>
            {:else if target.state === "ready"}
              <Button variant="outline" size="touch" onclick={() => model.setState(target, "disabled")}>Disable</Button>
            {:else if target.state === "disabled"}
              <Button variant="outline" size="touch" onclick={() => model.setState(target, "draft")}>Enable</Button>
            {/if}
            {#if !model.pendingOf(target)}
              <Button variant="outline" size="touch" onclick={() => model.edit(target.id)}>Edit nodes</Button>
              {#if hasProvisioner(target) && target.state !== "draft"}
                <Button
                  variant="outline"
                  size="touch"
                  disabled={model.reinstalling}
                  onclick={() => model.reinstall(target)}
                >
                  Reinstall key line
                </Button>
              {/if}
              {#if !model.stuckRetireOf(target)}
                <Button variant="outline" size="touch" class="text-destructive" onclick={() => model.askRetire(target)}>
                  Retire
                </Button>
              {/if}
            {/if}
          </div>
          {#if model.editing === target.id}
            <TargetNodesEdit
              {target}
              nodes={model.nodes}
              hosts={model.hosts}
              {onapprove}
              ondone={() => model.edit(null)}
            />
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
<ConfirmDialog bind:ask={model.ask} />

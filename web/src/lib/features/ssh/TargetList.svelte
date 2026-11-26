<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { Badge, type BadgeVariant } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { resolve } from "$app/paths";
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { hostsQuery } from "../hosts";
  import ConfirmDialog, { type Ask } from "../../shared/ui/ConfirmDialog.svelte";
  import type { Target, TargetState } from "./api";
  import { retireNotice } from "./retirenotice";
  import { hostLabel } from "./hostlabel";
  import { deleteTargetMutation, patchTargetMutation } from "./mutations";
  import { statusQuery, targetsQuery } from "./queries";
  import TargetNodesEdit from "./TargetNodesEdit.svelte";

  // The targets of SSH delegation with their state and the actions for it. A key is never rotated here: to rotate,
  // the owner retires the target and adds it again. An admin can change the nodes of a target. A retire deletes the
  // target. A one-time notice tells what happened to the key line on the machine.
  const client = useQueryClient();
  const targets = createQuery(() => targetsQuery());
  const hosts = createQuery(() => hostsQuery());
  const status = createQuery(() => statusQuery());
  const patch = createMutation(() => patchTargetMutation(client));
  const retire = createMutation(() => deleteTargetMutation(client));

  const VARIANT: Record<TargetState, BadgeVariant> = {
    draft: "outline",
    ready: "default",
    disabled: "secondary",
  };
  let ask = $state<Ask | null>(null);
  let problem = $state("");
  let notice = $state("");
  // The id of the target whose nodes the owner edits now.
  let editing = $state<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    problem = "";
    notice = "";

    try {
      await action();
    } catch (error) {
      problem = error instanceof Error ? error.message : "The change failed.";
    }
  }

  const setState = (target: Target, state: "disabled" | "draft") =>
    run(() => patch.mutateAsync({ id: target.id, state }));

  const askRetire = (target: Target) =>
    (ask = {
      title: `Retire ${target.id}?`,
      body: "The hub ends the grants of this target and deletes the target and its key. For a managed target, the hub also tries to remove the key line from the machine. To use the target again, add it as a new target.",
      label: "Retire",
      destructive: true,
      run: () =>
        void run(async () => {
          notice = retireNotice(await retire.mutateAsync(target.id));
        }),
    });
</script>

<section class="grid gap-3">
  <h3 class="font-heading text-base font-bold">Targets</h3>
  {#if problem}
    <Alert.Root variant="destructive" role="alert"><Alert.Description>{problem}</Alert.Description></Alert.Root>
  {/if}
  {#if notice}
    <Alert.Root role="status" class="flex items-start justify-between gap-2">
      <Alert.Description class="min-w-0 [overflow-wrap:anywhere]">{notice}</Alert.Description>
      <Button variant="outline" size="sm" onclick={() => (notice = "")}>Dismiss</Button>
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
            <Badge variant={VARIANT[target.state]}>{target.state}</Badge>
          </div>
          <div class="grid min-w-0 gap-0.5 text-sm text-muted-foreground">
            <span class="font-mono [overflow-wrap:anywhere]">{target.address}:{target.port}</span>
            <span>{target.account} · {target.systemType}</span>
            <span class="[overflow-wrap:anywhere]">
              Nodes: {target.nodes.length > 0
                ? target.nodes.map((node) => hostLabel(node, hosts.data)).join(", ")
                : "none"}
            </span>
          </div>
          <div class="flex flex-wrap gap-2">
            {#if target.state === "draft"}
              <Button variant="outline" size="touch" href={resolve(`/ssh?target=${encodeURIComponent(target.id)}`)}>
                Continue setup
              </Button>
            {:else if target.state === "ready"}
              <Button variant="outline" size="touch" onclick={() => setState(target, "disabled")}>Disable</Button>
            {:else if target.state === "disabled"}
              <Button variant="outline" size="touch" onclick={() => setState(target, "draft")}>Enable</Button>
            {/if}
            <Button variant="outline" size="touch" onclick={() => (editing = target.id)}>Edit nodes</Button>
            <Button variant="outline" size="touch" class="text-destructive" onclick={() => askRetire(target)}>
              Retire
            </Button>
          </div>
          {#if editing === target.id}
            <TargetNodesEdit
              {target}
              nodes={status.data?.nodes ?? []}
              hosts={hosts.data}
              ondone={() => (editing = null)}
            />
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
<ConfirmDialog bind:ask />

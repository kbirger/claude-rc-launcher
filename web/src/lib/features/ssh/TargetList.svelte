<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { Badge, type BadgeVariant } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { resolve } from "$app/paths";
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { hostsQuery } from "../hosts";
  import ConfirmDialog, { type Ask } from "../../shared/ui/ConfirmDialog.svelte";
  import { isMaintenanceAnswer, type Grant, type MaintenanceAction, type Target, type TargetState } from "./api";
  import { isMaintenanceRefusal } from "./refusals";
  import { retireNotice } from "./retirenotice";
  import { hostLabel } from "./hostlabel";
  import { deleteTargetMutation, patchTargetMutation, reinstallTargetMutation } from "./mutations";
  import { grantsQuery, statusQuery, targetsQuery } from "./queries";
  import TargetNodesEdit from "./TargetNodesEdit.svelte";

  // The targets of SSH delegation with their state and the actions for it. A key is never rotated here: to rotate,
  // the owner retires the target and adds it again. An admin can change the nodes of a target. A retire deletes the
  // target. A one-time notice tells what happened to the key line on the machine.
  //
  // A target with a provisioner changes through a request that the owner approves: the save of the nodes, the retire and
  // the reinstall of the key line only ask, and the card shows the request that waits. A retire that was denied, that
  // expired or that ended before it ran leaves the target disabled with both keys: the card then offers a new retire and
  // a retire without cleanup.
  let { onapprove }: { onapprove?: (grant: Grant) => void } = $props();

  const client = useQueryClient();
  const targets = createQuery(() => targetsQuery());
  const hosts = createQuery(() => hostsQuery());
  const status = createQuery(() => statusQuery());
  const grants = createQuery(() => grantsQuery());
  const patch = createMutation(() => patchTargetMutation(client));
  const retire = createMutation(() => deleteTargetMutation(client));
  const reinstall = createMutation(() => reinstallTargetMutation(client));
  const ACTIONS: Record<MaintenanceAction, string> = {
    sources: "change the nodes",
    uninstall: "retire",
    install: "put the key line back",
  };
  const ENDED: Record<string, string> = {
    denied: "was denied",
    expired: "ran out of time",
    revoked: "was revoked",
  };

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

  const hasProvisioner = (target: Target) =>
    target.managedHost === undefined && target.provisionerFingerprint !== undefined;
  const maintenanceOf = (target: Target) =>
    (grants.data ?? []).filter((grant) => grant.targetId === target.id && grant.maintenance !== undefined);
  /** The request of this target that is open: it waits for the approval, or its run is in progress. */
  const pendingOf = (target: Target) =>
    maintenanceOf(target).find((grant) => grant.state === "pending" || grant.state === "active");
  /**
   * A retire that ended without a retire: the target stays disabled with both keys. Only the newest grant of the
   * target counts, of any kind: a later grant of any kind means that the owner has moved on.
   */
  const stuckRetire = (target: Target) => {
    if (!hasProvisioner(target) || target.state !== "disabled" || pendingOf(target)) return undefined;
    const newest = (grants.data ?? [])
      .filter((grant) => grant.targetId === target.id)
      .sort((left, right) => right.requestedAt - left.requestedAt)[0];
    return newest?.state === "ended" && newest.maintenance?.action === "uninstall" ? newest : undefined;
  };
  // The text of the hub when it refused the retire request, by target id. The owner can still retire without cleanup.
  let refused = $state<Record<string, string>>({});
  const stuckText = (grant: Grant) =>
    `The request to retire this target ${ENDED[grant.endReason ?? ""] ?? "ended"}. Nothing was removed from the machine. The target is disabled and keeps its keys.`;
  const localOff = () => status.data?.nodes.find((node) => node.host === "local")?.enabled === false;
  /** The provisioner line allows the source address of the node local as it was at the install. */
  const staleSource = (target: Target) => {
    const local = status.data?.nodes.find((node) => node.host === "local");
    return (
      hasProvisioner(target) &&
      local !== undefined &&
      (!local.enabled || local.sourceAddress !== target.provisionerSource)
    );
  };

  // A target with a provisioner answers with a request: nothing has changed yet.
  const waitingNotice = (target: Target, action: MaintenanceAction) =>
    `The request to ${ACTIONS[action]} for ${target.id} waits for your approval. Nothing has changed yet. Tap Approve on the card of ${target.id}, or find the request in the list of access requests.`;

  const handleRetire = (target: Target, answer: Awaited<ReturnType<typeof retire.mutateAsync>>) => {
    delete refused[target.id];
    notice = isMaintenanceAnswer(answer) ? waitingNotice(target, "uninstall") : retireNotice(answer);
  };

  const askRetire = (target: Target) =>
    (ask = {
      title: `Retire ${target.id}?`,
      body: hasProvisioner(target)
        ? "You approve the retire with your passkey or passphrase. Then the hub removes the key lines from the machine, ends the grants and deletes the target and its keys. Until you approve, the target is disabled and nothing is removed. To use the target again, add it as a new target."
        : "The hub ends the grants of this target and deletes the target and its key. For a managed target, the hub also tries to remove the key line from the machine. To use the target again, add it as a new target.",
      label: "Retire",
      destructive: true,
      run: () =>
        void run(async () => {
          try {
            handleRetire(target, await retire.mutateAsync({ id: target.id }));
          } catch (error) {
            // The hub refused to make the request because the maintenance path does not work: the owner needs a way out.
            // Every other error (a request that waits, a 403, a failure) is shown as it is.
            if (!hasProvisioner(target) || !isMaintenanceRefusal(error)) throw error;
            refused[target.id] = error instanceof Error ? error.message : "The hub refused the retire.";
          }
        }),
    });

  const askRetireWithoutCleanup = (target: Target) =>
    (ask = {
      title: `Retire ${target.id} without cleanup?`,
      body: `The hub deletes the target and both keys now. It does not remove anything from the machine. You must remove the lines that end with claude-rc:${target.id} and claude-rc-provisioner:${target.id} yourself.`,
      label: "Retire without cleanup",
      destructive: true,
      run: () =>
        void run(async () => handleRetire(target, await retire.mutateAsync({ id: target.id, cleanup: "none" }))),
    });

  const askReinstall = (target: Target) =>
    run(async () => {
      await reinstall.mutateAsync(target.id);
      notice = waitingNotice(target, "install");
    });
</script>

{#snippet retireWays(target: Target, again = true)}
  <div class="flex flex-wrap gap-2">
    {#if again}
      <Button size="touch" onclick={() => askRetire(target)}>Retire again</Button>
    {/if}
    <Button variant="outline" size="touch" class="text-destructive" onclick={() => askRetireWithoutCleanup(target)}>
      Retire without cleanup
    </Button>
  </div>
{/snippet}

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
                ? target.nodes.map((node) => hostLabel(node, hosts.data)).join(", ")
                : "none"}
            </span>
          </div>
          {#if pendingOf(target)}
            {@const waiting = pendingOf(target)!}
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
          {#if stuckRetire(target)}
            <div data-stuck-retire class="grid gap-2 rounded-lg border border-destructive/40 p-3 text-sm">
              <span class="[overflow-wrap:anywhere]">{stuckText(stuckRetire(target)!)}</span>
              {@render retireWays(target)}
            </div>
          {/if}
          {#if refused[target.id]}
            <div data-retire-refused class="grid gap-2 rounded-lg border border-destructive/40 p-3 text-sm">
              <span class="[overflow-wrap:anywhere]">The hub did not start the retire: {refused[target.id]}</span>
              <span class="text-muted-foreground">Nothing was removed. You can retire without cleanup.</span>
              {@render retireWays(target, false)}
            </div>
          {/if}
          {#if staleSource(target)}
            <Alert.Root variant="destructive" role="alert" data-stale-source>
              <Alert.Description class="grid gap-1 [overflow-wrap:anywhere]">
                {#if localOff()}
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
                {#if !stuckRetire(target) && !refused[target.id]}
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
              <Button variant="outline" size="touch" onclick={() => setState(target, "disabled")}>Disable</Button>
            {:else if target.state === "disabled"}
              <Button variant="outline" size="touch" onclick={() => setState(target, "draft")}>Enable</Button>
            {/if}
            {#if !pendingOf(target)}
              <Button variant="outline" size="touch" onclick={() => (editing = target.id)}>Edit nodes</Button>
              {#if hasProvisioner(target) && target.state !== "draft"}
                <Button
                  variant="outline"
                  size="touch"
                  disabled={reinstall.isPending}
                  onclick={() => askReinstall(target)}
                >
                  Reinstall key line
                </Button>
              {/if}
              {#if !stuckRetire(target)}
                <Button variant="outline" size="touch" class="text-destructive" onclick={() => askRetire(target)}>
                  Retire
                </Button>
              {/if}
            {/if}
          </div>
          {#if editing === target.id}
            <TargetNodesEdit
              {target}
              nodes={status.data?.nodes}
              hosts={hosts.data}
              {onapprove}
              ondone={() => (editing = null)}
            />
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
<ConfirmDialog bind:ask />

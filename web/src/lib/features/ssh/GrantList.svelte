<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { Badge, type BadgeVariant } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { cn } from "#lib/utils.js";
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { hostsQuery } from "../hosts";
  import ConfirmDialog, { type Ask } from "../../shared/ui/ConfirmDialog.svelte";
  import type { Grant, GrantState } from "./api";
  import { hostLabel } from "./hostlabel";
  import { denyGrantMutation, revokeGrantMutation } from "./mutations";
  import { grantsQuery } from "./queries";

  // The grants of SSH delegation: pending first, then active, ended last. The list refetches every 5 seconds while it
  // is mounted. TanStack stops the timer in a hidden tab. Approve only hands the grant to the page: the sheet lives
  // there, outside the data branches, so that a failed refetch cannot unmount it. Deny and Revoke need no unlock. A
  // failed poll shows the error above the list and keeps the list, so the Revoke buttons stay. Deny and Revoke are off
  // while their call runs, so that a double tap sends one call.
  let { onapprove }: { onapprove: (grant: Grant) => void } = $props();

  const GRANTS_POLL_MS = 5000;
  const client = useQueryClient();
  const grants = createQuery(() => ({ ...grantsQuery(), refetchInterval: GRANTS_POLL_MS }));
  const hosts = createQuery(() => hostsQuery());
  const deny = createMutation(() => denyGrantMutation(client));
  const revoke = createMutation(() => revokeGrantMutation(client));

  const ACTIONS = {
    sources: "Change the nodes",
    uninstall: "Retire: remove the key lines",
    install: "Put the key line back",
  } as const;
  const ORDER: Record<GrantState, number> = { pending: 0, active: 1, ended: 2 };
  const VARIANT: Record<GrantState, BadgeVariant> = { pending: "default", active: "secondary", ended: "ghost" };
  const sorted = $derived(
    [...(grants.data ?? [])].sort(
      (left, right) => ORDER[left.state] - ORDER[right.state] || right.requestedAt - left.requestedAt,
    ),
  );
  let ask = $state<Ask | null>(null);
  let problem = $state("");

  async function run(action: () => Promise<unknown>) {
    problem = "";

    try {
      await action();
    } catch (error) {
      problem = error instanceof Error ? error.message : "The change failed.";
    }
  }

  const askRevoke = (grant: Grant) =>
    (ask = {
      title: "Revoke this grant?",
      body: `The hub ends the access to ${grant.targetId} now.`,
      label: "Revoke",
      destructive: true,
      run: () => void run(() => revoke.mutateAsync(grant.id)),
    });
</script>

<section class="grid gap-3">
  <h3 class="font-heading text-base font-bold">Access requests</h3>
  {#if problem}
    <Alert.Root variant="destructive" role="alert"><Alert.Description>{problem}</Alert.Description></Alert.Root>
  {/if}
  {#if grants.error}
    <Alert.Root variant="destructive">
      <Alert.Description>Could not load requests: {grants.error.message}</Alert.Description>
    </Alert.Root>
  {/if}
  {#if grants.isPending}
    <p class="text-sm text-muted-foreground">Loading requests...</p>
  {:else if grants.data}
    {#if sorted.length === 0}
      <p class="text-sm text-muted-foreground">No requests yet.</p>
    {/if}
    <ul class="grid min-w-0 gap-2">
      {#each sorted as grant (grant.id)}
        <li
          data-grant={grant.id}
          class={cn("grid min-w-0 gap-2 rounded-lg border bg-card p-3", grant.state === "ended" && "opacity-60")}
        >
          <div class="flex min-w-0 items-center justify-between gap-2">
            <span class="min-w-0 font-medium [overflow-wrap:anywhere]">{grant.targetId}</span>
            <span class="flex shrink-0 items-center gap-1">
              {#if grant.test}<Badge variant="outline">test</Badge>{/if}
              {#if grant.maintenance}<Badge variant="destructive">maintenance</Badge>{/if}
              <Badge variant={VARIANT[grant.state]}>{grant.state}</Badge>
            </span>
          </div>
          <div class="grid min-w-0 gap-0.5 text-sm text-muted-foreground">
            {#if grant.maintenance}
              <span class="font-medium text-foreground [overflow-wrap:anywhere]">
                {ACTIONS[grant.maintenance.action]}
              </span>
              {#if grant.state === "ended" && grant.maintenance.result}
                <span class="[overflow-wrap:anywhere]">
                  Result: {grant.maintenance.result}{grant.maintenance.detail ? `. ${grant.maintenance.detail}` : ""}
                </span>
              {/if}
            {:else}
              <span class="[overflow-wrap:anywhere]">
                {hostLabel(grant.nodeId, hosts.data)} · {grant.instanceId} · {grant.minutes} minutes
              </span>
            {/if}
            {#if grant.reason}<span class="[overflow-wrap:anywhere]">{grant.reason}</span>{/if}
            {#if grant.state === "active" && grant.endsAt !== undefined}
              <span>Ends {new Date(grant.endsAt).toLocaleTimeString()}</span>
            {/if}
            {#if grant.state === "ended" && grant.endReason}<span>Ended: {grant.endReason}</span>{/if}
          </div>
          {#if grant.state === "pending"}
            <div class="flex flex-wrap gap-2">
              <Button size="touch" onclick={() => onapprove(grant)}>Approve</Button>
              <Button
                variant="outline"
                size="touch"
                disabled={deny.isPending}
                onclick={() => run(() => deny.mutateAsync(grant.id))}
              >
                Deny
              </Button>
            </div>
          {:else if grant.state === "active"}
            <div class="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="touch"
                class="text-destructive"
                disabled={revoke.isPending}
                onclick={() => askRevoke(grant)}
              >
                Revoke
              </Button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
<ConfirmDialog bind:ask />

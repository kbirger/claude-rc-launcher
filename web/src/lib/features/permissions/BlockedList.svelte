<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { createQuery } from "@tanstack/svelte-query";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { cn } from "#lib/utils.js";
  import { ago } from "../../shared/time";
  import { Button } from "#lib/components/ui/button/index.js";
  import { isUnsupported, type BlockedCall, type Layer } from "./api";
  import { deniedBy, probablyFixed, reasonLabel, reasonVariant, scopeLabel, summaryOf } from "./format";
  import { blockedQuery } from "./queries";
  import RuleSheet from "./RuleSheet.svelte";

  // `layers` are the permission files of the session (the page already loads them). Undefined means not loaded yet: Allow waits. The sheet is mounted only while it is open.
  let {
    host,
    instance,
    session,
    now,
    layers,
    live,
  }: { host: string; instance: string; session: string; now: number; layers?: Layer[]; live?: boolean } = $props();

  let sheetCall = $state<BlockedCall | null>(null);
  // A deny rule or a safety check cannot be fixed with an allow rule, so those calls have no button.
  const canAllow = (blockedCall: BlockedCall) =>
    blockedCall.reason === "needs_approval" ||
    blockedCall.reason === "user_rejected" ||
    blockedCall.reason === "classifier";

  const query = createQuery(() => blockedQuery(host, instance, session));
  const wrap = "min-w-0 [overflow-wrap:anywhere]";
</script>

{#if query.isPending}
  <p class="text-muted-foreground">Loading blocked calls...</p>
{:else if isUnsupported(query.error)}
  <p class="text-muted-foreground">This node does not support permissions. Update the node.</p>
{:else if query.error}
  <Alert.Root variant="destructive">
    <Alert.Description>Could not load the blocked calls: {query.error.message}</Alert.Description>
  </Alert.Root>
{:else if !query.data?.length}
  <p class="text-muted-foreground">Nothing was blocked in this session.</p>
{:else}
  <ul class="min-w-0 rounded-lg border bg-card">
    {#each query.data as denial (denial.id)}
      <li class="flex min-h-11 min-w-0 flex-col justify-center gap-1 border-b px-3 py-2 last:border-b-0">
        <span class={cn(wrap, "font-mono text-xs")}>{summaryOf(denial)}</span>
        <span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <Badge variant={reasonVariant(denial.reason)}>{reasonLabel(denial.reason)}</Badge>
          <span>{denial.tool}</span>
          <span aria-hidden="true">·</span>
          <span>{ago(denial.at, now)}</span>
          {#if canAllow(denial) && probablyFixed(denial, layers ?? [])}<Badge variant="secondary">
              probably fixed
            </Badge>{/if}
        </span>
        {#if denial.reason === "deny_rule"}
          {@const deniedRule = deniedBy(denial, layers ?? [])}
          <span class={cn(wrap, "text-xs text-muted-foreground")}>
            {deniedRule ? `Denied by ${deniedRule.raw} in ${scopeLabel(deniedRule.scope)}` : "Denied by a deny rule"}
          </span>
        {/if}
        {#if canAllow(denial)}
          <Button
            type="button"
            variant="outline"
            size="touch"
            class="mt-1 self-start"
            disabled={layers === undefined}
            onclick={() => (sheetCall = denial)}
          >
            Allow...
          </Button>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

{#if sheetCall}
  {#key sheetCall.id}
    <RuleSheet
      bind:open={
        () => true,
        (value) => {
          if (!value) sheetCall = null;
        }
      }
      {host}
      {instance}
      {session}
      layers={layers ?? []}
      mode="add"
      call={sheetCall}
      {live}
    />
  {/key}
{/if}

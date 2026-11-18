<script lang="ts">
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
  let { host, instance, session, now, layers, live }: { host: string; instance: string; session: string; now: number; layers?: Layer[]; live?: boolean } = $props();

  let sheetCall = $state<BlockedCall | null>(null);
  // A deny rule or a safety check cannot be fixed with an allow rule, so those calls have no button.
  const canAllow = (c: BlockedCall) => c.reason === "needs_approval" || c.reason === "user_rejected" || c.reason === "classifier";

  const q = createQuery(() => blockedQuery(host, instance, session));
  const wrap = "min-w-0 [overflow-wrap:anywhere]";
</script>

{#if q.isPending}
  <p class="text-muted-foreground">Loading blocked calls...</p>
{:else if isUnsupported(q.error)}
  <p class="text-muted-foreground">This node does not support permissions. Update the node.</p>
{:else if q.error}
  <p class="text-destructive">Could not load the blocked calls: {q.error.message}</p>
{:else if !q.data?.length}
  <p class="text-muted-foreground">Nothing was blocked in this session.</p>
{:else}
  <ul class="min-w-0 rounded-lg border bg-card">
    {#each q.data as c (c.id)}
      <li class="flex min-h-11 min-w-0 flex-col justify-center gap-1 border-b px-3 py-2 last:border-b-0">
        <span class={cn(wrap, "font-mono text-xs")}>{summaryOf(c)}</span>
        <span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <Badge variant={reasonVariant(c.reason)}>{reasonLabel(c.reason)}</Badge>
          <span>{c.tool}</span>
          <span aria-hidden="true">·</span>
          <span>{ago(c.at, now)}</span>
          {#if canAllow(c) && probablyFixed(c, layers ?? [])}<Badge variant="secondary">probably fixed</Badge>{/if}
        </span>
        {#if c.reason === "deny_rule"}
          {@const d = deniedBy(c, layers ?? [])}
          <span class={cn(wrap, "text-xs text-muted-foreground")}>{d ? `Denied by ${d.raw} in ${scopeLabel(d.scope)}` : "Denied by a deny rule"}</span>
        {/if}
        {#if canAllow(c)}
          <Button type="button" variant="outline" size="touch" class="mt-1 self-start" disabled={layers === undefined} onclick={() => (sheetCall = c)}>Allow...</Button>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

{#if sheetCall}
  {#key sheetCall.id}
    <RuleSheet bind:open={() => true, (v) => { if (!v) sheetCall = null; }} {host} {instance} {session} layers={layers ?? []} mode="add" call={sheetCall} {live} />
  {/key}
{/if}

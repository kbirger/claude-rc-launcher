<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { cn } from "#lib/utils.js";
  import { ago } from "../../shared/time";
  import { isUnsupported } from "./api";
  import { reasonLabel, reasonVariant, summaryOf } from "./format";
  import { blockedQuery } from "./queries";

  let { host, instance, session, now }: { host: string; instance: string; session: string; now: number } = $props();

  const q = createQuery(() => blockedQuery(host, instance, session));
  const wrap = "min-w-0 [overflow-wrap:anywhere]";
</script>

{#if q.isPending}
  <p class="text-muted-foreground">Loading blocked calls...</p>
{:else if isUnsupported(q.error)}
  <p class="text-muted-foreground">This node does not support permissions. Update the node.</p>
{:else if q.error}
  <p class="error">Could not load the blocked calls: {q.error.message}</p>
{:else if !q.data?.length}
  <p class="text-muted-foreground">Nothing was blocked in this session.</p>
{:else}
  <ul class="m-0 min-w-0 list-none rounded-lg border bg-card p-0">
    {#each q.data as c (c.id)}
      <li class="flex min-h-11 min-w-0 flex-col justify-center gap-1 border-b px-3 py-2 last:border-b-0">
        <span class={cn(wrap, "font-mono text-xs")}>{summaryOf(c)}</span>
        <span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <Badge variant={reasonVariant(c.reason)}>{reasonLabel(c.reason)}</Badge>
          <span>{c.tool}</span>
          <span aria-hidden="true">·</span>
          <span>{ago(c.at, now)}</span>
        </span>
      </li>
    {/each}
  </ul>
{/if}

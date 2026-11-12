<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { cn } from "#lib/utils.js";
  import { ago, sessionsHref, touchedRows } from "./format";
  import { touchedQuery } from "./queries";

  let { host, instance, session, root, now }: { host: string; instance: string; session: string; root: string; now: number } = $props();

  const q = createQuery(() => touchedQuery(host, instance, session));
  const row = "flex min-h-11 flex-col justify-center border-b px-3 py-1.5 last:border-b-0";
</script>

{#if q.isPending}
  <p class="text-muted-foreground">Loading files...</p>
{:else if q.error}
  <p class="error">{q.error.message}</p>
{:else if !q.data?.length}
  <p class="text-muted-foreground">Claude has not written or edited a file in this session.</p>
{:else}
  <ul class="m-0 list-none rounded-lg border bg-card p-0">
    {#each touchedRows(q.data, root) as { file: f, rel, link } (f.path)}
      <li>
        {#if link}
          <a class={cn(row, "no-underline")} href={sessionsHref({ host, instance, session, view: "touched", ...link })}>
            {#if rel}
              <span class="truncate">{rel}</span>
            {:else}
              <span class="[overflow-wrap:anywhere]">{f.path}</span>
            {/if}
            <span class="text-xs text-muted-foreground">{f.inside ? "" : "outside the session folder · "}{f.tool} · {ago(f.at, now)}</span>
          </a>
        {:else}
          <div class={cn(row, "text-muted-foreground")}>
            {#if rel}
              <span class="truncate">{rel}</span>
            {:else}
              <span class="[overflow-wrap:anywhere]">{f.path}</span>
            {/if}
            <span class="text-xs">not written · {f.inside ? "" : "outside the session folder · "}{f.tool} · {ago(f.at, now)}</span>
          </div>
        {/if}
      </li>
    {/each}
  </ul>
  <p class="text-xs text-muted-foreground">Files created by commands do not appear here.</p>
{/if}

<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { cn } from "#lib/utils.js";
  import { ago, lastSegments, relativeTo, sessionsHref } from "./format";
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
    {#each [...q.data].reverse() as f (f.path)}
      {@const rel = f.inside ? relativeTo(root, f.path) : undefined}
      <li>
        {#if rel}
          <a class={cn(row, "no-underline")} href={sessionsHref({ host, instance, session, view: "touched", file: rel })}>
            <span class="truncate">{rel}</span>
            <span class="text-xs text-muted-foreground">{f.tool} · {ago(f.at, now)}</span>
          </a>
        {:else}
          <div class={cn(row, "opacity-50")} aria-disabled="true">
            <span class="truncate">{lastSegments(f.path)}</span>
            <span class="text-xs text-muted-foreground">outside the session folder</span>
          </div>
        {/if}
      </li>
    {/each}
  </ul>
  <p class="text-xs text-muted-foreground">Files created by commands do not appear here.</p>
{/if}

<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { cn } from "#lib/utils.js";
  import { crumbs } from "./crumbs";
  import { ago, humanSize, joinPath, sessionsHref } from "./format";
  import { filesQuery } from "./queries";

  let { host, instance, session, path, now }: { host: string; instance: string; session: string; path: string; now: number } = $props();

  let hidden = $state(false);
  const q = createQuery(() => filesQuery(host, instance, session, path, hidden));
  const link = (p: string, file?: string) => sessionsHref({ host, instance, session, view: "folder", path: p, file });
  const row = "flex min-h-11 flex-col justify-center border-b px-3 py-1.5 last:border-b-0";
</script>

<nav class="mb-2 flex flex-wrap items-center" aria-label="Folder">
  {#each crumbs(path) as c, i (c.path)}
    {#if i > 1}<span class="text-muted-foreground">/</span>{/if}
    <a href={link(c.path)} class="inline-flex min-h-11 items-center px-1.5">{c.name}</a>
  {/each}
</nav>
<label class="mb-2 flex min-h-11 items-center gap-2"><input type="checkbox" bind:checked={hidden} />Show hidden</label>

{#if q.isPending}
  <p class="text-muted-foreground">Loading folder...</p>
{:else if q.error}
  <p class="error">{q.error.message}</p>
{:else if !q.data?.entries.length}
  <p class="text-muted-foreground">This folder is empty.</p>
{:else}
  <ul class="m-0 list-none rounded-lg border bg-card p-0">
    {#each q.data.entries as e (e.name)}
      <li>
        {#if e.kind === "other"}
          <div class={cn(row, "opacity-50")} aria-disabled="true">
            <span class="truncate">{e.name}</span>
            <span class="text-xs text-muted-foreground">not a regular file</span>
          </div>
        {:else}
          <a class={cn(row, "no-underline")} href={e.kind === "dir" ? link(joinPath(path, e.name)) : link(path, joinPath(path, e.name))}>
            <span class="truncate">{e.kind === "dir" ? `${e.name}/` : e.name}</span>
            <span class="text-xs text-muted-foreground">{e.kind === "file" && e.size !== undefined ? `${humanSize(e.size)} · ` : ""}{ago(e.mtime, now)}</span>
          </a>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

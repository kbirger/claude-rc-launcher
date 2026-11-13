<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { cn } from "#lib/utils.js";
  import { ago, sessionsHref, splitPath, touchedRows } from "./format";
  import { changedQuery, touchedQuery } from "./queries";
  import type { ChangedFile } from "./api";

  // `changed`: the files that git shows as changed since the session started, not the ones that Claude wrote.
  let { host, instance, session, root, now, kind = "touched" }: { host: string; instance: string; session: string; root: string; now: number; kind?: "touched" | "changed" } = $props();

  const q = createQuery(() => (kind === "changed" ? changedQuery(host, instance, session) : touchedQuery(host, instance, session)));
  const what = (f: { tool: string }) => (kind === "changed" ? ((f as ChangedFile).state ?? f.tool) : f.tool);
  // Names and paths wrap anywhere, so a long name makes the row taller and never makes the page wider.
  const row = "flex min-h-11 min-w-0 flex-col justify-center border-b px-3 py-1.5 last:border-b-0";
  const wrap = "min-w-0 [overflow-wrap:anywhere]";
</script>

{#snippet label(path: string)}
  {@const p = splitPath(path)}
  <span class={cn(wrap, "font-semibold")} data-file-name>{p.name}</span>
  {#if p.dir}<span class={cn(wrap, "text-xs text-muted-foreground")} data-file-dir>{p.dir}</span>{/if}
{/snippet}

{#if q.isPending}
  <p class="text-muted-foreground">Loading files...</p>
{:else if q.error}
  <p class="error">{q.error.message}</p>
{:else if !q.data?.length}
  <p class="text-muted-foreground">{kind === "changed" ? "Git shows no changed file in this folder since the session started, or the folder is not a git work tree." : "Claude has not written or edited a file in this session."}</p>
{:else}
  <ul class="m-0 min-w-0 list-none rounded-lg border bg-card p-0">
    {#each touchedRows(q.data, root) as { file: f, rel, link } (f.path)}
      <li class="min-w-0">
        {#if link}
          <a class={cn(row, "no-underline")} href={sessionsHref({ host, instance, session, view: kind, ...link })}>
            {@render label(rel ?? f.path)}
            <span class={cn(wrap, "text-xs text-muted-foreground")}>{f.inside ? "" : "outside the session folder · "}{what(f)} · {ago(f.at, now)}</span>
          </a>
        {:else}
          <div class={cn(row, "text-muted-foreground")}>
            {@render label(rel ?? f.path)}
            <span class={cn(wrap, "text-xs")}>not written · {f.inside ? "" : "outside the session folder · "}{what(f)} · {ago(f.at, now)}</span>
          </div>
        {/if}
      </li>
    {/each}
  </ul>
  <p class="text-xs text-muted-foreground">{kind === "changed" ? "Git cannot tell who changed a file: changes by you or by another session in this folder are listed too." : "Files created by commands do not appear here."}</p>
{/if}

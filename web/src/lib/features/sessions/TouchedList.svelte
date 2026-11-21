<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { createQuery } from "@tanstack/svelte-query";
  import { cn } from "#lib/utils.js";
  import { ago, sessionsHref, splitPath, touchedRows } from "./format";
  import { changedQuery, touchedQuery } from "./queries";
  import type { ChangedFile } from "./api";

  // `changed`: the files that git shows as changed since the session started, not the ones that Claude wrote.
  let {
    host,
    instance,
    session,
    root,
    now,
    kind = "touched",
  }: {
    host: string;
    instance: string;
    session: string;
    root: string;
    now: number;
    kind?: "touched" | "changed";
  } = $props();

  const query = createQuery(() =>
    kind === "changed" ? changedQuery(host, instance, session) : touchedQuery(host, instance, session),
  );
  const what = (use: { tool: string }) => (kind === "changed" ? ((use as ChangedFile).state ?? use.tool) : use.tool);
  // Names and paths wrap anywhere, so a long name makes the row taller and never makes the page wider.
  const row = "flex min-h-11 min-w-0 flex-col justify-center border-b px-3 py-1.5 last:border-b-0";
  const wrap = "min-w-0 [overflow-wrap:anywhere]";
</script>

{#snippet label(path: string)}
  {@const pathParts = splitPath(path)}
  <span class={cn(wrap, "font-semibold")} data-file-name>{pathParts.name}</span>
  {#if pathParts.dir}<span class={cn(wrap, "text-xs text-muted-foreground")} data-file-dir>{pathParts.dir}</span>{/if}
{/snippet}

{#if query.isPending}
  <p class="text-muted-foreground">Loading files...</p>
{:else if query.error}
  <Alert.Root variant="destructive"><Alert.Description>{query.error.message}</Alert.Description></Alert.Root>
{:else if !query.data?.length}
  <p class="text-muted-foreground">
    {kind === "changed"
      ? "Git shows no changed file in this folder since the session started, or the folder is not a git work tree."
      : "Claude has not written or edited a file in this session."}
  </p>
{:else}
  <ul class="min-w-0 rounded-lg border bg-card">
    {#each touchedRows(query.data, root) as { file: item, rel, link } (item.path)}
      <li class="min-w-0">
        {#if link}
          <a class={cn(row, "no-underline")} href={sessionsHref({ host, instance, session, view: kind, ...link })}>
            {@render label(rel ?? item.path)}
            <span class={cn(wrap, "text-xs text-muted-foreground")}>
              {item.inside ? "" : "outside the session folder · "}{what(item)} · {ago(item.at, now)}
            </span>
          </a>
        {:else}
          <div class={cn(row, "text-muted-foreground")}>
            {@render label(rel ?? item.path)}
            <span class={cn(wrap, "text-xs")}>
              not written · {item.inside ? "" : "outside the session folder · "}{what(item)} · {ago(item.at, now)}
            </span>
          </div>
        {/if}
      </li>
    {/each}
  </ul>
  <p class="text-xs text-muted-foreground">
    {kind === "changed"
      ? "Git cannot tell who changed a file: changes by you or by another session in this folder are listed too."
      : "Files created by commands do not appear here."}
  </p>
{/if}

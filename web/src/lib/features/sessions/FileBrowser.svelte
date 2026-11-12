<script lang="ts">
  import { goto } from "$app/navigation";
  import { createQuery } from "@tanstack/svelte-query";
  import { cn } from "#lib/utils.js";
  import { crumbs } from "./crumbs";
  import { ago, humanSize, inHiddenPath, joinPath, sessionsHref } from "./format";
  import { filesQuery } from "./queries";

  type Props = { host: string; instance: string; session: string; path: string; hidden: boolean; now: number };
  let { host, instance, session, path, hidden, now }: Props = $props();

  const q = createQuery(() => filesQuery(host, instance, session, path, hidden));
  // `hidden` lives in the address, so it survives opening a folder or a file and going back.
  const link = (p: string, file?: string, h = hidden) => sessionsHref({ host, instance, session, view: "folder", path: p, hidden: h, file });
  // A path through a dot name can only be listed with hidden names shown.
  const forced = $derived(inHiddenPath(path));
  // The last crumb is the folder on screen; its path is the cleaned form of `path`.
  const crumbPath = $derived(crumbs(path).at(-1)?.path);
  // Names wrap anywhere, so a long name makes the row taller and never makes the page wider.
  const row = "flex min-h-11 min-w-0 flex-col justify-center border-b px-3 py-1.5 last:border-b-0";
  const wrap = "min-w-0 [overflow-wrap:anywhere]";
</script>

<nav class="mb-2 flex min-w-0 flex-wrap items-center" aria-label="Folder">
  {#each crumbs(path) as c, i (c.path)}
    {#if i > 1}<span class="text-muted-foreground">/</span>{/if}
    <a href={link(c.path)} class="inline-flex min-h-11 max-w-full min-w-0 items-center px-1.5 [overflow-wrap:anywhere]" aria-current={c.path === crumbPath ? "page" : undefined}>{c.name}</a>
  {/each}
</nav>
<label class="mb-2 inline-flex min-h-11 items-center gap-2">
  <input
    type="checkbox"
    class="m-0 size-4 min-h-0 shrink-0 p-0"
    checked={hidden}
    disabled={forced}
    onchange={(e) => goto(link(path, undefined, e.currentTarget.checked), { replace: true, reset: false })}
  />Show hidden
</label>

{#if q.isPending}
  <p class="text-muted-foreground">Loading folder...</p>
{:else if q.error}
  <p class="error">{q.error.message}</p>
{:else if !q.data?.entries.length}
  <p class="text-muted-foreground">This folder is empty.</p>
{:else}
  <ul class="m-0 min-w-0 list-none rounded-lg border bg-card p-0">
    {#each q.data.entries as e (e.name)}
      <li class="min-w-0">
        {#if e.kind === "other"}
          <div class={cn(row, "opacity-50")} role="link" aria-disabled="true">
            <span class={wrap}>{e.name}</span>
            <span class={cn(wrap, "text-xs text-muted-foreground")}>not a regular file</span>
          </div>
        {:else}
          <a class={cn(row, "no-underline")} href={e.kind === "dir" ? link(joinPath(path, e.name)) : link(path, joinPath(path, e.name))}>
            <span class={wrap}>{e.kind === "dir" ? `${e.name}/` : e.name}</span>
            <span class={cn(wrap, "text-xs text-muted-foreground")}>{e.kind === "file" && e.size !== undefined ? `${humanSize(e.size)} · ` : ""}{ago(e.mtime, now)}</span>
          </a>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

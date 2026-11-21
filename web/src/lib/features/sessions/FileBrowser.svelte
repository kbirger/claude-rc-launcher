<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { goto } from "$app/navigation";
  import { createQuery } from "@tanstack/svelte-query";
  import ChevronRight from "@tabler/icons-svelte/icons/chevron-right";
  import FolderOpen from "@tabler/icons-svelte/icons/folder-open";
  import { Checkbox } from "#lib/components/ui/checkbox/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import { cn } from "#lib/utils.js";
  import { crumbs } from "./crumbs";
  import { ago, humanSize, inHiddenPath, joinPath, sessionsHref } from "./format";
  import { filesQuery } from "./queries";

  type Props = { host: string; instance: string; session: string; path: string; hidden: boolean; now: number };
  let { host, instance, session, path, hidden, now }: Props = $props();

  const query = createQuery(() => filesQuery(host, instance, session, path, hidden));
  // `hidden` lives in the address, so it survives opening a folder or a file and going back.
  const link = (target: string, file?: string, showHidden = hidden) =>
    sessionsHref({ host, instance, session, view: "folder", path: target, hidden: showHidden, file });
  // A path through a dot name can only be listed with hidden names shown.
  const forced = $derived(inHiddenPath(path));
  // The last crumb is the folder on screen; its path is the cleaned form of `path`.
  const crumbPath = $derived(crumbs(path).at(-1)?.path);
  // Names wrap anywhere, so a long name makes the row taller and never makes the page wider.
  const row = "flex min-h-11 min-w-0 flex-col justify-center border-b px-3 py-1.5 last:border-b-0";
  const wrap = "min-w-0 [overflow-wrap:anywhere]";
</script>

<!-- The path of the folder on screen, in a box of its own with the switch for hidden names. The last part is the folder you are in. -->
<div class="mb-3 flex min-w-0 flex-wrap items-center gap-x-3 rounded-lg border bg-muted/40 px-2">
  <nav class="flex min-w-0 flex-1 flex-wrap items-center" aria-label="Folder">
    <FolderOpen size={18} class="mx-1 shrink-0 text-muted-foreground" aria-hidden="true" />
    {#each crumbs(path) as crumb, index (crumb.path)}
      {#if index > 0}<ChevronRight size={14} class="shrink-0 text-muted-foreground" aria-hidden="true" />{/if}
      {#if crumb.path === crumbPath}
        <span
          class="inline-flex min-h-11 max-w-full min-w-0 items-center px-1.5 font-semibold [overflow-wrap:anywhere]"
          aria-current="page"
        >
          {index === 0 ? "Session folder" : crumb.name}
        </span>
      {:else}
        <a
          href={link(crumb.path)}
          class="inline-flex min-h-11 max-w-full min-w-0 items-center px-1.5 [overflow-wrap:anywhere]"
        >
          {index === 0 ? "Session folder" : crumb.name}
        </a>
      {/if}
    {/each}
  </nav>
  <Label class="min-h-11 text-muted-foreground">
    <Checkbox
      checked={hidden}
      disabled={forced}
      onCheckedChange={(value) => goto(link(path, undefined, value), { replace: true, reset: false })}
    />Show hidden
  </Label>
</div>

{#if query.isPending}
  <p class="text-muted-foreground">Loading folder...</p>
{:else if query.error}
  <Alert.Root variant="destructive"><Alert.Description>{query.error.message}</Alert.Description></Alert.Root>
{:else if !query.data?.entries.length}
  <p class="text-muted-foreground">This folder is empty.</p>
{:else}
  <ul class="min-w-0 rounded-lg border bg-card">
    {#each query.data.entries as entry (entry.name)}
      <li class="min-w-0">
        {#if entry.kind === "other"}
          <div class={cn(row, "opacity-50")} role="link" aria-disabled="true">
            <span class={wrap}>{entry.name}</span>
            <span class={cn(wrap, "text-xs text-muted-foreground")}>not a regular file</span>
          </div>
        {:else}
          <a
            class={cn(row, "no-underline")}
            href={entry.kind === "dir" ? link(joinPath(path, entry.name)) : link(path, joinPath(path, entry.name))}
          >
            <span class={wrap}>{entry.kind === "dir" ? `${entry.name}/` : entry.name}</span>
            <span class={cn(wrap, "text-xs text-muted-foreground")}>
              {entry.kind === "file" && entry.size !== undefined ? `${humanSize(entry.size)} · ` : ""}{ago(
                entry.mtime,
                now,
              )}
            </span>
          </a>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

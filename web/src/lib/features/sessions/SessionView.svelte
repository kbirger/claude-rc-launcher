<script lang="ts">
  import { goto } from "$app/navigation";
  import { createQuery } from "@tanstack/svelte-query";
  import ArrowLeft from "@tabler/icons-svelte/icons/arrow-left";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Tabs from "#lib/components/ui/tabs/index.js";
  import FileBrowser from "./FileBrowser.svelte";
  import FilePreview from "./FilePreview.svelte";
  import TouchedList from "./TouchedList.svelte";
  import { isUnsupported } from "./api";
  import { ago, sessionsHref, sessionTitle, worktreeName } from "./format";
  import { sessionsQuery } from "./queries";
  import { instancesQuery } from "../instances/queries";

  // `abs`: a touched file opened by its absolute path (it may be outside the session folder). It wins over `file`.
  type Props = { host: string; instance: string; session: string; view: "touched" | "folder"; path: string; hidden: boolean; file: string; abs?: string; now: number };
  let { host, instance, session, view, path, hidden, file, abs = "", now }: Props = $props();

  const q = createQuery(() => sessionsQuery(host, instance));
  const s = $derived(q.data?.find((x) => x.id === session));
  // The name of the instance, for the way back. The instance list is cached by the page before this one.
  const instances = createQuery(() => instancesQuery(host));
  const instanceName = $derived(instances.data?.find((x) => x.id === instance)?.name);
  const href = (v: "touched" | "folder", extra: { path?: string; file?: string } = {}) =>
    sessionsHref({ host, instance, session, view: v, ...(v === "folder" ? { hidden } : {}), ...extra });
  // A tab change is a navigation, like the links it replaced: it adds a history entry, keeps host, instance and session,
  // and drops path, file and abs. reset: false leaves the focus on the tab, so the arrow keys keep working.
  // What each tab shows, in words. It sits under the tabs and follows the selected one.
  const help = { touched: "Files that Claude wrote or edited in this session.", folder: "Every file in the folder of this session, also files that Claude did not touch." };
  const pick = (v: string) => {
    if (v === "touched" || v === "folder") void goto(href(v), { reset: false });
  };
</script>

<div class="grid grid-cols-[minmax(0,1fr)] gap-3">
  <!-- A file preview needs the room: it has its own Back button, so the session header is left out while a file is open. -->
  {#if !abs && !file}
    <Button variant="ghost" size="sm" class="-ml-2 h-8 w-fit px-2 text-muted-foreground hover:border-border" href={sessionsHref({ host, instance })}>
      <ArrowLeft aria-hidden="true" />Back to {instanceName ? `${instanceName} sessions` : "sessions"}
    </Button>
    {#if s}
      {@const wt = worktreeName(s.root)}
      <header class="grid gap-1">
        <h2 class="m-0 text-xl leading-tight font-semibold [overflow-wrap:anywhere]">{sessionTitle(s) ?? "Untitled session"}</h2>
        <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          {#if s.branch}<span class="min-w-0 [overflow-wrap:anywhere]">{s.branch}</span><span aria-hidden="true">·</span>{/if}
          <span class="font-mono text-xs">{s.id.slice(0, 8)}</span>
          <span aria-hidden="true">·</span>
          <span>{ago(s.lastActiveAt, now)}</span>
          {#if wt}<Badge variant="outline">work tree</Badge><span class="min-w-0 [overflow-wrap:anywhere]">{wt}</span>{/if}
        </div>
      </header>
    {/if}
  {/if}

  {#if abs}
    <FilePreview {host} {instance} {session} file={abs} abs back={href("touched")} backLabel="Back to touched files" />
  {:else if file}
    <FilePreview {host} {instance} {session} {file} back={view === "folder" ? href("folder", { path }) : href("touched")} backLabel={view === "folder" ? "Back to folder" : "Back to touched files"} />
  {:else}
    <h3 class="m-0 text-sm font-semibold">Files</h3>
    <Tabs.Root value={view} onValueChange={pick}>
      <Tabs.List aria-label="Session files" class="w-full">
        <Tabs.Trigger value="touched" class="h-11 text-sm">Touched</Tabs.Trigger>
        <Tabs.Trigger value="folder" class="h-11 text-sm">Folder</Tabs.Trigger>
      </Tabs.List>
      <p class="mx-0 mt-2 mb-3 text-xs text-muted-foreground">{help[view]}</p>
      <Tabs.Content value={view} class="min-w-0">
        {#if q.isPending}
          <p class="text-muted-foreground">Loading session...</p>
        {:else if isUnsupported(q.error)}
          <p class="text-muted-foreground">This node does not support session files. Update the node.</p>
        {:else if q.error}
          <p class="error">Could not load the session: {q.error.message}</p>
        {:else if !s}
          <p class="error">Session not found.</p>
        {:else if view === "folder"}
          <FileBrowser {host} {instance} {session} {path} {hidden} {now} />
        {:else}
          <TouchedList {host} {instance} {session} root={s.root} {now} />
        {/if}
      </Tabs.Content>
    </Tabs.Root>
  {/if}
</div>

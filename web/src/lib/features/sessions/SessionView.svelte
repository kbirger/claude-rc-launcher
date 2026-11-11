<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import FileBrowser from "./FileBrowser.svelte";
  import FilePreview from "./FilePreview.svelte";
  import TouchedList from "./TouchedList.svelte";
  import { isUnsupported } from "./api";
  import { ago, sessionsHref, worktreeName } from "./format";
  import { sessionsQuery } from "./queries";

  type Props = { host: string; instance: string; session: string; view: "touched" | "folder"; path: string; hidden: boolean; file: string; now: number };
  let { host, instance, session, view, path, hidden, file, now }: Props = $props();

  const q = createQuery(() => sessionsQuery(host, instance));
  const s = $derived(q.data?.find((x) => x.id === session));
  const href = (v: "touched" | "folder", extra: { path?: string; file?: string } = {}) =>
    sessionsHref({ host, instance, session, view: v, ...(v === "folder" ? { hidden } : {}), ...extra });
  const tab = (v: "touched" | "folder") => (view === v ? "default" : "outline");
</script>

<div class="grid gap-3">
  <Button variant="outline" size="touch" href={sessionsHref({ host, instance })}>All sessions</Button>
  {#if s}
    {@const wt = worktreeName(s.root)}
    <div class="flex flex-wrap items-center gap-2 text-muted-foreground">
      <span class="font-semibold text-foreground">{s.branch ?? "no branch"}</span>
      <span class="font-mono">{s.id.slice(0, 8)}</span>
      <span>{ago(s.lastActiveAt, now)}</span>
      {#if wt}<Badge variant="outline">work tree</Badge><span>{wt}</span>{/if}
    </div>
  {/if}

  {#if file}
    <FilePreview {host} {instance} {session} {file} back={view === "folder" ? href("folder", { path }) : href("touched")} />
  {:else}
    <div class="flex gap-2">
      <Button class="flex-1" size="touch" variant={tab("touched")} href={href("touched")} aria-current={view === "touched" ? "page" : undefined}>Touched</Button>
      <Button class="flex-1" size="touch" variant={tab("folder")} href={href("folder")} aria-current={view === "folder" ? "page" : undefined}>Folder</Button>
    </div>
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
  {/if}
</div>

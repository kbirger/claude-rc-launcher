<script lang="ts">
  import type { Snippet } from "svelte";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { cn } from "#lib/utils.js";
  import type { HostInfo } from "./api";
  import { isOutdated, versionsText } from "./nodeline";

  // `actions` draws the per-node commands (later: unpair and more) so this list does not need to know them.
  // `latest` is the newest release; a node behind it (or behind the hub) gets the update badge.
  // `onrename` makes the name of a node (one that was paired with the CLI, not the hub) editable. It rejects with the error to show.
  let { hosts, selected, onselect, actions, latest, onrename }: { hosts: HostInfo[]; selected: string; onselect: (id: string) => void; actions?: Snippet<[HostInfo]>; latest?: string; onrename?: (id: string, name: string) => Promise<unknown> } = $props();

  let editing = $state<string | null>(null);
  let draft = $state("");
  let error = $state("");
  let saving = $state(false);
  const renamable = (h: HostInfo) => !!onrename && h.id !== "local" && h.source === "managed";
  function edit(h: HostInfo) {
    editing = h.id;
    draft = h.name;
    error = "";
  }
  async function save(h: HostInfo) {
    const name = draft.trim();
    if (!name || name === h.name) return void (editing = null);
    saving = true;
    try {
      await onrename!(h.id, name);
      editing = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }
</script>

<ul class="m-0 grid list-none gap-2 p-0" aria-label="Nodes">
  {#each hosts as h (h.id)}
    {@const outdated = h.status === "ok" && isOutdated(h, latest)}
    <li class={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border bg-card px-3 py-2", h.id === selected && "border-primary")}>
      <div class="flex min-w-0 flex-1 basis-40 flex-col gap-1">
        <div class="flex items-center gap-2">
          {#if editing === h.id}
            <form class="flex min-w-0 flex-1 items-center gap-1" onsubmit={(e) => { e.preventDefault(); void save(h); }}>
              <input bind:value={draft} maxlength="64" aria-label="Node name" class="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-base" onkeydown={(e) => e.key === "Escape" && (editing = null)} />
              <Button type="submit" size="sm" disabled={saving}>Save</Button>
              <Button type="button" variant="ghost" size="sm" onclick={() => (editing = null)}>Cancel</Button>
            </form>
          {:else}
            <span class="min-w-0 font-semibold [overflow-wrap:anywhere]">{h.name}</span>
            {#if renamable(h)}<Button variant="ghost" size="sm" class="h-7 px-1.5 text-xs text-muted-foreground" onclick={() => edit(h)} aria-label="Rename {h.name}">Rename</Button>{/if}
          {/if}
          <Badge variant={h.status === "ok" || h.status === "restarting" ? "outline" : "destructive"} class={h.status === "ok" ? "text-success" : h.status === "restarting" ? "text-warning" : ""}>{h.status}</Badge>
        </div>
        {#if editing === h.id && error}<span class="text-xs text-destructive" role="alert">{error}</span>{/if}
        {#if h.status === "ok"}
          <!-- One chip for the versions; the badge inside says that an update is due. -->
          <span class="inline-flex w-fit max-w-full items-center gap-1.5 rounded-full border bg-muted px-2.5 py-0.5 text-xs text-muted-foreground" title={outdated ? `Out of date${latest ? `, latest ${latest}` : ""}` : undefined}>
            <span class="min-w-0 [overflow-wrap:anywhere]">{versionsText(h)}</span>
            {#if outdated}<Badge variant="outline" class="h-4 border-warning px-1.5 text-[0.65rem] text-warning">update</Badge>{/if}
          </span>
        {:else if h.error}
          <span class="text-xs text-muted-foreground [overflow-wrap:anywhere]">{h.error}</span>
        {/if}
      </div>
      <div class="flex flex-none flex-wrap gap-2">
        <Button variant={h.id === selected ? "secondary" : "outline"} size="touch" disabled={h.id === selected || h.status !== "ok"} onclick={() => onselect(h.id)}>
          {h.id === selected ? "Active" : "Use"}
        </Button>
        {@render actions?.(h)}
      </div>
    </li>
  {/each}
</ul>

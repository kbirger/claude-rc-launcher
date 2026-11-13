<script lang="ts">
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Popover from "#lib/components/ui/popover/index.js";
  import ArrowUp from "@tabler/icons-svelte/icons/circle-arrow-up";
  import Circle from "@tabler/icons-svelte/icons/circle";
  import Check from "@tabler/icons-svelte/icons/circle-check";
  import Pencil from "@tabler/icons-svelte/icons/pencil";
  import { cn } from "#lib/utils.js";
  import type { HostInfo } from "./api";
  import { components, roleOf } from "./nodeline";

  // `latest` is the newest release; a component behind it (or a service behind the hub) gets the update badge.
  // `onrename` makes the name of a node (one that was paired with the CLI, not the hub) editable. It rejects with the error to show.
  // `onupdate` updates a node to the latest release. It rejects with the error to show.
  let { hosts, selected, onselect, latest, onrename, onupdate }: { hosts: HostInfo[]; selected: string; onselect: (id: string) => void; latest?: string; onrename?: (id: string, name: string) => Promise<unknown>; onupdate?: (h: HostInfo) => Promise<unknown> } = $props();

  let editing = $state<string | null>(null);
  let draft = $state("");
  let error = $state("");
  let saving = $state(false);
  let updating = $state<string | null>(null);
  let updateError = $state<Record<string, string>>({});
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
  async function update(h: HostInfo) {
    updating = h.id;
    delete updateError[h.id];
    try {
      await onupdate!(h);
    } catch (e) {
      updateError[h.id] = e instanceof Error ? e.message : String(e);
    } finally {
      updating = null;
    }
  }

  const chip = "inline-flex h-6 items-center gap-1.5 rounded-full border bg-muted px-2.5 text-xs text-muted-foreground";
</script>

<ul class="m-0 grid list-none gap-2 p-0" aria-label="Nodes">
  {#each hosts as h (h.id)}
    <li class={cn("flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-card px-3 py-2", h.id === selected && "border-primary")}>
      <div class="flex min-w-0 flex-1 basis-48 flex-col gap-1.5">
        {#if editing === h.id}
          <form class="flex min-w-0 items-center gap-1" onsubmit={(e) => { e.preventDefault(); void save(h); }}>
            <input bind:value={draft} maxlength="64" aria-label="Node name" class="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-base" onkeydown={(e) => e.key === "Escape" && (editing = null)} />
            <Button type="submit" size="sm" disabled={saving}>Save</Button>
            <Button type="button" variant="ghost" size="sm" onclick={() => (editing = null)}>Cancel</Button>
          </form>
          {#if error}<span class="text-xs text-destructive" role="alert">{error}</span>{/if}
        {/if}
        <!-- The first line: the name (or the rename form above), the role and the health of the node. -->
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          {#if editing !== h.id}<span class="min-w-0 font-semibold [overflow-wrap:anywhere]">{h.name}</span>{/if}
          <!-- The hub is the special node, so its chip has the primary color. An agent has the plain chip. -->
          <span class={cn(chip, roleOf(h) === "hub" && "border-primary/40 bg-primary/10 font-medium text-primary")}>{roleOf(h)}</span>
          <Badge variant={h.status === "ok" || h.status === "restarting" ? "outline" : "destructive"} class={cn("h-6", h.status === "ok" ? "text-success" : h.status === "restarting" ? "text-warning" : "")}>{h.status}</Badge>
        </div>
        <!-- The second line: one chip for each component, with its update badge. -->
        <div class="flex flex-wrap items-center gap-1.5">
          {#if h.status === "ok"}
            {#each components(h, latest) as c (c.key)}
              <span class={chip}>
                {c.text}
                {#if c.outdated && onupdate}
                  <Popover.Root>
                    <Popover.Trigger aria-label="Update available for the {c.key} of {h.name}" class="inline-flex h-4 items-center gap-0.5 rounded-full border border-warning px-1.5 text-[0.65rem] text-warning transition-colors hover:bg-warning/10">
                      <ArrowUp size={10} aria-hidden="true" />update
                    </Popover.Trigger>
                    <Popover.Content class="w-64 gap-2 p-3" align="start">
                      <p class="m-0 text-sm">The {c.key} on <strong class="font-semibold">{h.name}</strong> is out of date{latest ? `. Latest release: ${latest}` : ""}.</p>
                      <p class="m-0 text-xs text-muted-foreground">The update replaces the service and the client of this node.</p>
                      <Button size="sm" class="w-fit" disabled={updating === h.id} onclick={() => update(h)}>
                        <ArrowUp aria-hidden="true" />{updating === h.id ? "Updating..." : `Update ${h.name}`}
                      </Button>
                      {#if updateError[h.id]}<span class="text-xs text-destructive" role="alert">{updateError[h.id]}</span>{/if}
                    </Popover.Content>
                  </Popover.Root>
                {:else if c.outdated}
                  <Badge variant="outline" class="h-4 border-warning px-1.5 text-[0.65rem] text-warning">update</Badge>
                {/if}
              </span>
            {/each}
          {/if}
        </div>
        {#if h.status !== "ok" && h.error}
          <span class="text-xs text-muted-foreground [overflow-wrap:anywhere]">{h.error}</span>
        {/if}
      </div>
      <div class="ml-auto flex flex-none items-center gap-1">
        {#if renamable(h) && editing !== h.id}
          <Button variant="ghost" size="sm" class="h-8 px-2 text-muted-foreground hover:border-border" onclick={() => edit(h)} aria-label="Rename {h.name}">
            <Pencil aria-hidden="true" />Rename
          </Button>
        {/if}
        <!-- One button for the state of the node in the app: Active (the node in use), Use (it can be used), or Unavailable (it is not running). -->
        <Button variant="ghost" size="sm" class={cn("h-8 min-w-24 px-2 hover:border-border", h.id === selected && "text-primary disabled:opacity-100")} disabled={h.id === selected || h.status !== "ok"} onclick={() => onselect(h.id)} aria-pressed={h.id === selected}>
          {#if h.id === selected}<Check aria-hidden="true" />Active{:else if h.status === "ok"}<Circle aria-hidden="true" />Use{:else}<Circle aria-hidden="true" />Unavailable{/if}
        </Button>
      </div>
    </li>
  {/each}
</ul>

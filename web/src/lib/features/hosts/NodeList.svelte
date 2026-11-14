<script lang="ts">
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
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

  const chip = "inline-flex min-h-6 max-w-full items-center gap-1.5 rounded-full border bg-muted px-2.5 py-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere]";
</script>

<ul class="m-0 grid list-none gap-2 p-0" aria-label="Nodes">
  {#each hosts as h (h.id)}
    <li class={cn("flex flex-col gap-1.5 rounded-lg border bg-card p-3", h.id === selected && "border-primary")}>
      <div class="flex min-w-0 flex-col gap-1.5">
        {#if editing === h.id}
          <form class="flex min-w-0 items-center gap-1" onsubmit={(e) => { e.preventDefault(); void save(h); }}>
            <input bind:value={draft} maxlength="64" aria-label="Node name" class="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-base" onkeydown={(e) => e.key === "Escape" && (editing = null)} />
            <Button type="submit" size="sm" disabled={saving}>Save</Button>
            <Button type="button" variant="ghost" size="sm" onclick={() => (editing = null)}>Cancel</Button>
          </form>
          {#if error}<span class="text-xs text-destructive" role="alert">{error}</span>{/if}
        {/if}
        <!-- The first line: the name (or the rename form above) and the role on the left, the health of the node on the right. -->
        <div class="flex items-start justify-between gap-2">
          <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {#if editing !== h.id}<span class="min-w-0 font-semibold [overflow-wrap:anywhere]">{h.name}</span>{/if}
            <!-- The hub is the special node, so its chip has the primary color. An agent has the plain chip. -->
            <span class={cn(chip, roleOf(h) === "hub" && "border-primary/40 bg-primary/10 font-medium text-primary")}>{roleOf(h)}</span>
          </div>
          <Badge variant={h.status === "ok" || h.status === "restarting" ? "outline" : "destructive"} class={cn("h-6 flex-none", h.status === "ok" ? "text-success" : h.status === "restarting" ? "text-warning" : "")}>{h.status}</Badge>
        </div>
        <!-- The second line: one chip for each component, with its update badge. -->
        <div class="flex flex-wrap items-center gap-1.5">
          {#if h.status === "ok"}
            {#each components(h, latest) as c (c.key)}
              <span class={chip}>
                {c.text}
                {#if c.outdated}
                  <Badge variant="outline" class="h-4 border-warning px-1.5 text-[0.65rem] text-warning">update</Badge>
                {/if}
              </span>
            {/each}
          {/if}
        </div>
        {#if updateError[h.id]}<span class="text-xs text-destructive" role="alert">{updateError[h.id]}</span>{/if}
        {#if h.status !== "ok" && h.error}
          <span class="text-xs text-muted-foreground [overflow-wrap:anywhere]">{h.error}</span>
        {/if}
      </div>
      <!-- One action row. -mx-2 cancels the ghost buttons' inner padding, so the first and last buttons line up with the text edges. -->
      <div class="-mx-2 mt-1 flex items-center gap-1">
        {#if renamable(h) && editing !== h.id}
          <Button variant="ghost" size="sm" class="h-8 px-2 text-muted-foreground hover:border-border" onclick={() => edit(h)} aria-label="Rename {h.name}">
            <Pencil aria-hidden="true" />Rename
          </Button>
        {/if}
        <div class="ml-auto flex items-center gap-1">
          {#if onupdate && h.status === "ok" && components(h, latest).some((c) => c.outdated)}
            <!-- The badge on the chip shows that a component is behind. This button updates the service and the client of the node. -->
            <Button variant="ghost" size="sm" class="h-8 px-2 text-warning hover:border-warning/40 hover:bg-warning/10 hover:text-warning" disabled={updating === h.id} onclick={() => confirm(`Update ${h.name}? The update replaces the service and the client of this node.`) && update(h)} aria-label="Update {h.name}">
              <ArrowUp aria-hidden="true" />{updating === h.id ? "Updating..." : "Update"}
            </Button>
          {/if}
          <!-- One button for the state of the node in the app: Active (the node in use), Use (it can be used), or Unavailable (it is not running). -->
          <Button variant="ghost" size="sm" class={cn("h-8 min-w-24 px-2 hover:border-border", h.id === selected && "text-primary disabled:opacity-100")} disabled={h.id === selected || h.status !== "ok"} onclick={() => onselect(h.id)} aria-pressed={h.id === selected}>
            {#if h.id === selected}<Check aria-hidden="true" />Active{:else if h.status === "ok"}<Circle aria-hidden="true" />Use{:else}<Circle aria-hidden="true" />Unavailable{/if}
          </Button>
        </div>
      </div>
    </li>
  {/each}
</ul>

<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import ArrowUp from "@tabler/icons-svelte/icons/circle-arrow-up";
  import Circle from "@tabler/icons-svelte/icons/circle";
  import Close from "@tabler/icons-svelte/icons/x";
  import Check from "@tabler/icons-svelte/icons/circle-check";
  import Pencil from "@tabler/icons-svelte/icons/pencil";
  import EntityCard from "#lib/components/EntityCard.svelte";
  import StatusDot from "#lib/components/StatusDot.svelte";
  import Pill from "#lib/components/Pill.svelte";
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

  const hasContent = (h: HostInfo) => h.status === "ok" || (editing === h.id && !!error) || !!updateError[h.id] || !!h.error;
</script>

<ul class="m-0 grid list-none gap-3 p-0" aria-label="Nodes">
  {#each hosts as h (h.id)}
    {#snippet title()}{h.name}{/snippet}
    {#snippet titleEditor()}
      <form id="rename-{h.id}" class="flex min-w-0 flex-1 basis-32" onsubmit={(e) => { e.preventDefault(); void save(h); }}>
        <!-- svelte-ignore a11y_autofocus -->
        <input autofocus bind:value={draft} maxlength="64" aria-label="Node name" class="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-base font-semibold" onkeydown={(e) => e.key === "Escape" && (editing = null)} />
      </form>
    {/snippet}
    <!-- The hub is the special node, so its pill has the primary tone. An agent has the plain pill. -->
    {#snippet titleAside()}<Pill tone={roleOf(h) === "hub" ? "primary" : "default"}>{roleOf(h)}</Pill>{/snippet}
    <!-- The health of the node is a plain dot: green (ok), orange (restarting) or red (any other status). The status is the tooltip and the label for a screen reader. -->
    {#snippet status()}
      <StatusDot tone={h.status === "ok" ? "ok" : h.status === "restarting" ? "warn" : "bad"} label="Status: {h.status}" />
    {/snippet}
    <!-- One pill for each component, with its update badge, then the error texts. -->
    {#snippet content()}
      {#if h.status === "ok"}
        {#each components(h, latest) as c (c.key)}
          <Pill>
            {c.text}
            {#if c.outdated}
              <span class="size-2 flex-none rounded-full bg-warning" title="Update available" role="img" aria-label="Update available for the {c.key}"></span>
            {/if}
          </Pill>
        {/each}
      {/if}
      {#if editing === h.id && error}<span class="w-full text-xs text-destructive" role="alert">{error}</span>{/if}
      {#if updateError[h.id]}<span class="w-full text-xs text-destructive" role="alert">{updateError[h.id]}</span>{/if}
      {#if h.status !== "ok" && h.error}
        <span class="w-full text-xs text-muted-foreground [overflow-wrap:anywhere]">{h.error}</span>
      {/if}
    {/snippet}
    {#snippet actions()}
      {#if editing === h.id}
        <Button type="button" variant="ghost" size="sm" class="h-8 px-2 text-muted-foreground hover:border-border" onclick={() => (editing = null)} aria-label="Cancel rename">
          <Close aria-hidden="true" />Cancel
        </Button>
      {:else}
        <Button variant="ghost" size="sm" class="h-8 px-2 text-muted-foreground hover:border-border" onclick={() => edit(h)} aria-label="Rename {h.name}">
          <Pencil aria-hidden="true" />Rename
        </Button>
      {/if}
    {/snippet}
    {#snippet actionsEnd()}
      {#if editing === h.id}
        <Button type="submit" form="rename-{h.id}" variant="ghost" size="sm" class="h-8 px-2 text-primary hover:border-border" disabled={saving} aria-label="Save name">
          <Check aria-hidden="true" />Save
        </Button>
      {:else}
        {#if onupdate && h.status === "ok" && components(h, latest).some((c) => c.outdated)}
          <!-- The yellow dot on the pill shows that a component is behind. This button updates the service and the client of the node. -->
          <Button variant="ghost" size="sm" class="h-8 px-2 text-warning hover:border-warning/40 hover:bg-warning/10 hover:text-warning" disabled={updating === h.id} onclick={() => confirm(`Update ${h.name}? The update replaces the service and the client of this node.`) && update(h)} aria-label="Update {h.name}">
            <ArrowUp aria-hidden="true" />{updating === h.id ? "Updating..." : "Update"}
          </Button>
        {/if}
        <!-- One button for the state of the node in the app: Active (the node in use), Use (it can be used), or Unavailable (it is not running). -->
        <Button variant="ghost" size="sm" class={cn("h-8 min-w-24 px-2 hover:border-border", h.id === selected && "text-primary disabled:opacity-100")} disabled={h.id === selected || h.status !== "ok"} onclick={() => onselect(h.id)} aria-pressed={h.id === selected}>
          {#if h.id === selected}<Check aria-hidden="true" />Active{:else if h.status === "ok"}<Circle aria-hidden="true" />Use{:else}<Circle aria-hidden="true" />Unavailable{/if}
        </Button>
      {/if}
    {/snippet}
    <li class="min-w-0">
      <EntityCard
        {title}
        titleText={h.name}
        titleEditor={editing === h.id ? titleEditor : undefined}
        {titleAside}
        {status}
        selected={h.id === selected}
        children={hasContent(h) ? content : undefined}
        actions={editing === h.id || renamable(h) ? actions : undefined}
        {actionsEnd}
      />
    </li>
  {/each}
</ul>

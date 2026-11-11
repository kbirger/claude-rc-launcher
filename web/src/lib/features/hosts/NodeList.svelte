<script lang="ts">
  import type { Snippet } from "svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import type { HostInfo } from "./api";
  import { versionsText } from "./nodeline";

  // `actions` draws the per-node commands (later: unpair and more) so this list does not need to know them.
  let { hosts, selected, onselect, actions }: { hosts: HostInfo[]; selected: string; onselect: (id: string) => void; actions?: Snippet<[HostInfo]> } = $props();
</script>

<ul class="m-0 grid list-none gap-3 p-0" aria-label="Nodes">
  {#each hosts as h (h.id)}
    <li class="rounded-xl border bg-card p-3 {h.id === selected ? 'border-primary' : ''}">
      <div class="flex items-center justify-between gap-2">
        <span class="font-medium [overflow-wrap:anywhere]">{h.name}</span>
        <span class="rounded-full border px-2.5 py-0.5 text-xs {h.status === 'ok' ? 'text-success' : h.status === 'restarting' ? 'text-warning' : 'text-destructive'}">{h.status}</span>
      </div>
      {#if h.status === "ok"}
        <div class="mt-1 text-sm text-muted-foreground">{versionsText(h)}</div>
        {#if h.stale}<div class="text-sm text-warning">Out of date{h.target ? `, latest ${h.target}` : ""}</div>{/if}
      {:else if h.error}
        <div class="mt-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">{h.error}</div>
      {/if}
      <div class="mt-2 flex flex-wrap gap-2">
        <Button variant={h.id === selected ? "secondary" : "outline"} size="touch" disabled={h.id === selected || h.status !== "ok"} onclick={() => onselect(h.id)}>
          {h.id === selected ? "Active" : "Use this node"}
        </Button>
        {@render actions?.(h)}
      </div>
    </li>
  {/each}
</ul>

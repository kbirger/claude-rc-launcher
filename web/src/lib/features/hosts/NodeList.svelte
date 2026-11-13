<script lang="ts">
  import type { Snippet } from "svelte";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { cn } from "#lib/utils.js";
  import type { HostInfo } from "./api";
  import { isOutdated, versionsText } from "./nodeline";

  // `actions` draws the per-node commands (later: unpair and more) so this list does not need to know them.
  // `latest` is the newest release; a node behind it (or behind the hub) gets the update badge.
  let { hosts, selected, onselect, actions, latest }: { hosts: HostInfo[]; selected: string; onselect: (id: string) => void; actions?: Snippet<[HostInfo]>; latest?: string } = $props();
</script>

<ul class="m-0 grid list-none gap-2 p-0" aria-label="Nodes">
  {#each hosts as h (h.id)}
    {@const outdated = h.status === "ok" && isOutdated(h, latest)}
    <li class={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border bg-card px-3 py-2", h.id === selected && "border-primary")}>
      <div class="flex min-w-0 flex-1 basis-40 flex-col gap-1">
        <div class="flex items-center gap-2">
          <span class="min-w-0 font-semibold [overflow-wrap:anywhere]">{h.name}</span>
          <Badge variant={h.status === "ok" || h.status === "restarting" ? "outline" : "destructive"} class={h.status === "ok" ? "text-success" : h.status === "restarting" ? "text-warning" : ""}>{h.status}</Badge>
        </div>
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

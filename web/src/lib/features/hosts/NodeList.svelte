<script lang="ts">
  import type { Snippet } from "svelte";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Card from "#lib/components/ui/card/index.js";
  import { cn } from "#lib/utils.js";
  import type { HostInfo } from "./api";
  import { versionsText } from "./nodeline";

  // `actions` draws the per-node commands (later: unpair and more) so this list does not need to know them.
  let { hosts, selected, onselect, actions }: { hosts: HostInfo[]; selected: string; onselect: (id: string) => void; actions?: Snippet<[HostInfo]> } = $props();
</script>

<ul class="m-0 grid list-none gap-3 p-0" aria-label="Nodes">
  {#each hosts as h (h.id)}
    <li>
      <Card.Root size="sm" class={cn("gap-2", h.id === selected && "ring-primary")}>
        <Card.Header>
          <Card.Title class="text-base font-semibold [overflow-wrap:anywhere]">{h.name}</Card.Title>
          <Card.Action>
            <Badge variant={h.status === "ok" || h.status === "restarting" ? "outline" : "destructive"} class={h.status === "ok" ? "text-success" : h.status === "restarting" ? "text-warning" : ""}>{h.status}</Badge>
          </Card.Action>
        </Card.Header>
        <Card.Content class="grid gap-2">
          {#if h.status === "ok"}
            <div class="grid gap-0.5">
              <div class="text-muted-foreground">{versionsText(h)}</div>
              {#if h.stale}<div class="text-warning">Out of date{h.target ? `, latest ${h.target}` : ""}</div>{/if}
            </div>
          {:else if h.error}
            <div class="text-muted-foreground [overflow-wrap:anywhere]">{h.error}</div>
          {/if}
          <div class="flex flex-wrap gap-2">
            <Button variant={h.id === selected ? "secondary" : "outline"} size="touch" disabled={h.id === selected || h.status !== "ok"} onclick={() => onselect(h.id)}>
              {h.id === selected ? "Active" : "Use this node"}
            </Button>
            {@render actions?.(h)}
          </div>
        </Card.Content>
      </Card.Root>
    </li>
  {/each}
</ul>

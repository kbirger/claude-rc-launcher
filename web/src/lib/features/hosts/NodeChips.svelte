<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import type { HostInfo } from "./api";

  // The nodes that the Sessions and Instances views show. Nothing selected means all nodes. A node that does not answer stays on the row: its status is in the text.
  let { hosts, selected, ontoggle, onclear }: { hosts: HostInfo[]; selected: string[]; ontoggle: (id: string) => void; onclear: () => void } = $props();
</script>

{#if hosts.length > 1}
  <div class="flex flex-wrap gap-2" role="group" aria-label="Nodes">
    <Button variant={selected.length === 0 ? "default" : "outline"} size="touch" class="rounded-full" aria-pressed={selected.length === 0} onclick={onclear}>All</Button>
    {#each hosts as h (h.id)}
      {@const on = selected.includes(h.id)}
      <Button variant={on ? "default" : "outline"} size="touch" class={`rounded-full ${h.status === "ok" ? "" : "text-muted-foreground"}`} aria-pressed={on} onclick={() => ontoggle(h.id)}>
        {h.name}{#if h.status !== "ok"}<span class="text-xs font-normal">{h.status}</span>{/if}
      </Button>
    {/each}
  </div>
{/if}

<script lang="ts">
  import { Label } from "#lib/components/ui/label/index.js";
  import type { HostInfo } from "../hosts";
  import { hostLabel } from "./hostlabel";

  // The checkbox list of nodes that can reach a target. The wizard and the node editor of the target list both use it.
  let {
    nodes,
    hosts,
    picked = $bindable(),
    legend = "Nodes that can reach the target",
    off = [],
  }: {
    /** The host ids that are offered: the nodes that have SSH access turned on. */
    nodes: string[];
    hosts: HostInfo[] | undefined;
    picked: string[];
    legend?: string;
    /** Host ids that are offered although their access is off, so that the owner can take them out of the list. */
    off?: string[];
  } = $props();
</script>

<fieldset class="grid gap-2">
  <legend class="text-sm font-medium">{legend}</legend>
  {#each [...nodes, ...off.filter((host) => !nodes.includes(host))] as host (host)}
    <Label class="flex min-h-11 items-center gap-3 rounded-lg border p-3">
      <input type="checkbox" value={host} bind:group={picked} />
      <span class="min-w-0 [overflow-wrap:anywhere]">
        {hostLabel(host, hosts)}{#if !nodes.includes(host)}
          <span class="text-xs font-normal text-muted-foreground"> (access is off)</span>{/if}
      </span>
    </Label>
  {:else}
    <p class="text-sm text-muted-foreground">No node has SSH access turned on. Turn one on in the list of nodes.</p>
  {/each}
</fieldset>

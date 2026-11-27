<script lang="ts">
  import { Checkbox } from "#lib/components/ui/checkbox/index.js";
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

  const shown = $derived([...nodes, ...off.filter((host) => !nodes.includes(host))]);

  // The list keeps the order of the shown nodes, whatever the order of the clicks: it goes into the request as it is.
  // A picked host that is not shown drops out, as with a group of native checkboxes.
  function toggle(host: string, checked: boolean) {
    picked = shown.filter((item) => (item === host ? checked : picked.includes(item)));
  }
</script>

<fieldset class="grid gap-2">
  <legend class="text-sm font-medium">{legend}</legend>
  {#each shown as host (host)}
    <Label class="flex min-h-11 items-center gap-3 rounded-lg border p-3">
      <Checkbox
        data-value={host}
        checked={picked.includes(host)}
        onCheckedChange={(checked) => toggle(host, checked)}
      />
      <span class="min-w-0 [overflow-wrap:anywhere]">
        {hostLabel(host, hosts)}{#if !nodes.includes(host)}
          <span class="text-xs font-normal text-muted-foreground"> (access is off)</span>{/if}
      </span>
    </Label>
  {:else}
    <p class="text-sm text-muted-foreground">No node has SSH access turned on. Turn one on in the list of nodes.</p>
  {/each}
</fieldset>

<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import { NodeFilter, inFilter } from "#lib/features/hosts";
  import { InstanceList } from "#lib/features/instances";
  import { getShell } from "#lib/shell/context";

  const shell = getShell();
  // No chip selected means all nodes.
  const shown = $derived(shell.hosts.filter((h) => inFilter(shell.nodes.selected, h.id)));
  // "+ New" starts on the node of the one selected chip. With none or several selected, the dialog asks.
  function openNew() {
    if (shell.nodes.selected.length === 1) shell.flow.pick(shell.nodes.selected[0]!);
    shell.flow.openNew();
  }
</script>

<h2 class="font-heading mb-3 text-lg font-bold">Instances</h2>
<div class="mb-4 flex gap-2">
  {#if shell.hosts.length > 1}<div class="min-w-0 max-w-[50%] shrink-0"><NodeFilter hosts={shell.hosts} selected={shell.nodes.selected} ontoggle={shell.nodes.toggle} onclear={shell.nodes.clear} /></div>{/if}
  {#if shell.can("write")}<Button size="touch" class="min-w-0 flex-1" onclick={openNew}>+ New</Button>{/if}
</div>
{#each shown as h (h.id)}
  {#if shown.length > 1}<h3 class="font-heading mt-4 mb-2 text-base font-bold [overflow-wrap:anywhere]">{h.name}</h3>{/if}
  <InstanceList host={h.id} startError={h.id === shell.flow.selected ? shell.flow.startError : ""} canWrite={shell.can("write")} />
{/each}

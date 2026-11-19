<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import { NodeChips, inFilter } from "#lib/features/hosts";
  import { InstanceList } from "#lib/features/instances";
  import { getShell } from "#lib/shell/context";

  const shell = getShell();
  // No chip selected means all nodes.
  const shown = $derived(shell.hosts.filter((h) => inFilter(shell.nodes.selected, h.id)));
  // "+ New" starts on the node of the one selected chip. With none or several selected, the dialog asks.
  function openNew() {
    if (shell.nodes.selected.length === 1) shell.select(shell.nodes.selected[0]!);
    shell.flow.openNew();
  }
</script>

<div class="mb-4 grid gap-3">
  <NodeChips hosts={shell.hosts} selected={shell.nodes.selected} ontoggle={shell.nodes.toggle} onclear={shell.nodes.clear} />
  {#if shell.can("write")}<Button size="touch" class="w-full" onclick={openNew}>+ New</Button>{/if}
</div>
{#each shown as h (h.id)}
  {#if shown.length > 1}<h2 class="font-heading mt-4 mb-2 text-lg font-bold">{h.name}</h2>{/if}
  <InstanceList host={h.id} startError={h.id === shell.flow.selected ? shell.flow.startError : ""} canWrite={shell.can("write")} />
{/each}

<script lang="ts">
  import { goto } from "$app/navigation";
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { NodeList, renameHostMutation } from "#lib/features/hosts";
  import { UpdateOutput, lastEntry, showsFinishedPanel, updateHostMutation } from "#lib/features/updates";
  import { ApiError } from "#lib/shared/http";
  import { getShell } from "#lib/shell/context";

  const shell = getShell();
  const rename = createMutation(() => renameHostMutation(useQueryClient()));
  const update = createMutation(() => updateHostMutation(useQueryClient()));
  // The hub answers 202 and then restarts, so a lost connection right after the hub call is expected and is not an error.
  async function updateNode(h: { id: string; target?: string }) {
    try {
      await update.mutateAsync({ host: h.id, release: h.id === "local" ? undefined : h.target ?? latest });
    } catch (e) {
      if (!(h.id === "local" && !(e instanceof ApiError))) throw e;
    }
  }
  // The latest release is the same for every machine: the hub reports it as the target.
  const latest = $derived(shell.hosts.find((h) => h.id === "local")?.target ?? shell.hosts.find((h) => h.target)?.target);
</script>

<h2 class="font-heading mb-3 text-lg font-bold">Nodes</h2>
<!-- A tap on a node shows the instances of that node. -->
<NodeList hosts={shell.hosts} onselect={(id) => { shell.nodes.only(id); void goto("/instances"); }} {latest} onrename={shell.can("write") ? (id, name) => rename.mutateAsync({ id, name }) : undefined} onupdate={shell.can("admin") ? updateNode : undefined} />
{#each shell.hosts as h (h.id)}
  {#if showsFinishedPanel(lastEntry(shell.updates, h.id))}
    <div class="mt-3"><UpdateOutput host={h.id} open={false} /></div>
  {/if}
{/each}

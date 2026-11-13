<script lang="ts">
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { NodeList, renameHostMutation } from "#lib/features/hosts";
  import { updateHostMutation } from "#lib/features/updates";
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

<h2 class="mt-0 text-lg">Nodes</h2>
<NodeList hosts={shell.hosts} selected={shell.flow.selected} onselect={shell.select} {latest} onrename={(id, name) => rename.mutateAsync({ id, name })} onupdate={updateNode} />

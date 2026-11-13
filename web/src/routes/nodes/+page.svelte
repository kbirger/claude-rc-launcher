<script lang="ts">
  import { NodeList } from "#lib/features/hosts";
  import { getShell } from "#lib/shell/context";

  const shell = getShell();
  // The latest release is the same for every machine: the hub reports it as the target.
  const latest = $derived(shell.hosts.find((h) => h.id === "local")?.target ?? shell.hosts.find((h) => h.target)?.target);
</script>

<h2 class="mt-0 text-lg">Nodes</h2>
<NodeList hosts={shell.hosts} selected={shell.flow.selected} onselect={shell.select} {latest} />

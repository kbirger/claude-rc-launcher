<script lang="ts">
  import { UpdateHistory } from "#lib/features/updates";
  import { getShell } from "#lib/shell/context";

  const shell = getShell();
  const names = $derived(Object.fromEntries(shell.hosts.map((h) => [h.id, h.name])));
</script>

<!-- Every update of every machine, newest first, with its output. -->
<UpdateHistory {names} />

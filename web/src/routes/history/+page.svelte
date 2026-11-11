<script lang="ts">
  import { UpdateHistory } from "#lib/features/updates";
  import { getShell } from "#lib/shell/context";

  const shell = getShell();
</script>

{#key shell.flow.selected}
  <UpdateHistory host={shell.flow.selected} startOpen />
{/key}

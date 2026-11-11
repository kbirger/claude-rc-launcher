<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import { InstanceList } from "#lib/features/instances";
  import { getShell } from "#lib/shell/context";

  const shell = getShell();
</script>

<Button size="touch" class="mb-4 w-full" onclick={() => shell.flow.openNew()}>+ New</Button>
{#key shell.flow.selected}
  <InstanceList host={shell.flow.selected} startError={shell.flow.startError} />
{/key}

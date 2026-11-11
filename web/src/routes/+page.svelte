<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import { HubVersionLine } from "#lib/features/hosts";
  import { InstanceList } from "#lib/features/instances";
  import { getShell } from "#lib/shell/context";

  const shell = getShell();
</script>

<HubVersionLine hub={shell.hosts.find((h) => h.id === "local")} />
<Button size="touch" class="mb-4 w-full" onclick={() => shell.flow.openNew()}>+ New</Button>
{#key shell.flow.selected}
  <InstanceList host={shell.flow.selected} startError={shell.flow.startError} />
{/key}

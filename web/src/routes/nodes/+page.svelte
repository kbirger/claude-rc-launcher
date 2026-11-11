<script lang="ts">
  import { NodeList } from "#lib/features/hosts";
  import { getShell } from "#lib/shell/context";

  const shell = getShell();
</script>

<h2 class="mt-0 text-lg">Nodes</h2>
<NodeList hosts={shell.hosts} selected={shell.flow.selected} onselect={shell.select} />

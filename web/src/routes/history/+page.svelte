<script lang="ts">
  import ArrowLeft from "@tabler/icons-svelte/icons/arrow-left";
  import { Button } from "#lib/components/ui/button/index.js";
  import { UpdateHistory } from "#lib/features/updates";
  import { getShell } from "#lib/shell/context";

  const shell = getShell();
  const names = $derived(Object.fromEntries(shell.hosts.map((h) => [h.id, h.name])));
</script>

<Button variant="ghost" size="sm" class="-ml-2 mb-1 h-8 w-fit px-2 text-muted-foreground hover:border-border" href="/updates"><ArrowLeft aria-hidden="true" />Back to updates</Button>
<h2 class="mt-0 text-lg">Update history</h2>

<!-- Every update of every machine, newest first, with its output. -->
<UpdateHistory {names} />

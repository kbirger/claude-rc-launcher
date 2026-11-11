<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { UpdateBanner } from "#lib/features/updates";
  import { getShell } from "#lib/shell/context";

  const shell = getShell();
  // The notice on the other pages sends `?start=hub` or `?start=nodes`. Read it once. After the update has started,
  // the address loses it, so a reload does not start the update again.
  const asked = page.url.searchParams.get("start");
  const start = asked === "hub" || asked === "nodes" ? asked : undefined;
</script>

<UpdateBanner full hosts={shell.hosts} updates={shell.updates} latestError={shell.latestError} {start} onstarted={() => goto("/updates", { replaceState: true })} />

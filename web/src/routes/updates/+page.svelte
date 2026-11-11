<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { UpdateBanner, UpdateHistory } from "#lib/features/updates";
  import { getShell } from "#lib/shell/context";

  const shell = getShell();
  const names = $derived(Object.fromEntries(shell.hosts.map((h) => [h.id, h.name])));
  // The notice on the other pages sends `?start=hub` or `?start=nodes`. Read it once. After the update has started,
  // the address loses it, so a reload does not start the update again.
  const asked = page.url.searchParams.get("start");
  const start = asked === "hub" || asked === "nodes" ? asked : undefined;
</script>

<UpdateBanner full hosts={shell.hosts} updates={shell.updates} latestError={shell.latestError} {start} onstarted={() => goto("/updates", { replaceState: true })} />

<!-- A finished update leaves the panel above, so its output stays here. -->
<div class="mt-4 flex items-baseline justify-between">
  <h2 class="m-0 text-sm font-semibold">Recent updates</h2>
  <a class="text-sm text-primary underline-offset-4 hover:underline" href="/history">All history</a>
</div>
<div class="mt-2"><UpdateHistory {names} limit={3} /></div>

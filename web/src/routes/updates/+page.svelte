<script lang="ts">
  import { tick } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { UpdateBanner, UpdateHistory } from "#lib/features/updates";
  import { mockState, type MockName } from "#lib/features/updates/mock";
  import { bannerModel } from "#lib/features/updates/updatebanner";
  import UpdateMascot from "#lib/features/updates/UpdateMascot.svelte";
  import UpdateMockPanel from "#lib/features/updates/UpdateMockPanel.svelte";
  import { getShell } from "#lib/shell/context";

  const shell = getShell();
  // TEMPORARY: open /updates?mock to get the mock panel. A picked state replaces the live data on this page only.
  const mockable = page.url.searchParams.has("mock");
  let mock = $state<(ReturnType<typeof mockState> & { name: MockName }) | null>(null);
  // Clearing first lets a second click on the same state run its animation again.
  async function pick(name: MockName | null) {
    mock = null;
    await tick();
    if (name) mock = { name, ...mockState(name) };
  }
  const hosts = $derived(mock?.hosts ?? shell.hosts);
  const updates = $derived(mock?.updates ?? shell.updates);

  const names = $derived(Object.fromEntries(shell.hosts.map((h) => [h.id, h.name])));
  const updating = $derived(bannerModel({ hosts, updates, latestError: shell.latestError, now: shell.now }).some((i) => i.kind === "updating"));
  // An update that finished well in the last 30 seconds is worth a celebration.
  const celebrating = $derived(!updating && updates.some((e) => e.status === "updated" && e.finishedAt !== undefined && shell.now.getTime() - Date.parse(e.finishedAt) <= 30_000));
  // The notice on the other pages sends `?start=hub` or `?start=nodes`. Read it once. After the update has started,
  // the address loses it, so a reload does not start the update again.
  const asked = page.url.searchParams.get("start");
  const start = asked === "hub" || asked === "nodes" ? asked : undefined;
</script>

{#if mockable}<UpdateMockPanel value={mock?.name ?? null} onpick={pick} />{/if}

<div class="mb-2 flex justify-center"><UpdateMascot active={updating} celebrate={celebrating} /></div>

<UpdateBanner
  full
  {hosts}
  {updates}
  latestError={shell.latestError}
  start={mock ? undefined : start}
  onstarted={() => goto(mockable ? "/updates?mock" : "/updates", { replaceState: true })}
  onrun={mock ? () => pick("started") : undefined}
/>

<!-- A finished update leaves the panel above, so its output stays here. -->
<div class="mt-4 flex items-baseline justify-between">
  <h2 class="m-0 text-sm font-semibold">Recent updates</h2>
  <a class="text-sm text-primary underline-offset-4 hover:underline" href="/history">All history</a>
</div>
<div class="mt-2"><UpdateHistory {names} limit={3} /></div>

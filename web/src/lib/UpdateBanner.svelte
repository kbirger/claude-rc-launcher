<script lang="ts">
  import { onMount } from "svelte";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { ApiError, updateHost, type HostInfo, type UpdateEntry } from "./api";
  import UpdateOutput from "./UpdateOutput.svelte";
  import { panelOpenByDefault } from "./updateoutput";
  import { windowsNames } from "./updatewarn";
  import { bannerKey, bannerModel, isRunning, lastEntry, mergeCallErrors, pruneCallErrors, type BannerItem, type CallError } from "./updatebanner";

  let { hosts, updates, latestError }: { hosts: HostInfo[]; updates: UpdateEntry[]; latestError: boolean } = $props();

  const client = useQueryClient();
  let busy = $state(false);
  // Errors of update calls made from this page, by host name; they stay until the next call for that host succeeds.
  let callErrors = $state<Record<string, CallError>>({});
  let dismissed = $state("");
  let now = $state(new Date());

  onMount(() => {
    const t = setInterval(() => (now = new Date()), 30_000);
    return () => clearInterval(t);
  });

  const nameOf = (id: string) => hosts.find((h) => h.id === id)?.name ?? id;
  const items = $derived<BannerItem[]>(mergeCallErrors(bannerModel({ hosts, updates, latestError, now }), callErrors));
  $effect(() => {
    const next = pruneCallErrors(callErrors, hosts, updates, now);
    if (Object.keys(next).length !== Object.keys(callErrors).length) callErrors = next;
  });
  const key = $derived(items.map(bannerKey).join("|"));
  const actionable = $derived(items.some((i) => i.kind !== "latest-unknown" && i.kind !== "hub-local-build" && i.kind !== "updating"));

  async function run(id: string, release?: string) {
    const name = nameOf(id);
    try {
      await updateHost(id, release);
      delete callErrors[name];
    } catch (e) {
      // The hub answers 202 and then restarts: a lost connection right after the hub call is expected.
      if (id === "local" && !(e instanceof ApiError)) delete callErrors[name];
      else callErrors[name] = { error: e instanceof Error ? e.message : String(e), at: Date.now() };
    } finally {
      void client.invalidateQueries({ queryKey: ["hosts"] });
      void client.invalidateQueries({ queryKey: ["updates"] });
    }
  }

  async function updateHub() {
    busy = true;
    try {
      await run("local");
    } finally {
      busy = false;
    }
  }

  async function updateNodes(list: { id: string; target: string }[]) {
    busy = true;
    try {
      for (const n of list) if (!isRunning(lastEntry(updates, n.id), new Date())) await run(n.id, n.target);
    } finally {
      busy = false;
    }
  }
</script>

{#if items.length && dismissed !== key}
  <section class="banner" role={actionable ? "alert" : "status"} aria-label="Updates">
    <ul>
      {#each items as item, i (bannerKey(item) + ":" + i)}
        <li class:warn={item.kind !== "latest-unknown" && item.kind !== "hub-local-build" && item.kind !== "updating"}>
          {#if item.kind === "hub-update"}
            <span>The hub is out of date. Latest release: {item.target}.</span>
            <button class="primary" disabled={busy} onclick={updateHub}>Update hub</button>
          {:else if item.kind === "updating"}
            <span>Updating {item.name}{item.step ? `: ${item.step}` : "..."}</span>
            <UpdateOutput host={item.host} open={panelOpenByDefault(lastEntry(updates, item.host))} />
          {:else if item.kind === "node-update"}
            <span>Out of date: {item.hosts.map((h) => h.name).join(", ")}.{#if windowsNames(item.hosts, hosts).length} The update restarts the sessions on {windowsNames(item.hosts, hosts).join(", ")}.{/if}</span>
            <button class="primary" disabled={busy} onclick={() => updateNodes(item.hosts)}>Update all nodes</button>
          {:else if item.kind === "hub-local-build"}
            <span class="muted">The hub runs a local build. Its version cannot be compared.</span>
          {:else if item.kind === "by-hand"}
            <span>{item.host}: {item.message}.</span>
          {:else if item.kind === "offline-after-hub-update"}
            <span>The hub was just updated. Offline now: {item.hosts.join(", ")}. They may still be restarting.</span>
          {:else if item.kind === "failed"}
            <span>Update of {item.host} failed: {item.error}</span>
            {#if item.id}<UpdateOutput host={item.id} open={panelOpenByDefault(lastEntry(updates, item.id))} />{/if}
          {:else}
            <span class="muted">Could not check for the latest release.</span>
          {/if}
        </li>
      {/each}
    </ul>
    <button class="dismiss" aria-label="Dismiss" onclick={() => (dismissed = key)}>Dismiss</button>
  </section>
{/if}

<style>
  .banner { display: flex; align-items: flex-start; gap: 12px; padding: 8px 16px; background: var(--surface); border-bottom: 1px solid var(--border); }
  ul { flex: 1; list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  li { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-height: 44px; }
  li.warn { border-left: 3px solid var(--warn); padding-left: 8px; }
  .dismiss { flex: none; }
</style>

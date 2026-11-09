<script lang="ts">
  import { onMount } from "svelte";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { getMe, type HostInfo, type Me } from "./lib/api";
  import { connectEvents } from "./lib/events";
  import { hostsQuery, latestQuery, updatesQuery } from "./lib/queries";
  import HubVersionLine from "./lib/HubVersionLine.svelte";
  import UpdateBanner from "./lib/UpdateBanner.svelte";
  import HostPicker from "./lib/HostPicker.svelte";
  import InstanceList from "./lib/InstanceList.svelte";
  import NewDialog from "./lib/NewDialog.svelte";

  const HOST_KEY = "claude-rc-host";

  // sessionStorage can be missing or throw (private windows, blocked storage); the UI must work without it.
  function remembered(): string {
    try {
      return sessionStorage.getItem(HOST_KEY) ?? "local";
    } catch {
      return "local";
    }
  }
  function remember(id: string) {
    try {
      sessionStorage.setItem(HOST_KEY, id);
    } catch {}
  }

  let me = $state<Me | null>(null);
  const client = useQueryClient();
  const hostsQ = createQuery(hostsQuery);
  const latestQ = createQuery(latestQuery);
  const updatesQ = createQuery(updatesQuery);
  const hosts = $derived<HostInfo[]>(hostsQ.data ?? [{ id: "local", name: "local", status: "ok" }]);
  let selected = $state(remembered());
  let showNew = $state(false);
  let refreshKey = $state(0);

  // A remembered or previously selected host that is gone or unavailable falls back to local.
  $effect(() => {
    if (!hostsQ.data) return;
    const cur = hostsQ.data.find((h) => h.id === selected);
    if (!cur || cur.status !== "ok") selected = "local";
  });

  function select(id: string) {
    selected = id;
    remember(id);
    showNew = false;
  }

  onMount(() => {
    getMe().then((m) => (me = m)).catch(() => {});
    return connectEvents({ client });
  });
</script>

<header>
  <h1>Claude RC</h1>
  {#if hosts.length > 1}
    <HostPicker {hosts} {selected} onselect={select} />
  {/if}
  <span class="user">{me?.name ?? ""}</span>
  <a class="logout" href={me?.logoutUrl ?? "/auth/logout"}>Logout</a>
</header>
<UpdateBanner {hosts} updates={updatesQ.data ?? []} latestError={latestQ.isError} />
<main>
  <HubVersionLine hub={hosts.find((h) => h.id === "local")} />
  <button class="primary new" onclick={() => (showNew = true)}>+ New</button>
  {#key selected}
    <InstanceList host={selected} {refreshKey} />
  {/key}
</main>
{#if showNew}
  {#key selected}
    <NewDialog
      host={selected}
      onclose={() => (showNew = false)}
      onstarted={() => {
        showNew = false;
        refreshKey++;
      }}
    />
  {/key}
{/if}

<style>
  header { display: flex; align-items: center; gap: 12px; padding: 8px 16px; background: var(--surface); border-bottom: 1px solid var(--border); }
  h1 { font-size: 1.1rem; margin: 0; flex: 1; }
  .user { color: var(--muted); font-size: 0.9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .logout { display: inline-flex; align-items: center; min-height: 44px; padding: 0 8px; color: var(--accent); }
  main { max-width: 720px; margin: 0 auto; padding: 16px; }
  .new { width: 100%; margin-bottom: 16px; }
  @media (max-width: 480px) {
    .user { display: none; }
  }
</style>

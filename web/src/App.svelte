<script lang="ts">
  import { onMount } from "svelte";
  import LogOut from "@lucide/svelte/icons/log-out";
  import Logo from "./shared/ui/Logo.svelte";
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { meQuery } from "./features/auth";
  import { connectEvents } from "./realtime/events";
  import { HostPicker, HubVersionLine, hostsQuery, selectionAfter, type HostInfo } from "./features/hosts";
  import { UpdateBanner, UpdateHistory, UpdateOutput, busyReason, lastEntry, latestQuery, reloadDecision, showsFinishedPanel, updatesQuery } from "./features/updates";
  import { InstanceList, startInstanceMutation, type StartArgs } from "./features/instances";
  import { NewDialog, startErrorAction } from "./features/new-instance";
  import { createStartFlow } from "./startflow.svelte";

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

  const client = useQueryClient();
  const meQ = createQuery(meQuery);
  const hostsQ = createQuery(hostsQuery);
  const latestQ = createQuery(latestQuery);
  const updatesQ = createQuery(updatesQuery);
  const hosts = $derived<HostInfo[]>(hostsQ.data ?? [{ id: "local", name: "local", status: "ok" }]);
  const flow = createStartFlow(remembered());
  let now = $state(new Date());

  // The start lives here, not in the dialog, so it outlives the dialog. The callbacks sit on the options, not on mutate():
  // each start keeps the options (and so the host) it was built with, even when another start or a host switch follows.
  const startM = createMutation(() => {
    const host = flow.selected;
    return {
      ...startInstanceMutation(host),
      // Awaited by the mutation, so the pending row stays until the list has the new instance.
      onSuccess: () => client.invalidateQueries({ queryKey: ["instances", host] }),
      onError: (e: unknown, a: StartArgs) => flow.startFailed(host, startErrorAction(e, { path: a.path, user: a.user ?? "" }), a),
    };
  });

  function startNew(a: StartArgs) {
    flow.startNew();
    startM.mutate(a);
  }

  // The page code only changes with a reload. When the hub runs another version than the one that served this page, reload
  // (or ask, while the New dialog is open).
  let loadedVersion: string | undefined;
  let reloadBar = $state(false);
  const hubVersion = $derived(hostsQ.data?.find((h) => h.id === "local")?.version);
  $effect(() => {
    const current = hubVersion;
    if (!current || reloadBar) return;
    if (loadedVersion === undefined) {
      loadedVersion = current;
      return;
    }
    const last = Number(sessionStorage.getItem("claude-rc:reload") ?? 0);
    const d = reloadDecision({ loaded: loadedVersion, current, dialogOpen: flow.showNew, lastReloadAt: last, now: Date.now() });
    if (d === "bar") reloadBar = true;
    if (d === "reload") {
      console.info(`[claude-rc] the hub runs ${current}, this page was loaded from ${loadedVersion}: reloading`);
      sessionStorage.setItem("claude-rc:reload", String(Date.now()));
      location.reload();
    }
  });
  const selectedBusy = $derived(busyReason(hosts.find((h) => h.id === flow.selected), lastEntry(updatesQ.data ?? [], flow.selected), now));

  // A remembered or previously selected host that is gone falls back to local. One that is restarting or offline stays.
  $effect(() => {
    if (!hostsQ.data) return;
    flow.fallback(selectionAfter(hostsQ.data, flow.selected));
  });

  function select(id: string) {
    flow.select(id);
    remember(id);
  }

  onMount(() => {
    const t = setInterval(() => (now = new Date()), 30_000);
    const stop = connectEvents({ client });
    return () => {
      clearInterval(t);
      stop();
    };
  });
</script>

<header>
  <h1><Logo /><span class="name">Claude RC</span></h1>
  {#if hosts.length > 1}
    <HostPicker {hosts} selected={flow.selected} updates={updatesQ.data ?? []} {now} onselect={select} />
  {/if}
  <span class="user"><span class="uname">{meQ.data?.name ?? ""}</span></span>
  <a class="logout" href={meQ.data?.logoutUrl ?? "/auth/logout"} aria-label="Logout" title="Logout">
    <LogOut size={22} aria-hidden="true" />
  </a>
</header>
<div class="column">
  {#if reloadBar}
    <section class="reload" role="status">
      <span>The hub was updated. Reload to get the new page.</span>
      <button class="primary" onclick={() => location.reload()}>Reload</button>
    </section>
  {/if}
  <UpdateBanner {hosts} updates={updatesQ.data ?? []} latestError={latestQ.isError} />
  {#if showsFinishedPanel(lastEntry(updatesQ.data ?? [], flow.selected))}
    {#key flow.selected}
      <div class="finished"><UpdateOutput host={flow.selected} open={false} /></div>
    {/key}
  {/if}
  <main>
    <HubVersionLine hub={hosts.find((h) => h.id === "local")} />
    <button class="primary new" onclick={() => flow.openNew()}>+ New</button>
    {#key flow.selected}
      <InstanceList host={flow.selected} startError={flow.startError} />
    {/key}
  </main>
  {#key flow.selected}
    <UpdateHistory host={flow.selected} />
  {/key}
</div>
{#if flow.showNew}
  {#key flow.selected}
    <NewDialog
      host={flow.selected}
      busyReason={selectedBusy}
      initial={flow.newInitial}
      onclose={() => flow.closeNew()}
      onstart={startNew}
    />
  {/key}
{/if}

<style>
  /* One column for everything under the header (the header spans the full width). */
  .column { max-width: 720px; margin: 0 auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .reload { display: flex; align-items: center; gap: 12px; padding: 8px 12px; background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--warn); border-radius: 8px; }
  header { display: flex; align-items: center; gap: 12px; padding: 8px 16px; background: var(--surface); border-bottom: 1px solid var(--border); }
  h1 { display: flex; flex-direction: column; align-items: center; align-self: stretch; min-height: 0; gap: 2px; font-size: 0.7rem; line-height: 1.1; margin: 0; flex: none; }
  .user { display: inline-flex; flex-grow: 0; flex-basis: auto; min-width: 0; margin-left: auto; color: var(--muted); font-size: 0.9rem; }
  .uname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .logout { display: inline-flex; align-items: center; justify-content: center; flex: none; min-width: 44px; min-height: 44px; color: var(--accent); }
  .new { width: 100%; margin-bottom: 16px; }
  @media (max-width: 480px) {
    .name { display: none; }
    h1 { min-width: 44px; }
  }
  @media (max-width: 480px) {
    .user { display: none; }
  }
</style>

<script lang="ts">
  import { onMount } from "svelte";
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { meQuery } from "./features/auth";
  import { connectEvents } from "./realtime/events";
  import { HostPicker, HubVersionLine, hostsQuery, selectionAfter, type HostInfo } from "./features/hosts";
  import { UpdateBanner, UpdateHistory, UpdateOutput, busyReason, lastEntry, latestQuery, reloadDecision, showsFinishedPanel, updatesQuery } from "./features/updates";
  import { InstanceList, startInstanceMutation, type StartArgs } from "./features/instances";
  import { NewDialog, startErrorAction, type TrustPrompt } from "./features/new-instance";

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
  let selected = $state(remembered());
  let now = $state(new Date());
  let showNew = $state(false);
  // Set when a start got a 428 "untrusted": the dialog opens again at that folder with the trust question.
  let newInitial = $state<{ path: string; user?: string; name?: string; trust: TrustPrompt } | undefined>();
  let startError = $state("");
  // NewDialog reads `initial` once. A 428 that comes while the dialog is open bumps this to remount it with the newest prompt.
  let dialogGen = $state(0);

  // The start lives here, not in the dialog, so it outlives the dialog. The callbacks sit on the options, not on mutate():
  // each start keeps the options (and so the host) it was built with, even when another start or a host switch follows.
  const startM = createMutation(() => {
    const host = selected;
    return {
      ...startInstanceMutation(host),
      // Awaited by the mutation, so the pending row stays until the list has the new instance.
      onSuccess: () => client.invalidateQueries({ queryKey: ["instances", host] }),
      onError: (e: unknown, a: StartArgs) => {
        // A failed start belongs to its host: say nothing once the user is on another one.
        if (host !== selected) return;
        const act = startErrorAction(e, { path: a.path, user: a.user ?? "" });
        if (act.kind === "trust") {
          // This prompt replaces the one in the open dialog: say that the displaced folder still needs trust.
          if (showNew && newInitial && newInitial.path !== a.path) startError = `Trust needed for ${newInitial.path}`;
          newInitial = { path: a.path, user: a.user, name: a.name, trust: act.prompt };
          showNew = true;
          dialogGen++;
        } else startError = act.message;
      },
    };
  });

  function startNew(a: StartArgs) {
    showNew = false;
    newInitial = undefined;
    startError = "";
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
    const d = reloadDecision({ loaded: loadedVersion, current, dialogOpen: showNew, lastReloadAt: last, now: Date.now() });
    if (d === "bar") reloadBar = true;
    if (d === "reload") {
      console.info(`[claude-rc] the hub runs ${current}, this page was loaded from ${loadedVersion}: reloading`);
      sessionStorage.setItem("claude-rc:reload", String(Date.now()));
      location.reload();
    }
  });
  const selectedBusy = $derived(busyReason(hosts.find((h) => h.id === selected), lastEntry(updatesQ.data ?? [], selected), now));

  // A remembered or previously selected host that is gone falls back to local. One that is restarting or offline stays.
  $effect(() => {
    if (!hostsQ.data) return;
    const next = selectionAfter(hostsQ.data, selected);
    if (next !== selected) {
      selected = next;
      newInitial = undefined;
      startError = "";
    }
  });

  function select(id: string) {
    selected = id;
    remember(id);
    showNew = false;
    newInitial = undefined;
    startError = "";
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
  <h1><img class="logo" src="/favicon.svg" alt="" /><span class="name">Claude RC</span></h1>
  {#if hosts.length > 1}
    <HostPicker {hosts} {selected} updates={updatesQ.data ?? []} {now} onselect={select} />
  {/if}
  <span class="user"><span class="uname">{meQ.data?.name ?? ""}</span></span>
  <a class="logout" href={meQ.data?.logoutUrl ?? "/auth/logout"} aria-label="Logout" title="Logout">
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></svg>
  </a>
</header>
{#if reloadBar}
  <section class="reload" role="status">
    <span>The hub was updated. Reload to get the new page.</span>
    <button class="primary" onclick={() => location.reload()}>Reload</button>
  </section>
{/if}
<UpdateBanner {hosts} updates={updatesQ.data ?? []} latestError={latestQ.isError} />
{#if showsFinishedPanel(lastEntry(updatesQ.data ?? [], selected))}
  {#key selected}
    <div class="finished"><UpdateOutput host={selected} open={false} /></div>
  {/key}
{/if}
{#key selected}
  <UpdateHistory host={selected} />
{/key}
<main>
  <HubVersionLine hub={hosts.find((h) => h.id === "local")} />
  <button class="primary new" onclick={() => { newInitial = undefined; showNew = true; }}>+ New</button>
  {#key selected}
    <InstanceList host={selected} {startError} />
  {/key}
</main>
{#if showNew}
  {#key `${selected}\n${dialogGen}`}
    <NewDialog
      host={selected}
      busyReason={selectedBusy}
      initial={newInitial}
      onclose={() => {
        showNew = false;
        newInitial = undefined;
      }}
      onstart={startNew}
    />
  {/key}
{/if}

<style>
  .finished { padding: 4px 16px; }
  .reload { display: flex; align-items: center; gap: 12px; padding: 8px 16px; background: var(--surface); border-bottom: 1px solid var(--border); border-left: 3px solid var(--warn); }
  header { display: flex; align-items: center; gap: 12px; padding: 8px 16px; background: var(--surface); border-bottom: 1px solid var(--border); }
  h1 { display: flex; flex-direction: column; align-items: center; align-self: stretch; min-height: 0; gap: 2px; font-size: 0.7rem; line-height: 1.1; margin: 0; flex: none; }
  .logo { flex: 1 1 0; min-height: 0; width: auto; aspect-ratio: 1; object-fit: contain; border-radius: 6px; }
  .user { display: inline-flex; flex-grow: 0; flex-basis: auto; min-width: 0; margin-left: auto; color: var(--muted); font-size: 0.9rem; }
  .uname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .logout { display: inline-flex; align-items: center; justify-content: center; flex: none; min-width: 44px; min-height: 44px; color: var(--accent); }
  main { max-width: 720px; margin: 0 auto; padding: 16px; }
  .new { width: 100%; margin-bottom: 16px; }
  @media (max-width: 480px) {
    .name { display: none; }
  }
  @media (max-width: 480px) {
    .user { display: none; }
  }
</style>

<script lang="ts">
  import { onMount } from "svelte";
  import LogOut from "@tabler/icons-svelte/icons/logout";
  import type { Snippet } from "svelte";
  import { page } from "$app/state";
  import Logo from "../shared/ui/Logo.svelte";
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { can, meQuery } from "../features/auth";
  import { connectEvents } from "../realtime/events";
  import { HostPicker, hostsQuery, selectionAfter, type HostInfo } from "../features/hosts";
  import { UpdateBanner, UpdateOutput, busyReason, lastEntry, latestQuery, reloadDecision, showsFinishedPanel, updatesQuery } from "../features/updates";
  import { startInstanceMutation, type StartArgs } from "../features/instances";
  import { NewDialog, startErrorAction } from "../features/new-instance";
  import { createStartFlow } from "../startflow.svelte";
  import ActionIcon from "../shared/ui/ActionIcon.svelte";
  import BottomNav from "./BottomNav.svelte";
  import { setShell } from "./context";

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

  let { children }: { children: Snippet } = $props();

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

  setShell({
    flow,
    get hosts() { return hosts; },
    get updates() { return updatesQ.data ?? []; },
    get now() { return now; },
    get user() { return meQ.data?.name ?? ""; },
    get logoutUrl() { return meQ.data?.logoutUrl ?? "/auth/logout"; },
    // While the user loads, the role is unknown and every control shows. The hub still refuses what the role cannot do.
    can: (need) => can(meQ.data?.role, need, meQ.data !== undefined),
    select,
    get latestError() { return latestQ.isError; },
  });

  onMount(() => {
    const t = setInterval(() => (now = new Date()), 30_000);
    const stop = connectEvents({ client });
    return () => {
      clearInterval(t);
      stop();
    };
  });
</script>

<header class="sticky top-0 z-40 flex items-center gap-3 border-b bg-card px-4 py-2">
  <h1 class="flex min-h-0 min-w-11 flex-none flex-col items-center self-stretch"><a class="flex min-h-0 min-w-11 flex-[1_1_0] flex-col items-center rounded-lg" href="/instances" aria-label="Claude RC: home"><Logo /></a></h1>
  {#if hosts.length > 1}
    <HostPicker {hosts} selected={flow.selected} updates={updatesQ.data ?? []} {now} onselect={select} allowUpdate={can(meQ.data?.role, "admin", meQ.data !== undefined)} />
  {/if}
  <span class="ml-auto hidden min-w-0 text-[0.9rem] text-muted-foreground min-[481px]:inline-flex"><span class="truncate">{meQ.data?.name ?? ""}</span></span>
  <a class="inline-flex min-h-11 min-w-11 flex-none items-center justify-center text-primary" href={meQ.data?.logoutUrl ?? "/auth/logout"} aria-label="Logout" title="Logout">
    <LogOut size={22} aria-hidden="true" />
  </a>
</header>
<div class="mx-auto flex max-w-[720px] flex-col gap-3 px-4 pt-4 pb-[calc(6.5rem+env(safe-area-inset-bottom))]">
  {#if reloadBar}
    <Alert.Root role="status" class="border-l-[3px] border-l-warning">
      <Alert.Description class="text-foreground">The hub was updated. Reload to get the new page.</Alert.Description>
      <Alert.Action class="top-1/2 -translate-y-1/2">
        <Button size="icon-touch" aria-label="Reload" title="Reload" onclick={() => location.reload()}><ActionIcon name="refresh" /></Button>
      </Alert.Action>
    </Alert.Root>
  {/if}
  <!-- The Updates page shows the whole panel itself. -->
  {#if page.url.pathname !== "/updates"}
    <UpdateBanner {hosts} updates={updatesQ.data ?? []} latestError={latestQ.isError} canRun={can(meQ.data?.role, "admin", meQ.data !== undefined)} />
  {/if}
  {#if showsFinishedPanel(lastEntry(updatesQ.data ?? [], flow.selected))}
    {#key flow.selected}
      <div><UpdateOutput host={flow.selected} open={false} /></div>
    {/key}
  {/if}
  <main>
    {@render children()}
  </main>
</div>
<BottomNav />
{#if flow.showNew}
  {#key flow.selected}
    <NewDialog
      host={flow.selected}
      busyReason={selectedBusy}
      initial={flow.newInitial}
      onclose={() => flow.closeNew()}
      onstart={startNew}
      canChooseUser={can(meQ.data?.role, "admin", meQ.data !== undefined)}
      canSignInGitHub={can(meQ.data?.role, "admin", meQ.data !== undefined)}
    />
  {/key}
{/if}

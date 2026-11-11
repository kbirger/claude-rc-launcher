<script lang="ts">
  import { Alert } from "#lib/components/ui/alert/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Table from "#lib/components/ui/table/index.js";
  import ArrowUp from "@tabler/icons-svelte/icons/circle-arrow-up";
  import { isBehind } from "../../shared/version";
  import { cn } from "#lib/utils.js";
  import { onMount } from "svelte";
  import X from "@tabler/icons-svelte/icons/x-filled";
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { ApiError } from "../../shared/http";
  import type { UpdateEntry } from "./api";
  import { updateHostMutation } from "./mutations";
  import type { HostInfo } from "../hosts";
  import UpdateOutput from "./UpdateOutput.svelte";
  import { panelOpenByDefault } from "./updateoutput";
  import { windowsNames } from "./updatewarn";
  import { bannerKey, bannerModel, isRunning, lastEntry, mergeCallErrors, pruneCallErrors, type BannerItem, type CallError } from "./updatebanner";

  // The short form (default) is the notice on the other pages: the buttons lead to the Updates page, where `full` shows
  // the whole panel with the version table and the buttons run the update. `start` runs the update that the short form asked for.
  // `onrun` replaces the update call (the temporary mock on the Updates page uses it so that no real update runs).
  let { hosts, updates, latestError, full = false, start, onstarted, onrun }: { hosts: HostInfo[]; updates: UpdateEntry[]; latestError: boolean; full?: boolean; start?: "hub" | "nodes"; onstarted?: () => void; onrun?: (id: string, release?: string) => void } = $props();
  let dismissed = $state("");

  const client = useQueryClient();
  const update = createMutation(() => updateHostMutation(client));
  let busy = $state(false);
  // Errors of update calls made from this page, by host name; they stay until the next call for that host succeeds.
  let callErrors = $state<Record<string, CallError>>({});
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
  // The notice about a local hub build is the first line; the rest keep their order.
  const ordered = $derived([...items.filter((i) => i.kind === "hub-local-build"), ...items.filter((i) => i.kind !== "hub-local-build")]);
  // The latest release is the same for every machine, so it is shown once.
  const latest = $derived(hosts.find((h) => h.id === "local")?.target ?? hosts.find((h) => h.target)?.target);
  const key = $derived(items.map(bannerKey).join("|"));
  const actionable = $derived(items.some((i) => i.kind !== "latest-unknown" && i.kind !== "hub-local-build" && i.kind !== "updating"));

  async function run(id: string, release?: string) {
    if (onrun) return onrun(id, release);
    const name = nameOf(id);
    try {
      await update.mutateAsync({ host: id, release });
      delete callErrors[name];
    } catch (e) {
      // The hub answers 202 and then restarts: a lost connection right after the hub call is expected.
      if (id === "local" && !(e instanceof ApiError)) delete callErrors[name];
      else callErrors[name] = { error: e instanceof Error ? e.message : String(e), at: Date.now() };
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

  // Runs the update that the notice on another page asked for, once, when the items show that it is needed.
  let started = false;
  $effect(() => {
    if (!full || !start || started) return;
    if (start === "hub" && items.some((i) => i.kind === "hub-update")) {
      started = true;
      void updateHub();
      onstarted?.();
    } else if (start === "nodes") {
      const n = items.find((i) => i.kind === "node-update");
      if (!n) return;
      started = true;
      void updateNodes(n.hosts);
      onstarted?.();
    }
  });

  async function updateNodes(list: { id: string; target: string }[]) {
    busy = true;
    try {
      for (const n of list) if (!isRunning(lastEntry(updates, n.id), new Date())) await run(n.id, n.target);
    } finally {
      busy = false;
    }
  }
</script>

{#snippet action(label: string, kind: "hub" | "nodes", onclick: () => void)}
  <Button variant="ghost" size="sm" class="h-9 w-fit px-1.5 text-primary hover:bg-primary/10 hover:text-primary" disabled={busy} href={full ? undefined : `/updates?start=${kind}`} onclick={full ? onclick : undefined}>
    <ArrowUp size={16} aria-hidden="true" />{label}
  </Button>
{/snippet}

{#if full || (items.length && dismissed !== key)}
  <Alert role={actionable ? "alert" : "status"} aria-label="Updates" class="flex flex-col gap-2 p-2 pt-1">
    <div class="flex items-center justify-between gap-2 pl-1">
      <h2 class="m-0 text-sm font-semibold">{#if full}Updates{:else}<a href="/updates">Updates</a>{/if}</h2>
      {#if !full}<Button variant="ghost" size="icon-sm" class="text-muted-foreground" aria-label="Dismiss" title="Dismiss" onclick={() => (dismissed = key)}><X size={18} aria-hidden="true" /></Button>{/if}
    </div>
    <ul class="m-0 flex list-none flex-col gap-3 p-0 px-1">
      {#each ordered as item, i (bannerKey(item) + ":" + i)}
        <li class={cn("flex flex-col items-start gap-1", item.kind !== "latest-unknown" && item.kind !== "hub-local-build" && item.kind !== "updating" && "border-l-3 border-warning pl-2")}>
          {#if item.kind === "hub-update"}
            <span>The hub is out of date. Latest release: {item.target}.</span>
            {@render action("Update hub", "hub", updateHub)}
          {:else if item.kind === "updating"}
            <span>Updating {item.name}{item.step ? `: ${item.step}` : "..."}</span>
            <UpdateOutput host={item.host} open={panelOpenByDefault(lastEntry(updates, item.host))} />
          {:else if item.kind === "node-update"}
            <span>Out of date: {item.hosts.map((h) => h.name).join(", ")}.</span>
            {#if windowsNames(item.hosts, hosts).length}<span class="text-xs text-muted-foreground">The update restarts the sessions on {windowsNames(item.hosts, hosts).join(", ")}.</span>{/if}
            {@render action("Update all nodes", "nodes", () => updateNodes(item.hosts))}
          {:else if item.kind === "hub-local-build"}
            <span class="muted">The hub runs an unversioned build, so it is not compared with the latest release.</span>
          {:else if item.kind === "by-hand"}
            <span>{item.host}: {item.message}.</span>
          {:else if item.kind === "offline-after-hub-update"}
            <span>The hub was just updated. Offline now: {item.hosts.join(", ")}. They may still be restarting.</span>
          {:else if item.kind === "reinstall-service"}
            <span>{item.hosts.join(", ")}: the service definition is older than this version needs. Run install.ps1 again on that machine.</span>
          {:else if item.kind === "failed"}
            <span>Update of {item.host} failed: {item.error}</span>
            {#if item.id}<UpdateOutput host={item.id} open={panelOpenByDefault(lastEntry(updates, item.id))} />{/if}
          {:else}
            <span class="muted">Could not check for the latest release.</span>
          {/if}
        </li>
      {/each}
    </ul>
    {#if full && items.length === 0}<p class="m-0 px-1 text-muted-foreground">Everything is up to date.</p>{/if}
    {#if full && latest}<p class="m-0 px-1 text-xs text-muted-foreground">Latest release: {latest}</p>{/if}
    <!-- The versions of every machine as it reports them: a local build shows its full version (release, branch, commit). -->
    {#if full}
    <Table.Root class="w-full text-xs">
      <Table.Header>
        <Table.Row>
          <Table.Head>Node</Table.Head>
          <Table.Head>Service</Table.Head>
          <Table.Head>CLI</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each hosts as h (h.id)}
          <Table.Row>
            <Table.Cell class="align-top"><a class="text-primary underline-offset-4 hover:underline" href="/nodes#node-{h.id}">{h.name}</a></Table.Cell>
            {#if h.status === "ok"}
              <Table.Cell class={cn("align-top whitespace-normal [overflow-wrap:anywhere]", isBehind(h.version, latest) && "text-warning")}>{h.version ?? "unknown"}</Table.Cell>
              <Table.Cell class={cn("align-top whitespace-nowrap", isBehind(h.clientVersion, latest) && "text-warning")}>{h.clientVersion ?? (h.noClient ? "none" : "not reported")}</Table.Cell>
            {:else}
              <Table.Cell colspan={2} class="align-top">{h.status}</Table.Cell>
            {/if}
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
    {/if}
  </Alert>
{/if}

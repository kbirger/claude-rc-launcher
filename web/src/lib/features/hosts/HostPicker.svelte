<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Select from "#lib/components/ui/select/index.js";
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { ApiError } from "../../shared/http";
  import {
    hostOptionLabel,
    isRunning,
    lastEntry,
    stepIsError,
    stepText,
    updateHostMutation,
    type UpdateEntry,
  } from "../updates";
  import type { HostInfo } from "./api";
  import ArrowUp from "@tabler/icons-svelte/icons/circle-arrow-up";

  let {
    hosts,
    selected,
    onselect,
    updates = [],
    now = new Date(),
    allowUpdate = true,
  }: {
    hosts: HostInfo[];
    selected: string;
    onselect: (id: string) => void;
    updates?: UpdateEntry[];
    now?: Date;
    /** False hides the Update button: the hub only lets an admin update. */ allowUpdate?: boolean;
  } = $props();

  const client = useQueryClient();
  const updateM = createMutation(() => updateHostMutation(client));
  let busy = $state(false);
  let error = $state("");

  const label = (hostInfo: HostInfo) => {
    const hostLabel = hostOptionLabel(hostInfo);
    if (hostLabel) return hostLabel;
    // The version as the machine reports it, with the branch and commit of a local build.
    return `${hostInfo.name} · ${hostInfo.version ?? "unknown"}`;
  };

  const current = $derived(hosts.find((host) => host.id === selected));
  const step = $derived.by(() => {
    const last = lastEntry(updates, selected);
    return last && isRunning(last, now) ? last : undefined;
  });
  const canUpdate = $derived(
    !!current && current.id !== "local" && current.status === "ok" && current.stale && !!current.target,
  );

  async function update() {
    if (!current?.target) return;
    busy = true;
    error = "";

    try {
      await updateM.mutateAsync({ host: current.id, release: current.target });
    } catch (caught) {
      error = caught instanceof ApiError || caught instanceof Error ? caught.message : String(caught);
    } finally {
      busy = false;
    }
  }
</script>

<div class="inline-flex min-w-0 flex-auto">
  <Select.Root
    type="single"
    value={selected}
    onValueChange={(value) => {
      error = "";
      onselect(value);
    }}
  >
    <Select.Trigger class="w-full min-w-0 data-[size=default]:h-11" aria-label="Host">
      <span class="flex min-w-0 items-center gap-1.5">
        <span class="truncate">{current ? label(current) : selected}</span>
        {#if current?.stale}<ArrowUp size={16} class="shrink-0 text-primary" aria-label="Update available" />{/if}
      </span>
    </Select.Trigger>
    <Select.Content>
      {#each hosts as host (host.id)}
        <Select.Item value={host.id} label={label(host)} disabled={host.status !== "ok"}>
          <span class="flex items-center gap-1.5">
            <span class="[overflow-wrap:anywhere]">{label(host)}</span>
            {#if host.stale}<ArrowUp size={16} class="shrink-0 text-primary" aria-label="Update available" />{/if}
          </span>
        </Select.Item>
      {/each}
    </Select.Content>
  </Select.Root>
</div>
{#if canUpdate && allowUpdate}
  <Button size="touch" disabled={busy || isRunning(lastEntry(updates, current?.id ?? ""), now)} onclick={update}>
    Update
  </Button>
{/if}
{#if step && stepText(step)}<span
    class="max-w-56 truncate text-[0.85rem] {stepIsError(step) ? 'text-destructive' : 'text-muted-foreground'}"
    role="status"
  >
    {stepText(step)}
  </span>{/if}
{#if error}<span class="text-destructive" role="alert">{error}</span>{/if}

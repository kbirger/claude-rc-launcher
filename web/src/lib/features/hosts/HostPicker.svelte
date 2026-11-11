<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Select from "#lib/components/ui/select/index.js";
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { ApiError } from "../../shared/http";
  import { hostOptionLabel, isRunning, lastEntry, stepIsError, stepText, updateHostMutation, type UpdateEntry } from "../updates";
  import type { HostInfo } from "./api";
  import ArrowUp from "@tabler/icons-svelte/icons/circle-arrow-up";

  let { hosts, selected, onselect, updates = [], now = new Date() }: { hosts: HostInfo[]; selected: string; onselect: (id: string) => void; updates?: UpdateEntry[]; now?: Date } = $props();

  const client = useQueryClient();
  const updateM = createMutation(() => updateHostMutation(client));
  let busy = $state(false);
  let error = $state("");

  const label = (h: HostInfo) => {
    const other = hostOptionLabel(h);
    if (other) return other;
    // The version as the machine reports it, with the branch and commit of a local build.
    return `${h.name} · ${h.version ?? "unknown"}`;
  };

  const current = $derived(hosts.find((h) => h.id === selected));
  const step = $derived.by(() => {
    const e = lastEntry(updates, selected);
    return e && isRunning(e, now) ? e : undefined;
  });
  const canUpdate = $derived(!!current && current.id !== "local" && current.status === "ok" && current.stale && !!current.target);

  async function update() {
    if (!current?.target) return;
    busy = true;
    error = "";
    try {
      await updateM.mutateAsync({ host: current.id, release: current.target });
    } catch (e) {
      error = e instanceof ApiError || e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="picker">
  <Select.Root type="single" value={selected} onValueChange={(v) => { error = ""; onselect(v); }}>
    <Select.Trigger class="w-full min-w-0 data-[size=default]:h-11" aria-label="Host">
      <span class="flex min-w-0 items-center gap-1.5">
        <span class="truncate">{current ? label(current) : selected}</span>
        {#if current?.stale}<ArrowUp size={16} class="shrink-0 text-primary" aria-label="Update available" />{/if}
      </span>
    </Select.Trigger>
    <Select.Content>
      {#each hosts as h (h.id)}
        <Select.Item value={h.id} label={label(h)} disabled={h.status !== "ok"}>
          <span class="flex items-center gap-1.5">
            <span class="[overflow-wrap:anywhere]">{label(h)}</span>
            {#if h.stale}<ArrowUp size={16} class="shrink-0 text-primary" aria-label="Update available" />{/if}
          </span>
        </Select.Item>
      {/each}
    </Select.Content>
  </Select.Root>
</div>
{#if canUpdate}
  <Button size="touch" disabled={busy || isRunning(lastEntry(updates, current?.id ?? ""), now)} onclick={update}>Update</Button>
{/if}
{#if step && stepText(step)}<span class:error={stepIsError(step)} class="step" role="status">{stepText(step)}</span>{/if}
{#if error}<span class="error" role="alert">{error}</span>{/if}

<style>
  .step { font-size: 0.85rem; color: var(--muted-foreground); max-width: 14rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .step.error { color: var(--destructive); margin: 0; }
  .picker { display: inline-flex; flex: 1 1 auto; min-width: 0; }
</style>

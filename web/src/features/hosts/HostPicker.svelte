<script lang="ts">
  import { useQueryClient } from "@tanstack/svelte-query";
  import { ApiError } from "../../shared/http";
  import { hostOptionLabel, isRunning, lastEntry, stepIsError, stepText, updateHost, type UpdateEntry } from "../updates";
  import type { HostInfo } from "./api";
  import { clientLabel } from "./clientlabel";

  let { hosts, selected, onselect, updates = [], now = new Date() }: { hosts: HostInfo[]; selected: string; onselect: (id: string) => void; updates?: UpdateEntry[]; now?: Date } = $props();

  const client = useQueryClient();
  let busy = $state(false);
  let error = $state("");

  const shown = (v?: string) => (!v ? "unknown" : v === "dev" || v.includes("+") ? "local build" : v);
  const label = (h: HostInfo) => {
    const other = hostOptionLabel(h);
    if (other) return other;
    const versions = ` (service ${shown(h.version)}, ${h.clientVersion ? `client ${shown(h.clientVersion)}` : clientLabel(h)})`;
    return `${h.name}${versions}${h.stale ? " - out of date" : ""}`;
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
      await updateHost(current.id, current.target);
    } catch (e) {
      error = e instanceof ApiError || e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
      void client.invalidateQueries({ queryKey: ["hosts"] });
      void client.invalidateQueries({ queryKey: ["updates"] });
    }
  }
</script>

<label class="picker">
  <span class="sr">Host</span>
  <select value={selected} onchange={(e) => { error = ""; onselect(e.currentTarget.value); }} aria-label="Host">
    {#each hosts as h (h.id)}
      <option value={h.id} disabled={h.status !== "ok"}>{label(h)}</option>
    {/each}
  </select>
</label>
{#if canUpdate}
  <button class="primary" disabled={busy || isRunning(lastEntry(updates, current?.id ?? ""), now)} onclick={update}>Update</button>
{/if}
{#if step && stepText(step)}<span class:error={stepIsError(step)} class="step" role="status">{stepText(step)}</span>{/if}
{#if error}<span class="error" role="alert">{error}</span>{/if}

<style>
  .step { font-size: 0.85rem; color: var(--muted); max-width: 14rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .step.error { color: var(--danger); margin: 0; }
  .picker { display: inline-flex; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  select {
    min-height: 44px; max-width: 12rem; padding: 0 8px; font: inherit;
    color: var(--text, inherit); background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
  }
</style>

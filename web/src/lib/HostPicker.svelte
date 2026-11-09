<script lang="ts">
  import { useQueryClient } from "@tanstack/svelte-query";
  import { ApiError, updateHost, type HostInfo } from "./api";

  let { hosts, selected, onselect }: { hosts: HostInfo[]; selected: string; onselect: (id: string) => void } = $props();

  const client = useQueryClient();
  let busy = $state(false);
  let error = $state("");

  const shown = (v?: string) => (!v ? "unknown" : v === "dev" || v.includes("+") ? "local build" : v);
  const label = (h: HostInfo) => {
    if (h.status !== "ok") return `${h.name} (${h.error ?? h.status})`;
    const versions = h.version || h.clientVersion ? ` (service ${shown(h.version)}, client ${h.clientVersion ? shown(h.clientVersion) : "none"})` : "";
    return `${h.name}${versions}${h.stale ? " - out of date" : ""}`;
  };

  const current = $derived(hosts.find((h) => h.id === selected));
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
  <select value={selected} onchange={(e) => onselect(e.currentTarget.value)} aria-label="Host">
    {#each hosts as h (h.id)}
      <option value={h.id} disabled={h.status !== "ok"}>{label(h)}</option>
    {/each}
  </select>
</label>
{#if canUpdate}
  <button class="primary" disabled={busy} onclick={update}>Update</button>
{/if}
{#if error}<span class="error" role="alert">{error}</span>{/if}

<style>
  .picker { display: inline-flex; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  select {
    min-height: 44px; max-width: 12rem; padding: 0 8px; font: inherit;
    color: var(--text, inherit); background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
  }
</style>

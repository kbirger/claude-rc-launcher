<script lang="ts">
  import type { HostInfo } from "./api";

  let { hosts, selected, onselect }: { hosts: HostInfo[]; selected: string; onselect: (id: string) => void } = $props();

  const label = (h: HostInfo) => (h.status === "ok" ? h.name : `${h.name} (${h.error ?? h.status})`);
</script>

<label class="picker">
  <span class="sr">Host</span>
  <select value={selected} onchange={(e) => onselect(e.currentTarget.value)} aria-label="Host">
    {#each hosts as h (h.id)}
      <option value={h.id} disabled={h.status !== "ok"}>{label(h)}</option>
    {/each}
  </select>
</label>

<style>
  .picker { display: inline-flex; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  select {
    min-height: 44px; max-width: 12rem; padding: 0 8px; font: inherit;
    color: var(--text, inherit); background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
  }
</style>

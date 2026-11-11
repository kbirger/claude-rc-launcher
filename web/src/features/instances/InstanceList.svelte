<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError, getLogs, listInstances, stopInstance, type Instance } from "../../shared/api";

  let { host, refreshKey = 0 }: { host: string; refreshKey?: number } = $props();

  let instances = $state<Instance[]>([]);
  let loaded = $state(false);
  let error = $state("");
  let logs = $state<Record<string, string>>({});
  let now = $state(Date.now());
  let inflight = false;
  let queued = false;

  async function refresh() {
    if (inflight) {
      queued = true; // run once more right after the in-flight request finishes
      return;
    }
    inflight = true;
    try {
      instances = await listInstances(host);
      error = "";
      loaded = true;
    } catch (e) {
      error = e instanceof ApiError ? e.message : "Failed to load instances";
    } finally {
      inflight = false;
      now = Date.now();
      if (queued) {
        queued = false;
        void refresh();
      }
    }
  }

  onMount(() => {
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  });

  $effect(() => {
    void refreshKey;
    refresh();
  });

  function uptime(state: string, startedAt: string | null): string {
    if (state !== "active" || !startedAt) return "—";
    const t = new Date(startedAt).getTime();
    if (Number.isNaN(t)) return "—";
    const s = Math.max(0, Math.floor((now - t) / 1000));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function badge(state: string): string {
    return state === "active" ? "active" : state === "failed" ? "failed" : "other";
  }

  async function stop(i: Instance) {
    if (!confirm(`Stop ${i.name}?`)) return;
    try {
      await stopInstance(host, i.id);
      error = "";
    } catch (e) {
      error = e instanceof ApiError ? e.message : "Failed to stop";
    }
    await refresh();
  }

  async function toggleLogs(i: Instance) {
    if (i.id in logs) {
      const { [i.id]: _, ...rest } = logs;
      logs = rest;
      return;
    }
    try {
      logs = { ...logs, [i.id]: await getLogs(host, i.id, 100) };
    } catch (e) {
      error = e instanceof ApiError ? e.message : "Failed to load logs";
    }
  }
</script>

{#if error}<p class="error">{error}</p>{/if}
{#if loaded && instances.length === 0}
  <p class="muted empty">No running instances. Tap New to start one.</p>
{/if}
<ul>
  {#each instances as i (i.id)}
    <li>
      <div class="row">
        <strong class="name">{i.name}</strong>
        <span class="badge {badge(i.state)}">{i.state}</span>
      </div>
      <div class="path muted">{i.path}</div>
      {#if i.user}<div class="muted">{i.user}</div>{/if}
      <div class="muted">{uptime(i.state, i.startedAt)}</div>
      <div class="actions">
        <button onclick={() => toggleLogs(i)}>{i.id in logs ? "Hide logs" : "Logs"}</button>
        <button class="danger" onclick={() => stop(i)}>Stop</button>
      </div>
      {#if i.id in logs}<pre>{logs[i.id]}</pre>{/if}
    </li>
  {/each}
</ul>

<style>
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
  li { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 12px 16px; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .name { overflow-wrap: anywhere; }
  .path { font-size: 0.85rem; overflow-wrap: anywhere; }
  .actions { display: flex; gap: 8px; margin-top: 8px; }
  .badge { font-size: 0.8rem; padding: 2px 10px; border-radius: 999px; border: 1px solid currentColor; }
  .badge.active { color: var(--ok); }
  .badge.failed { color: var(--danger); }
  .badge.other { color: var(--warn); }
  pre { max-height: 40vh; overflow: auto; font-size: 0.75rem; background: var(--bg); padding: 8px; border-radius: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>

<script lang="ts">
  import { untrack } from "svelte";
  import { useQueryClient } from "@tanstack/svelte-query";
  import InstanceLogs from "./InstanceLogs.svelte";
  import { createInstancesModel } from "./model.svelte";
  import type { Instance } from "./api";

  let { host, startError = "" }: { host: string; startError?: string } = $props();

  // The model holds the state and the rules. This file draws it. App remounts the list (#key) when the host changes.
  const model = createInstancesModel({ host: untrack(() => host), client: useQueryClient(), startError: () => startError });
  let open = $state<Record<string, true>>({});
  const now = $derived(model.now);

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

  function stop(i: Instance) {
    if (confirm(`Stop ${i.name}?`)) model.stop(i.id);
  }

  function toggleLogs(id: string) {
    if (id in open) {
      const { [id]: _, ...rest } = open;
      open = rest;
    } else open = { ...open, [id]: true };
  }
</script>

{#each model.errors as e}<p class="error">{e}</p>{/each}
{#if model.loaded && model.rows.length === 0}
  <p class="muted empty">No running instances. Tap New to start one.</p>
{/if}
<ul>
  {#each model.rows as r (r.key)}
    {@const i = r.instance}
    <li class:pending={r.pending} class:starting={r.pending === "starting"}>
      <div class="row">
        <strong class="name">{r.name}</strong>
        {#if r.pending}
          <span class="badge other">{r.pending}...</span>
        {:else if i}
          <span class="badge {badge(i.state)}">{i.state}</span>
        {/if}
      </div>
      {#if i}
        <div class="path muted">{i.path}</div>
        {#if i.user}<div class="muted">{i.user}</div>{/if}
        <div class="muted">{uptime(i.state, i.startedAt)}</div>
        <div class="actions">
          <button disabled={!!r.pending} onclick={() => toggleLogs(i.id)}>{i.id in open ? "Hide logs" : "Logs"}</button>
          <button class="danger" disabled={!!r.pending} onclick={() => stop(i)}>Stop</button>
        </div>
        {#if i.id in open}<InstanceLogs {host} id={i.id} />{/if}
      {/if}
    </li>
  {/each}
</ul>

<style>
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
  li { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 12px 16px; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .name { overflow-wrap: anywhere; }
  .path { font-size: 0.85rem; overflow-wrap: anywhere; }
  .actions { display: flex; gap: 8px; margin-top: 8px; }
  .badge { font-size: 0.8rem; padding: 2px 10px; border-radius: 999px; border: 1px solid currentColor; }
  .badge.active { color: var(--ok); }
  .badge.failed { color: var(--destructive); }
  .badge.other { color: var(--warn); }
  li.pending { opacity: 0.6; }
  li.starting { border-style: dashed; }
</style>

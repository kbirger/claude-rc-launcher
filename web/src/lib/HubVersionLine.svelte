<script lang="ts">
  import type { HostInfo } from "./api";

  let { hub }: { hub?: HostInfo } = $props();

  const unknown = (v?: string) => !v || v === "dev" || v.includes("+");
  const service = $derived(unknown(hub?.version) ? (hub?.version ? "local build" : "unknown") : hub!.version);
  const client = $derived(hub?.clientVersion ? (unknown(hub.clientVersion) ? "local build" : hub.clientVersion) : "no client");
</script>

<p class="line muted">
  Hub {service} · client {client}{#if hub?.stale && hub.target}<span class="stale"> · latest {hub.target}</span>{/if}
</p>

<style>
  .line { margin: 0 0 8px; font-size: 0.9rem; }
  .stale { color: var(--warn); }
</style>

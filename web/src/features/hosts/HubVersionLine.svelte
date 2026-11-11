<script lang="ts">
  import type { HostInfo } from "../../shared/api";
  import { clientLabel } from "./clientlabel";

  let { hub }: { hub?: HostInfo } = $props();

  const unknown = (v?: string) => !v || v === "dev" || v.includes("+");
  const service = $derived(unknown(hub?.version) ? (hub?.version ? "local build" : "unknown") : hub!.version);
  const client = $derived(hub?.clientVersion ? `client ${unknown(hub.clientVersion) ? "local build" : hub.clientVersion}` : clientLabel(hub ?? {}));
</script>

<p class="line muted">
  Hub {service} · {client}{#if hub?.stale && hub.target}<span class="stale"> · latest {hub.target}</span>{/if}
</p>

<style>
  .line { margin: 0 0 8px; font-size: 0.9rem; }
  .stale { color: var(--warn); }
</style>

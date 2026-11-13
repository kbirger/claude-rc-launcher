<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { ApiError } from "../../shared/http";
  import { instanceLogsQuery } from "./queries";

  let { host, id }: { host: string; id: string } = $props();
  const logsQ = createQuery(() => instanceLogsQuery(host, id));
</script>

{#if logsQ.isError}
  <p class="error">{logsQ.error instanceof ApiError ? logsQ.error.message : "Failed to load logs"}</p>
{:else if logsQ.data !== undefined}
  <pre>{logsQ.data}</pre>
{:else}
  <p class="muted">Loading logs...</p>
{/if}

<style>
  pre { overflow: auto; font-size: 0.75rem; background: var(--background); padding: 8px; border-radius: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>

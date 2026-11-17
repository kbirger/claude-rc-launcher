<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { ApiError } from "../../shared/http";
  import { instanceLogsQuery } from "./queries";

  let { host, id }: { host: string; id: string } = $props();
  const logsQ = createQuery(() => instanceLogsQuery(host, id));
</script>

{#if logsQ.isError}
  <p class="text-destructive">{logsQ.error instanceof ApiError ? logsQ.error.message : "Failed to load logs"}</p>
{:else if logsQ.data !== undefined}
  <pre class="max-h-[40vh] overflow-auto rounded-lg bg-background p-2 text-xs [overflow-wrap:anywhere] whitespace-pre-wrap">{logsQ.data}</pre>
{:else}
  <p class="text-muted-foreground">Loading logs...</p>
{/if}

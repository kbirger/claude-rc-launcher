<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { createQuery } from "@tanstack/svelte-query";
  import { ApiError } from "../../shared/http";
  import { instanceLogsQuery } from "./queries";

  let { host, id }: { host: string; id: string } = $props();
  const logsQ = createQuery(() => instanceLogsQuery(host, id));
</script>

{#if logsQ.isError}
  <Alert.Root variant="destructive"><Alert.Description>{logsQ.error instanceof ApiError ? logsQ.error.message : "Failed to load logs"}</Alert.Description></Alert.Root>
{:else if logsQ.data !== undefined}
  <pre class="max-h-[40vh] overflow-auto rounded-lg bg-background p-2 text-xs [overflow-wrap:anywhere] whitespace-pre-wrap">{logsQ.data}</pre>
{:else}
  <p class="text-muted-foreground">Loading logs...</p>
{/if}

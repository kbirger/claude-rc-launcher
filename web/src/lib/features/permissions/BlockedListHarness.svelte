<script lang="ts">
  // Test helper: BlockedList needs a query client in its context.
  import { QueryClientProvider, type QueryClient } from "@tanstack/svelte-query";
  import BlockedList from "./BlockedList.svelte";

  let { client }: { client: QueryClient } = $props();
</script>

<QueryClientProvider {client}>
  <BlockedList host="h" instance="i" session="s1" now={Date.parse("2026-11-14T10:10:00Z")} />
</QueryClientProvider>

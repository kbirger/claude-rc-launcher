<script lang="ts">
  // Test helper: BlockedList and its sheet need a query client in their context.
  import { QueryClientProvider, type QueryClient } from "@tanstack/svelte-query";
  import type { Layer } from "./api";
  import BlockedList from "./BlockedList.svelte";

  let { client, layers }: { client: QueryClient; layers?: Layer[] } = $props();
</script>

<QueryClientProvider {client}>
  <BlockedList host="h" instance="i" session="s1" now={Date.parse("2026-11-14T10:10:00Z")} {layers} />
</QueryClientProvider>

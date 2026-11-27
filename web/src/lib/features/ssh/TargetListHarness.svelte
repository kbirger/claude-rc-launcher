<script lang="ts">
  // Test helper: the target list needs a query client in its context.
  import { QueryClientProvider, type QueryClient } from "@tanstack/svelte-query";
  import type { Grant } from "./api";
  import TargetList from "./TargetList.svelte";

  let { client, onapprove }: { client: QueryClient; onapprove?: (grant: Grant) => void } = $props();
</script>

<QueryClientProvider {client}>
  <TargetList {onapprove} />
</QueryClientProvider>

<script lang="ts">
  // Test helper: the target list needs a query client in its context.
  import { QueryClientProvider, type QueryClient } from "@tanstack/svelte-query";
  import TargetList from "./TargetList.svelte";

  let { client }: { client: QueryClient } = $props();
</script>

<QueryClientProvider {client}>
  <TargetList />
</QueryClientProvider>

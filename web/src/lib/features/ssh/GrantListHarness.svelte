<script lang="ts">
  // Test helper: the grant list needs a query client in its context.
  import { QueryClientProvider, type QueryClient } from "@tanstack/svelte-query";
  import type { Grant } from "./api";
  import GrantList from "./GrantList.svelte";

  let { client, onapprove }: { client: QueryClient; onapprove: (grant: Grant) => void } = $props();
</script>

<QueryClientProvider {client}>
  <GrantList {onapprove} />
</QueryClientProvider>

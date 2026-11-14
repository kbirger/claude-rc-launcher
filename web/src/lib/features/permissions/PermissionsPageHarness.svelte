<script lang="ts">
  // Test helper: the page needs a query client in its context.
  import { QueryClientProvider, type QueryClient } from "@tanstack/svelte-query";
  import PermissionsPage from "./PermissionsPage.svelte";

  let { client }: { client: QueryClient } = $props();
</script>

<QueryClientProvider {client}>
  <PermissionsPage host="h" instance="i" />
</QueryClientProvider>

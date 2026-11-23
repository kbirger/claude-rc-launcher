<script lang="ts">
  // Test helper: the page needs a query client in its context.
  import { QueryClientProvider, type QueryClient } from "@tanstack/svelte-query";
  import SshPage from "./SshPage.svelte";

  let { client }: { client: QueryClient } = $props();
</script>

<QueryClientProvider {client}>
  <SshPage />
</QueryClientProvider>

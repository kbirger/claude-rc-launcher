<script lang="ts">
  // Test helper: SessionsLink needs a query client in its context.
  import { QueryClientProvider, type QueryClient } from "@tanstack/svelte-query";
  import SessionsLink from "./SessionsLink.svelte";

  let { client, host, instance }: { client: QueryClient; host: string; instance: string } = $props();
</script>

<QueryClientProvider {client}>
  <SessionsLink {host} {instance} />
</QueryClientProvider>

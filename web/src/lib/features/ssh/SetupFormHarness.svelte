<script lang="ts">
  // Test helper: the form needs a query client in its context, and its `holding` state shows in the page.
  import { QueryClientProvider, type QueryClient } from "@tanstack/svelte-query";
  import SetupForm from "./SetupForm.svelte";

  let { client }: { client: QueryClient } = $props();
  let holding = $state(false);
</script>

<QueryClientProvider {client}>
  <span data-testid="holding">{holding ? "yes" : "no"}</span>
  <SetupForm bind:holding />
</QueryClientProvider>

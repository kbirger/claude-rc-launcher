<script lang="ts">
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
  import App from "./App.svelte";

  const client = new QueryClient();
</script>

<QueryClientProvider {client}>
  <App />
</QueryClientProvider>

<script lang="ts">
  import { QueryClientProvider } from "@tanstack/svelte-query";
  import App from "./App.svelte";
  import { createQueryClient } from "./shared/query";

  const client = createQueryClient();
</script>

<QueryClientProvider {client}>
  <App />
</QueryClientProvider>

<script lang="ts">
  // Test helper: the list needs a query client in its context.
  import { QueryClientProvider, type QueryClient } from "@tanstack/svelte-query";
  import type { ComponentProps } from "svelte";
  import InstanceList from "./InstanceList.svelte";

  let { client, ...rest }: { client: QueryClient } & ComponentProps<typeof InstanceList> = $props();
</script>

<QueryClientProvider {client}>
  <InstanceList {...rest} />
</QueryClientProvider>

<script lang="ts">
  // Test helper: the node list needs a query client in its context.
  import { QueryClientProvider, type QueryClient } from "@tanstack/svelte-query";
  import type { ComponentProps } from "svelte";
  import NodeAccess from "./NodeAccess.svelte";

  let { client, ...rest }: { client: QueryClient } & ComponentProps<typeof NodeAccess> = $props();
</script>

<QueryClientProvider {client}>
  <NodeAccess {...rest} />
</QueryClientProvider>

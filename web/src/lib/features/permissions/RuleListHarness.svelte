<script lang="ts">
  // Test helper: the rule sheet needs a query client in its context.
  import { QueryClientProvider, type QueryClient } from "@tanstack/svelte-query";
  import type { ComponentProps } from "svelte";
  import RuleList from "./RuleList.svelte";

  let { client, ...rest }: { client: QueryClient } & ComponentProps<typeof RuleList> = $props();
</script>

<QueryClientProvider {client}>
  <RuleList {...rest} />
</QueryClientProvider>

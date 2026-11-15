<script lang="ts">
  // Test helper: RuleSheet needs a query client in its context, and its open state shows in the page.
  import { QueryClientProvider, type QueryClient } from "@tanstack/svelte-query";
  import type { ComponentProps } from "svelte";
  import RuleSheet from "./RuleSheet.svelte";

  let { client, ...rest }: { client: QueryClient } & Omit<ComponentProps<typeof RuleSheet>, "open"> = $props();
  let open = $state(true);
</script>

<QueryClientProvider {client}>
  <span data-testid="open">{open ? "open" : "closed"}</span>
  <RuleSheet bind:open {...rest} />
</QueryClientProvider>

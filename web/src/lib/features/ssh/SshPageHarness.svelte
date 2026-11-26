<script lang="ts">
  // Test helper: the page needs a query client in its context.
  import { QueryClientProvider, type QueryClient } from "@tanstack/svelte-query";
  import SshPage from "./SshPage.svelte";

  let {
    client,
    target = null,
    provisioner = false,
    onclose,
    canAdmin,
  }: {
    client: QueryClient;
    target?: string | null;
    provisioner?: boolean;
    onclose?: () => void;
    canAdmin?: boolean;
  } = $props();
</script>

<QueryClientProvider {client}>
  <SshPage {target} {provisioner} {onclose} {canAdmin} />
</QueryClientProvider>

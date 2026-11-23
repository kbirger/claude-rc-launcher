<script lang="ts">
  // Test helper: the flow needs a query client in its context, and its close shows in the page.
  import { QueryClientProvider, type QueryClient } from "@tanstack/svelte-query";
  import type { SshStatus } from "./api";
  import RecoveryFlow from "./RecoveryFlow.svelte";

  let { client, status, onclose }: { client: QueryClient; status: SshStatus; onclose?: () => void } = $props();
  let open = $state(true);
</script>

<QueryClientProvider {client}>
  {#if open}
    <RecoveryFlow
      {status}
      onclose={() => {
        open = false;
        onclose?.();
      }}
    />
  {/if}
</QueryClientProvider>

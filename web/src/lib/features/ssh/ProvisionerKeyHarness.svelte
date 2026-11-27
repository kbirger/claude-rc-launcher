<script lang="ts">
  // Test helper: the card needs a query client in its context.
  import { QueryClientProvider, type QueryClient } from "@tanstack/svelte-query";
  import type { SshStatus } from "./api";
  import ProvisionerKey from "./ProvisionerKey.svelte";

  let {
    client,
    targetId,
    status,
    onclose,
  }: { client: QueryClient; targetId: string; status: SshStatus; onclose: () => void } = $props();
</script>

<QueryClientProvider {client}>
  <ProvisionerKey {targetId} {status} {onclose} />
</QueryClientProvider>

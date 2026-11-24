<script lang="ts">
  // Test helper: the wizard needs a query client in its context.
  import { QueryClientProvider, type QueryClient } from "@tanstack/svelte-query";
  import type { SshStatus } from "./api";
  import TargetWizard from "./TargetWizard.svelte";

  let {
    client,
    status,
    targetId,
    onclose,
  }: { client: QueryClient; status: SshStatus; targetId?: string; onclose: () => void } = $props();
</script>

<QueryClientProvider {client}>
  <TargetWizard {status} {targetId} {onclose} />
</QueryClientProvider>

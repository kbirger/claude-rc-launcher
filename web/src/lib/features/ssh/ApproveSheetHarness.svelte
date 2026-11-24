<script lang="ts">
  // Test helper: the sheet needs a query client in its context.
  import { QueryClientProvider, type QueryClient } from "@tanstack/svelte-query";
  import type { Grant, SshStatus } from "./api";
  import ApproveSheet from "./ApproveSheet.svelte";

  let {
    client,
    grant,
    status,
    onclose,
  }: { client: QueryClient; grant: Grant; status: SshStatus; onclose: () => void } = $props();
</script>

<QueryClientProvider {client}>
  <ApproveSheet {grant} {status} {onclose} />
</QueryClientProvider>

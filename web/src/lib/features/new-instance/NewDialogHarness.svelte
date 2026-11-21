<script lang="ts">
  // Test helper: the dialog needs a query client in its context.
  import { QueryClientProvider, type QueryClient } from "@tanstack/svelte-query";
  import type { HostInfo } from "../hosts";
  import NewDialog from "./NewDialog.svelte";

  let {
    client,
    host,
    hosts,
    onhost,
  }: { client: QueryClient; host: string; hosts: HostInfo[]; onhost: (id: string) => void } = $props();
</script>

<QueryClientProvider {client}>
  <NewDialog {host} {hosts} {onhost} onclose={() => {}} onstart={() => {}} />
</QueryClientProvider>

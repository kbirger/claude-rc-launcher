<script lang="ts">
  // Test helper: the page needs the shell and a query client in its context.
  import { QueryClientProvider, type QueryClient } from "@tanstack/svelte-query";
  import type { HostInfo } from "#lib/features/hosts";
  import { setShell } from "#lib/shell/context";
  import Page from "./+page.svelte";

  let { client, hosts, selected = [] }: { client: QueryClient; hosts: HostInfo[]; selected?: string[] } = $props();
  setShell({
    flow: { selected: "local", startError: "", openNew: () => {}, pick: () => {} },
    get hosts() { return hosts; },
    nodes: { get selected() { return selected; }, toggle: () => {}, only: () => {}, clear: () => {} },
    can: () => true,
  } as never);
</script>

<QueryClientProvider {client}>
  <Page />
</QueryClientProvider>

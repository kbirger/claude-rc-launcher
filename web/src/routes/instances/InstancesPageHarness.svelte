<script lang="ts">
  // Test helper: the page needs the shell and a query client in its context. `calls` records what the page asks of the start flow.
  import { QueryClientProvider, type QueryClient } from "@tanstack/svelte-query";
  import type { HostInfo } from "#lib/features/hosts";
  import { setShell } from "#lib/shell/context";
  import Page from "./+page.svelte";

  let {
    client,
    hosts,
    selected = [],
    calls = [],
  }: { client: QueryClient; hosts: HostInfo[]; selected?: string[]; calls?: string[] } = $props();
  setShell({
    flow: {
      selected: "local",
      startError: "",
      openNew: () => calls.push("open"),
      pick: (id: string) => calls.push(`pick ${id}`),
    },
    get hosts() {
      return hosts;
    },
    nodes: {
      get selected() {
        return selected;
      },
      toggle: () => {},
      clear: () => {},
    },
    can: () => true,
  } as never);
</script>

<QueryClientProvider {client}>
  <Page />
</QueryClientProvider>

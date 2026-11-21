<script lang="ts">
  // Test helper: GlobalSessionList needs a query client in its context.
  import { QueryClientProvider, type QueryClient } from "@tanstack/svelte-query";
  import type { HostInfo } from "../hosts";
  import GlobalSessionList from "./GlobalSessionList.svelte";

  type Props = {
    client: QueryClient;
    hosts: HostInfo[];
    nodes?: string[];
    host?: string;
    instance?: string;
    ontoggle?: (id: string) => void;
    onclear?: () => void;
  };
  let {
    client,
    hosts,
    nodes = [],
    host = "",
    instance = "",
    ontoggle = () => {},
    onclear = () => {},
  }: Props = $props();
</script>

<QueryClientProvider {client}>
  <GlobalSessionList {hosts} {nodes} {host} {instance} now={Date.parse("2026-11-19T12:00:00Z")} {ontoggle} {onclear} />
</QueryClientProvider>

<script lang="ts">
  // Test helper: SessionView needs a query client in its context.
  import { QueryClientProvider, type QueryClient } from "@tanstack/svelte-query";
  import SessionView from "./SessionView.svelte";

  type Props = { view: "touched" | "folder"; client: QueryClient; path?: string };
  let { view, client, path = "" }: Props = $props();
</script>

<QueryClientProvider {client}>
  <SessionView host="h" instance="i" session="s1" {view} {path} hidden={false} file="" now={Date.parse("2026-11-12T11:00:00Z")} />
</QueryClientProvider>

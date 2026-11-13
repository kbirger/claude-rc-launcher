<script lang="ts">
  // Test helper: the session screens need a query client in their context.
  import { QueryClientProvider, type QueryClient } from "@tanstack/svelte-query";
  import FileBrowser from "./FileBrowser.svelte";
  import SessionList from "./SessionList.svelte";
  import TouchedList from "./TouchedList.svelte";

  type Props = { which: "touched" | "folder" | "list"; path: string; client: QueryClient };
  let { which, path, client }: Props = $props();
  const now = Date.parse("2026-11-12T11:00:00Z");
</script>

<QueryClientProvider {client}>
  {#if which === "touched"}
    <TouchedList host="h" instance="i" session="s" root="/proj" {now} />
  {:else if which === "folder"}
    <FileBrowser host="h" instance="i" session="s" {path} hidden={false} {now} />
  {:else}
    <SessionList host="h" instance="i" {now} />
  {/if}
</QueryClientProvider>

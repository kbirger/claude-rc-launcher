<script lang="ts">
  // Test helper: FilePreview needs a query client in its context.
  import { QueryClientProvider } from "@tanstack/svelte-query";
  import { createQueryClient } from "#lib/shared/query";
  import FilePreview from "./FilePreview.svelte";

  type Props = { file: string };
  let { file }: Props = $props();
  const client = createQueryClient();
</script>

<QueryClientProvider {client}>
  <FilePreview host="h" instance="i" session="s" {file} back="/" />
</QueryClientProvider>

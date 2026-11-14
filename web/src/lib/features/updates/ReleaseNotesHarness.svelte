<script lang="ts">
  // Test helper: ReleaseNotes needs a query client in its context.
  import { QueryClientProvider } from "@tanstack/svelte-query";
  import { createQueryClient } from "#lib/shared/query";
  import type { UpdateEntry } from "./api";
  import ReleaseNotes from "./ReleaseNotes.svelte";

  let { entry }: { entry: UpdateEntry } = $props();
  const client = createQueryClient();
</script>

<QueryClientProvider {client}>
  <ReleaseNotes {entry} />
</QueryClientProvider>

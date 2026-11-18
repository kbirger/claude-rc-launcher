<script lang="ts">
  // Test helper: UpdateBanner needs a query client in its context.
  import { QueryClientProvider } from "@tanstack/svelte-query";
  import { createQueryClient } from "#lib/shared/query";
  import type { HostInfo } from "../hosts";
  import UpdateBanner from "./UpdateBanner.svelte";

  let { hosts }: { hosts: HostInfo[] } = $props();
  const client = createQueryClient();
</script>

<QueryClientProvider {client}>
  <UpdateBanner full {hosts} updates={[]} latestError={false} />
</QueryClientProvider>

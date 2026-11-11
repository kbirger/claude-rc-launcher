<script lang="ts">
  import { QueryClientProvider } from "@tanstack/svelte-query";
  import type { Snippet } from "svelte";
  import "./layout.css";
  import "../app.css";
  import { createQueryClient } from "#lib/shared/query";
  import { initAppearance } from "#lib/shared/theme.svelte";
  import Shell from "#lib/shell/Shell.svelte";

  let { children }: { children: Snippet } = $props();

  initAppearance();
  const client = createQueryClient();
</script>

<QueryClientProvider {client}>
  <Shell>{@render children()}</Shell>
</QueryClientProvider>

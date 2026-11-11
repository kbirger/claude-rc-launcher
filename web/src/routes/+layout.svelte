<script lang="ts">
  import { QueryClientProvider } from "@tanstack/svelte-query";
  import type { Snippet } from "svelte";
  import "./layout.css";
  import "../app.css";
  import { createQueryClient } from "#lib/shared/query";
  import { applyTheme } from "#lib/shared/theme";

  let { children }: { children: Snippet } = $props();

  applyTheme();
  const client = createQueryClient();
</script>

<QueryClientProvider {client}>
  {@render children()}
</QueryClientProvider>

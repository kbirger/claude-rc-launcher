<script lang="ts">
  // Test helper: the menu in the bottom nav needs a query client in its context.
  import { createQueryClient } from "#lib/shared/query";
  import { QueryClientProvider } from "@tanstack/svelte-query";
  import { setShell } from "./context";
  import BottomNav from "./BottomNav.svelte";

  const client = createQueryClient();
  setShell({ user: "owner", role: "read", logoutUrl: "/auth/logout", can: () => false } as never);
</script>

<QueryClientProvider {client}>
  <BottomNav />
</QueryClientProvider>

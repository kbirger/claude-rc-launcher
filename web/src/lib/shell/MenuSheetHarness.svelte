<script lang="ts">
  // Test helper: the menu reads the role from the shell in its context.
  import type { Role } from "#lib/features/auth";
  import { createQueryClient } from "#lib/shared/query";
  import { QueryClientProvider, type QueryClient } from "@tanstack/svelte-query";
  import { setShell } from "./context";
  import MenuSheet from "./MenuSheet.svelte";

  let { role, client = createQueryClient() }: { role: Role; client?: QueryClient } = $props();
  // The role of a test does not change while the harness is mounted.
  // svelte-ignore state_referenced_locally
  const mine = role;
  setShell({
    user: "owner",
    email: undefined,
    role: mine,
    logoutUrl: "/auth/logout",
    can: (need: Role) => ({ read: 1, write: 2, admin: 3 })[mine] >= { read: 1, write: 2, admin: 3 }[need],
  } as never);
</script>

<QueryClientProvider {client}>
  <MenuSheet open={true} />
</QueryClientProvider>

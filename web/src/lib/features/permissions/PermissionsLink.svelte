<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import ShieldLock from "@tabler/icons-svelte/icons/shield-lock";
  import { Button } from "#lib/components/ui/button/index.js";
  import { stripLabel } from "#lib/components/EntityCard.svelte";
  import { isUnsupported } from "./api";
  import { permissionsHref } from "./format";
  import { userPermissionsQuery } from "./queries";

  let { host, instance }: { host: string; instance: string } = $props();

  // One probe per instance, no polling. A node without permissions answers 404 or 501: then there is no link.
  const q = createQuery(() => ({ ...userPermissionsQuery(host, instance), staleTime: 600000 }));
</script>

{#if !isUnsupported(q.error)}
  <Button variant="ghost" size="sm" class="h-8 px-2 hover:border-border" href={permissionsHref(host, instance)} title="Permissions"><ShieldLock aria-hidden="true" /><span class={stripLabel}>Permissions</span></Button>
{/if}

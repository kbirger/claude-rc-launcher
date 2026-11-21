<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import Messages from "@tabler/icons-svelte/icons/messages";
  import { Button } from "#lib/components/ui/button/index.js";
  import { stripLabel } from "#lib/components/EntityCard.svelte";
  import { isUnsupported } from "./api";
  import { sessionsHref } from "./format";
  import { sessionsQuery } from "./queries";

  let { host, instance }: { host: string; instance: string } = $props();

  // One probe per instance, no polling. A node without session files answers 404 or 501: then there is no link.
  const query = createQuery(() => ({ ...sessionsQuery(host, instance), refetchInterval: false, staleTime: 600000 }));
</script>

{#if !isUnsupported(query.error)}
  <Button variant="ghost" size="sm" class="h-8 px-2" href={sessionsHref({ host, instance })} title="Sessions">
    <Messages aria-hidden="true" /><span class={stripLabel}>Sessions</span>
  </Button>
{/if}

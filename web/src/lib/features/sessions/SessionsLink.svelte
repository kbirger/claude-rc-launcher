<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import Messages from "@tabler/icons-svelte/icons/messages";
  import { Button } from "#lib/components/ui/button/index.js";
  import { isUnsupported } from "./api";
  import { sessionsHref } from "./format";
  import { sessionsQuery } from "./queries";

  let { host, instance }: { host: string; instance: string } = $props();

  // One probe per instance, no polling. A node without session files answers 404 or 501: then there is no link.
  const q = createQuery(() => ({ ...sessionsQuery(host, instance), refetchInterval: false, staleTime: 600000 }));
</script>

{#if !isUnsupported(q.error)}
  <Button variant="ghost" size="sm" class="h-8 px-2 hover:border-border" href={sessionsHref({ host, instance })}><Messages aria-hidden="true" />Sessions</Button>
{/if}

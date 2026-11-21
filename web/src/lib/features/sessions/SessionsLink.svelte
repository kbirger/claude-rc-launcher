<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import Messages from "@tabler/icons-svelte/icons/messages";
  import { Button } from "#lib/components/ui/button/index.js";
  import { stripLabel } from "#lib/components/EntityCard.svelte";
  import { hostsQuery } from "../hosts/queries";
  import { sessionsHref } from "./format";

  let { host, instance }: { host: string; instance: string } = $props();

  // No request of its own: it reads the hosts list that the shell keeps fresh. Only a node known to have no session files hides the link.
  const hosts = createQuery(() => ({ ...hostsQuery(), enabled: false }));
  const hidden = $derived(hosts.data?.find((entry) => entry.id === host)?.sessions === false);
</script>

{#if !hidden}
  <Button variant="ghost" size="sm" class="h-8 px-2" href={sessionsHref({ host, instance })} title="Sessions">
    <Messages aria-hidden="true" /><span class={stripLabel}>Sessions</span>
  </Button>
{/if}

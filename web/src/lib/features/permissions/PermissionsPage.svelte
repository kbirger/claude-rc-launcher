<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import RuleList from "./RuleList.svelte";
  import { isUnsupported } from "./api";
  import { userPermissionsQuery } from "./queries";

  let { host, instance }: { host: string; instance: string } = $props();

  const q = createQuery(() => userPermissionsQuery(host, instance));
</script>

<h2 class="mt-0 mb-3 text-lg font-bold">Permissions</h2>
<p class="mx-0 mt-0 mb-3 text-xs text-muted-foreground">The permission rules in the user settings file of this instance. They apply to every project of its user. The rules of a project are on the session screen.</p>
{#if q.isPending}
  <p class="text-muted-foreground">Loading permissions...</p>
{:else if isUnsupported(q.error)}
  <p class="text-muted-foreground">This node does not support permissions. Update the node.</p>
{:else if q.error}
  <p class="text-destructive">Could not load the permissions: {q.error.message}</p>
{:else if q.data}
  <RuleList layers={q.data.layers} {host} {instance} />
{/if}

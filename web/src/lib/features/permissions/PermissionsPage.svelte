<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { createQuery } from "@tanstack/svelte-query";
  import RuleList from "./RuleList.svelte";
  import { isUnsupported } from "./api";
  import { userPermissionsQuery } from "./queries";

  let { host, instance }: { host: string; instance: string } = $props();

  const q = createQuery(() => userPermissionsQuery(host, instance));
</script>

<h2 class="font-heading mb-3 text-lg font-bold">Permissions</h2>
<p class="mb-3 text-xs text-muted-foreground">The permission rules in the user settings file of this instance. They apply to every project of its user. The rules of a project are on the session screen.</p>
{#if q.isPending}
  <p class="text-muted-foreground">Loading permissions...</p>
{:else if isUnsupported(q.error)}
  <p class="text-muted-foreground">This node does not support permissions. Update the node.</p>
{:else if q.error}
  <Alert.Root variant="destructive"><Alert.Description>Could not load the permissions: {q.error.message}</Alert.Description></Alert.Root>
{:else if q.data}
  <RuleList layers={q.data.layers} {host} {instance} />
{/if}

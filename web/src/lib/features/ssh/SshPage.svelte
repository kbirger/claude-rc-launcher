<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { createQuery } from "@tanstack/svelte-query";
  import { statusQuery } from "./queries";
  import SetupForm from "./SetupForm.svelte";

  const query = createQuery(() => statusQuery());
  // True while the setup form holds the recovery code: the status says "set up" by then, but the form must stay until Finish.
  let holding = $state(false);
  const nodeCount = $derived(query.data?.nodes.length ?? 0);
</script>

<h2 class="font-heading mb-3 text-lg font-bold">SSH access</h2>
{#if query.isPending}
  <p class="text-muted-foreground">Loading SSH access...</p>
{:else if query.error}
  <Alert.Root variant="destructive">
    <Alert.Description>Could not load SSH access: {query.error.message}</Alert.Description>
  </Alert.Root>
{:else if query.data}
  {#if !query.data.setUp || holding}
    <SetupForm bind:holding />
  {:else}
    <p class="text-sm text-muted-foreground">
      Unlock method: {query.data.method === "prf" ? "passkey" : "passphrase"}. {nodeCount}
      {nodeCount === 1 ? "node" : "nodes"}.
    </p>
  {/if}
{/if}

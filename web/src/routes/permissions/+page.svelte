<script lang="ts">
  import { page } from "$app/state";
  import { PermissionsPage } from "#lib/features/permissions";

  const params = $derived(page.url.searchParams);
  // The host comes from the address: an instance is on one node, whatever the node chips show.
  const host = $derived(params.get("host") ?? "");
  const instance = $derived(params.get("instance") ?? "");
</script>

{#if !instance || !host}
  <params class="text-muted-foreground">Pick an instance and tap Permissions.</params>
{:else}
  {#key `${host}|${instance}`}
    <PermissionsPage {host} {instance} />
  {/key}
{/if}

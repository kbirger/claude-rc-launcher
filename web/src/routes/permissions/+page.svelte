<script lang="ts">
  import { page } from "$app/state";
  import { PermissionsPage } from "#lib/features/permissions";

  const p = $derived(page.url.searchParams);
  // The host comes from the address: an instance is on one node, whatever the node chips show.
  const host = $derived(p.get("host") ?? "");
  const instance = $derived(p.get("instance") ?? "");
</script>

{#if !instance || !host}
  <p class="text-muted-foreground">Pick an instance and tap Permissions.</p>
{:else}
  {#key `${host}|${instance}`}
    <PermissionsPage {host} {instance} />
  {/key}
{/if}

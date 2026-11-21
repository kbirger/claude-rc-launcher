<script lang="ts">
  import { page } from "$app/state";
  import { PermissionsPage } from "#lib/features/permissions";
  import { getShell } from "#lib/shell/context";

  const shell = getShell();
  const params = $derived(page.url.searchParams);
  // The host in the address wins. Without one the selected host is used.
  const host = $derived(params.get("host") || shell.flow.selected);
  const instance = $derived(params.get("instance") ?? "");
</script>

{#if !instance}
  <p class="text-muted-foreground">Pick an instance and tap Permissions.</p>
{:else}
  {#key `${host}|${instance}`}
    <PermissionsPage {host} {instance} />
  {/key}
{/if}

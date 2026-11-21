<script lang="ts">
  import { page } from "$app/state";
  import { SessionList, SessionView, showHidden } from "#lib/features/sessions";
  import { getShell } from "#lib/shell/context";

  const shell = getShell();
  const params = $derived(page.url.searchParams);
  // The host in the address wins. Without one the selected host is used.
  const host = $derived(params.get("host") || shell.flow.selected);
  const instance = $derived(params.get("instance") ?? "");
  const session = $derived(params.get("session") ?? "");
  const VIEWS = ["touched", "changed", "folder", "permissions", "blocked"] as const;
  const view = $derived(VIEWS.find((name) => name === params.get("view")) ?? "touched");
  const path = $derived(params.get("path") ?? "");
  const hidden = $derived(showHidden(params.get("hidden"), path));
  const now = $derived(shell.now.getTime());
</script>

{#if !session}<h2 class="font-heading mb-3 text-lg font-bold">Sessions</h2>{/if}
{#if !instance}
  <p class="text-muted-foreground">Pick an instance and tap Sessions.</p>
{:else}
  {#key `${host}|${instance}`}
    {#if session}
      <SessionView
        {host}
        {instance}
        {session}
        {view}
        {path}
        {hidden}
        file={params.get("file") ?? ""}
        abs={params.get("abs") ?? ""}
        {now}
      />
    {:else}
      <SessionList {host} {instance} {now} />
    {/if}
  {/key}
{/if}

<script lang="ts">
  import { page } from "$app/state";
  import { GlobalSessionList, SessionView, showHidden } from "#lib/features/sessions";
  import { getShell } from "#lib/shell/context";

  const shell = getShell();
  const params = $derived(page.url.searchParams);
  // The host and instance come from the address: a session is on one node, whatever the node chips show.
  const host = $derived(params.get("host") ?? "");
  const instance = $derived(params.get("instance") ?? "");
  const session = $derived(params.get("session") ?? "");
  const VIEWS = ["touched", "changed", "folder", "permissions", "blocked"] as const;
  const view = $derived(VIEWS.find((candidate) => candidate === params.get("view")) ?? "touched");
  const path = $derived(params.get("path") ?? "");
  const hidden = $derived(showHidden(params.get("hidden"), path));
  const now = $derived(shell.now.getTime());
</script>

{#if session && host && instance}
  {#key `${host}|${instance}`}
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
  {/key}
{:else if session}
  <params class="text-muted-foreground">This address has no node or instance. Open the session from the list.</params>
{:else}
  <GlobalSessionList
    hosts={shell.hosts}
    nodes={shell.nodes.selected}
    {host}
    {instance}
    {now}
    ontoggle={shell.nodes.toggle}
    onclear={shell.nodes.clear}
  />
{/if}

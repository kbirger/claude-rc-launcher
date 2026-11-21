<script lang="ts">
  import { page } from "$app/state";
  import { GlobalSessionList, SessionView, showHidden } from "#lib/features/sessions";
  import { getShell } from "#lib/shell/context";

  const shell = getShell();
  const p = $derived(page.url.searchParams);
  // The host and instance come from the address: a session is on one node, whatever the node chips show.
  const host = $derived(p.get("host") ?? "");
  const instance = $derived(p.get("instance") ?? "");
  const session = $derived(p.get("session") ?? "");
  const VIEWS = ["touched", "changed", "folder", "permissions", "blocked"] as const;
  const view = $derived(VIEWS.find((v) => v === p.get("view")) ?? "touched");
  const path = $derived(p.get("path") ?? "");
  const hidden = $derived(showHidden(p.get("hidden"), path));
  const now = $derived(shell.now.getTime());
</script>

{#if session && host && instance}
  {#key `${host}|${instance}`}
    <SessionView {host} {instance} {session} {view} {path} {hidden} file={p.get("file") ?? ""} abs={p.get("abs") ?? ""} {now} />
  {/key}
{:else if session}
  <p class="text-muted-foreground">This address has no node or instance. Open the session from the list.</p>
{:else}
  <GlobalSessionList hosts={shell.hosts} nodes={shell.nodes.selected} {host} {instance} {now} ontoggle={shell.nodes.toggle} onclear={shell.nodes.clear} />
{/if}

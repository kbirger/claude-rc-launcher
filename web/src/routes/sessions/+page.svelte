<script lang="ts">
  import { page } from "$app/state";
  import { SessionList, SessionView, showHidden } from "#lib/features/sessions";
  import { getShell } from "#lib/shell/context";

  const shell = getShell();
  const p = $derived(page.url.searchParams);
  // The host in the address wins. Without one the selected host is used.
  const host = $derived(p.get("host") || shell.flow.selected);
  const instance = $derived(p.get("instance") ?? "");
  const session = $derived(p.get("session") ?? "");
  const view = $derived(p.get("view") === "folder" ? "folder" : "touched");
  const path = $derived(p.get("path") ?? "");
  const hidden = $derived(showHidden(p.get("hidden"), path));
  const now = $derived(shell.now.getTime());
</script>

<h2 class="mt-0 text-lg">Sessions</h2>
{#if !instance}
  <p class="text-muted-foreground">Pick an instance and tap Sessions.</p>
{:else}
  {#key `${host}|${instance}`}
    {#if session}
      <SessionView {host} {instance} {session} {view} {path} {hidden} file={p.get("file") ?? ""} {now} />
    {:else}
      <SessionList {host} {instance} {now} />
    {/if}
  {/key}
{/if}

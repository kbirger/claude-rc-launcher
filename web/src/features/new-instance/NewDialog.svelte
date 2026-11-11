<script lang="ts">
  import { untrack } from "svelte";
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { trustStartArgs, type TrustPrompt } from "./trustprompt";
  import { ClonePanel } from "../clone";
  import ActionIcon from "../../shared/ui/ActionIcon.svelte";
  import FolderIcon from "../../shared/ui/FolderIcon.svelte";
  import { iconKind } from "../../shared/ui/foldericon";
  import { ApiError } from "../../shared/http";
  import type { StartArgs } from "../instances";
  import type { DirListing } from "./api";
  import { browseQuery, mkdirMutation, nodeQuery, usersQuery } from "./queries";

  let { host, onclose, onstart, busyReason, initial }: {
    host: string;
    onclose: () => void;
    onstart: (a: StartArgs) => void;
    busyReason?: string;
    initial?: { path: string; user?: string; name?: string; trust: TrustPrompt };
  } = $props();

  // The dialog opens again after a 428 with the folder, user and name of that start, and its trust question.
  const init = untrack(() => initial);
  const client = useQueryClient();
  let path = $state<string | undefined>(init?.path);
  let name = $state(init?.name ?? "");
  // Set while the machine updates or restarts: a start or a clone can be cut off, so the user must agree first.
  let ack = $state(false);
  const needsAck = $derived(!!busyReason && !ack);
  let creating = $state(false);
  let folderName = $state("");
  let userPick = $state<string | undefined>(init?.user);
  let trustPrompt = $state<TrustPrompt | null>(init?.trust ?? null);
  let cloning = $state(false);
  // True while a clone runs (the panel can be open with no clone running). Close is locked then.
  let cloneBusy = $state(false);

  // An older node without /users fails this query: then there is no selector.
  const usersQ = createQuery(() => usersQuery(host));
  // An old node or an error: no clone button, no message.
  const nodeQ = createQuery(() => nodeQuery(host));
  const usersInfo = $derived(usersQ.data?.selectable ? usersQ.data : null);
  const user = $derived(userPick ?? usersInfo?.default ?? "");
  // Only pass a user when the selector is shown.
  const chosenUser = $derived(usersInfo ? user : undefined);
  // Wait for the users answer, so the first listing is for the user that a start would use.
  const browseQ = createQuery(() => ({ ...browseQuery(host, path, chosenUser), enabled: !usersQ.isPending }));
  const mkdirM = createMutation(() => mkdirMutation(host, client));
  const listing = $derived<DirListing | null>(browseQ.data ?? null);
  const canClone = $derived(nodeQ.data?.clone === true);
  const error = $derived(
    browseQ.isError
      ? browseQ.error instanceof ApiError ? browseQ.error.message : "Failed to browse"
      : mkdirM.isError
        ? mkdirM.error instanceof ApiError ? mkdirM.error.message : "Failed to create folder"
        : "",
  );

  const atTop = $derived(!listing || listing.path === "");
  // The panel only makes sense inside a folder.
  $effect(() => { if (atTop && cloning) cloning = false; });
  // Breadcrumb segments, each with the cumulative path to navigate to.
  const crumbs = $derived.by(() => {
    if (!listing || !listing.path) return [];
    const p = listing.path;
    const sep = p.includes("\\") && !p.includes("/") ? "\\" : "/";
    const parts = p.split(sep).filter(Boolean);
    const lead = p.startsWith(sep) ? sep : "";
    return parts.map((label, idx) => ({ label, path: lead + parts.slice(0, idx + 1).join(sep) }));
  });

  function go(p?: string) {
    path = p;
    trustPrompt = null;
    mkdirM.reset();
  }

  function changeUser(e: Event) {
    userPick = (e.currentTarget as HTMLSelectElement).value;
    go(path);
  }

  function createFolder() {
    if (!listing || !folderName.trim()) return;
    mkdirM.mutate(
      { parent: listing.path, name: folderName.trim(), user: chosenUser },
      {
        onSuccess: (r) => {
          creating = false;
          folderName = "";
          go(r.path);
        },
      },
    );
  }

  async function cloned(p: string) {
    cloning = false;
    go(p);
    try {
      const l = await client.fetchQuery(browseQuery(host, p, chosenUser));
      // Start only when the listing is the new folder; a trust question then comes back for it.
      if (l.path === p) start(false, l);
    } catch {
      // The browse error shows from the query.
    }
  }

  // Hands the start to App, which closes the dialog and shows a pending row. It does not wait.
  // A trust start uses the prompt's folder and user, so it works while the listing loads or after a browse error.
  function start(addTrust = false, l: DirListing | null = listing) {
    if (needsAck) return;
    const a = trustStartArgs(trustPrompt, l, chosenUser, addTrust);
    if (!a) return;
    onstart({ path: a.path, name: name.trim() || undefined, user: a.user, addTrust: a.addTrust });
  }
</script>

<div class="overlay" role="dialog" aria-modal="true" aria-label="New instance">
  <div class="dialog">
    <div class="top">
      <h2>New instance</h2>
      <button onclick={onclose} disabled={cloneBusy} aria-label="Close">Close</button>
    </div>
    {#if busyReason}
      <div class="warn" role="alert">
        <p>This machine {busyReason}. A session or a clone that you start now can be cut off, and the page can show an error for something that worked.</p>
        <label><input type="checkbox" bind:checked={ack} /> Start anyway</label>
      </div>
    {/if}
    {#if usersInfo}
      <label class="runas">Run as
        <select value={user} disabled={cloning} onchange={changeUser}>
          {#each usersInfo.users as u (u.name)}<option value={u.name}>{u.name}</option>{/each}
        </select>
      </label>
    {/if}
    <nav class="crumbs">
      <button class="crumb" disabled={cloning} onclick={() => go()}>Roots</button>
      {#each crumbs as c (c.path)}
        <span class="muted">/</span><button class="crumb" disabled={cloning} onclick={() => go(c.path)}>{c.label}</button>
      {/each}
    </nav>
    <div class="bar">
      <button class="icon-btn" aria-label="Up one folder" title="Up one folder" disabled={!listing || listing.parent === null || cloning} onclick={() => go(listing!.parent!)}><ActionIcon name="up" /></button>
      <button class="icon-btn" aria-label="New folder" title="New folder" aria-pressed={creating} disabled={atTop} onclick={() => (creating = !creating)}><ActionIcon name="new-folder" /></button>
      {#if canClone}<button class="gh-btn" disabled={atTop || cloning || needsAck} onclick={() => { cloning = true; creating = false; }}><ActionIcon name="github" />Clone with GitHub</button>{/if}
    </div>
    {#if creating}
      <form class="bar" onsubmit={(e) => { e.preventDefault(); createFolder(); }}>
        <input placeholder="Folder name" bind:value={folderName} />
        <button class="primary" type="submit" disabled={mkdirM.isPending}>Create</button>
      </form>
    {/if}
    {#if cloning && listing}
      <ClonePanel {host} parent={listing.path} user={chosenUser} oncloned={cloned} onclose={() => (cloning = false)} onbusy={(b) => (cloneBusy = b)} />
    {:else}
    <ul>
      {#each listing?.dirs ?? [] as d (d.path)}
        <li><button class="dir" class:untrusted={d.trusted === false} onclick={() => go(d.path)}><FolderIcon kind={iconKind(d)} /><span class="name">{d.name}</span>{#if d.trusted === false}<span class="lock" role="img" aria-label="not trusted">🔒</span>{/if}</button></li>
      {/each}
      {#if listing && listing.dirs.length === 0}<li class="muted pad">No subfolders</li>{/if}
    </ul>
    <div class="footer">
      <input placeholder="Name (optional)" bind:value={name} />
      {#if error}<p class="error">{error}</p>{/if}
      {#if trustPrompt}
        <div class="trust" role="alert">
          <p><code>{trustPrompt.path}</code> is not trusted for <code>{trustPrompt.user}</code>.</p>
          <div class="bar">
            <button class="primary" disabled={needsAck} onclick={() => start(true)}>Trust and start</button>
            <button onclick={() => (trustPrompt = null)}>Cancel</button>
          </div>
        </div>
      {/if}
      <button class="primary" disabled={atTop || needsAck} onclick={() => start()}>Start here</button>
    </div>
    {/if}
  </div>
</div>

<style>
  .warn { border-left: 3px solid var(--warn); padding: 4px 8px; margin: 0 0 8px; }
  .warn p { margin: 0 0 4px; }
  .warn label { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; }
  .overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); display: flex; align-items: stretch; justify-content: center; }
  .dialog { background: var(--bg); width: 100%; display: flex; flex-direction: column; padding: 12px 16px; overflow: hidden; }
  @media (min-width: 640px) {
    .overlay { align-items: center; }
    .dialog { max-width: 560px; max-height: 80vh; border-radius: 12px; }
  }
  .top { display: flex; justify-content: space-between; align-items: center; }
  h2 { margin: 0; font-size: 1.1rem; }
  .crumbs { display: flex; flex-wrap: wrap; align-items: center; margin: 4px 0; }
  .crumb { border: none; background: transparent; padding: 0 6px; color: var(--accent); }
  .bar { display: flex; gap: 8px; margin-bottom: 8px; }
  .icon-btn { display: inline-flex; align-items: center; justify-content: center; padding: 0; }
  .gh-btn { display: inline-flex; align-items: center; gap: 8px; background: #0969da; border-color: #0969da; color: #fff; }
  @media (prefers-color-scheme: dark) { .gh-btn { background: #1f6feb; border-color: #1f6feb; } }
  ul { list-style: none; margin: 0 0 8px; padding: 0; flex: 1; overflow: auto; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
  li + li { border-top: 1px solid var(--border); }
  .dir { width: 100%; display: flex; align-items: center; gap: 6px; text-align: left; border: none; border-radius: 0; background: transparent; }
  .name { min-width: 0; overflow-wrap: anywhere; }
  .runas { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
  .untrusted { color: var(--muted); }
  .lock { flex: none; }
  .trust { border: 1px solid var(--border); border-radius: 8px; padding: 8px; background: var(--surface); }
  .trust p { margin: 0 0 8px; overflow-wrap: anywhere; }
  .pad { padding: 12px; }
  .footer { display: grid; gap: 8px; }
</style>

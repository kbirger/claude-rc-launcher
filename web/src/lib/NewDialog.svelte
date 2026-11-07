<script lang="ts">
  import { onMount } from "svelte";
  import { trustStartArgs, type TrustPrompt } from "./trustprompt";
  import { ApiError, browse, listUsers, mkdir, startInstance, type DirListing, type UsersInfo } from "./api";

  let { host, onclose, onstarted }: { host: string; onclose: () => void; onstarted: () => void } = $props();

  let listing = $state<DirListing | null>(null);
  let name = $state("");
  let error = $state("");
  let busy = $state(false);
  let creating = $state(false);
  let folderName = $state("");
  let usersInfo = $state<UsersInfo | null>(null);
  let user = $state("");
  let trustPrompt = $state<TrustPrompt | null>(null);
  let reqId = 0;
  // Only pass a user when the selector is shown.
  const chosenUser = $derived(usersInfo?.selectable ? user : undefined);

  const atTop = $derived(!listing || listing.path === "");
  // Breadcrumb segments, each with the cumulative path to navigate to.
  const crumbs = $derived.by(() => {
    if (!listing || !listing.path) return [];
    const p = listing.path;
    const sep = p.includes("\\") && !p.includes("/") ? "\\" : "/";
    const parts = p.split(sep).filter(Boolean);
    const lead = p.startsWith(sep) ? sep : "";
    return parts.map((label, idx) => ({ label, path: lead + parts.slice(0, idx + 1).join(sep) }));
  });

  async function go(path?: string) {
    const id = ++reqId;
    error = "";
    trustPrompt = null;
    try {
      const l = await browse(host, path, chosenUser);
      if (id === reqId) listing = l;
    } catch (e) {
      if (id !== reqId) return;
      // Do not keep a listing that belongs to another user or folder: Start would use it.
      listing = null;
      error = e instanceof ApiError ? e.message : "Failed to browse";
    }
  }
  onMount(async () => {
    try {
      const info = await listUsers(host);
      if (info.selectable) {
        usersInfo = info;
        user = info.default;
      }
    } catch {
      // older node without /users: no selector
    }
    go();
  });

  function changeUser(e: Event) {
    user = (e.currentTarget as HTMLSelectElement).value;
    go(listing && listing.path ? listing.path : undefined);
  }

  async function createFolder() {
    if (!listing || !folderName.trim()) return;
    error = "";
    try {
      const r = await mkdir(host, listing.path, folderName.trim());
      creating = false;
      folderName = "";
      await go(r.path);
    } catch (e) {
      error = e instanceof ApiError ? e.message : "Failed to create folder";
    }
  }

  async function start(addTrust = false) {
    if (!listing || atTop) return;
    const a = trustStartArgs(trustPrompt, listing, chosenUser, addTrust);
    busy = true;
    error = "";
    try {
      await startInstance(host, a.path, name.trim() || undefined, { user: a.user, addTrust: a.addTrust });
      trustPrompt = null;
      onstarted();
    } catch (e) {
      trustPrompt = null;
      if (e instanceof ApiError && e.status === 428 && e.body?.code === "untrusted") {
        trustPrompt = { path: e.body.path ?? listing.path, user: e.body.user ?? chosenUser ?? "" };
      } else error = e instanceof ApiError ? e.message : "Failed to start";
    } finally {
      busy = false;
    }
  }
</script>

<div class="overlay" role="dialog" aria-modal="true" aria-label="New instance">
  <div class="dialog">
    <div class="top">
      <h2>New instance</h2>
      <button onclick={onclose} aria-label="Close">Close</button>
    </div>
    {#if usersInfo}
      <label class="runas">Run as
        <select value={user} onchange={changeUser}>
          {#each usersInfo.users as u (u.name)}<option value={u.name}>{u.name}</option>{/each}
        </select>
      </label>
    {/if}
    <nav class="crumbs">
      <button class="crumb" onclick={() => go()}>Roots</button>
      {#each crumbs as c (c.path)}
        <span class="muted">/</span><button class="crumb" onclick={() => go(c.path)}>{c.label}</button>
      {/each}
    </nav>
    <div class="bar">
      <button disabled={!listing || listing.parent === null} onclick={() => go(listing!.parent!)}>Up</button>
      <button disabled={atTop} onclick={() => (creating = !creating)}>New folder</button>
    </div>
    {#if creating}
      <form class="bar" onsubmit={(e) => { e.preventDefault(); createFolder(); }}>
        <input placeholder="Folder name" bind:value={folderName} />
        <button class="primary" type="submit">Create</button>
      </form>
    {/if}
    <ul>
      {#each listing?.dirs ?? [] as d (d.path)}
        <li><button class="dir" class:untrusted={d.trusted === false} onclick={() => go(d.path)}>{d.name}{#if d.trusted === false}<span class="lock" role="img" aria-label="not trusted">🔒</span>{/if}</button></li>
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
            <button class="primary" disabled={busy} onclick={() => start(true)}>Trust and start</button>
            <button disabled={busy} onclick={() => (trustPrompt = null)}>Cancel</button>
          </div>
        </div>
      {/if}
      <button class="primary" disabled={atTop || busy} onclick={() => start()}>Start here</button>
    </div>
  </div>
</div>

<style>
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
  ul { list-style: none; margin: 0 0 8px; padding: 0; flex: 1; overflow: auto; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
  li + li { border-top: 1px solid var(--border); }
  .dir { width: 100%; text-align: left; border: none; border-radius: 0; background: transparent; overflow-wrap: anywhere; }
  .runas { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
  .untrusted { color: var(--muted); }
  .lock { margin-left: 6px; }
  .trust { border: 1px solid var(--border); border-radius: 8px; padding: 8px; background: var(--surface); }
  .trust p { margin: 0 0 8px; overflow-wrap: anywhere; }
  .pad { padding: 12px; }
  .footer { display: grid; gap: 8px; }
</style>

<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { ApiError, cloneStart, cloneStatus, githubLoginStart, githubLoginStatus, listRepos, type RepoGroup } from "./api";
  import { filterGroups } from "./repofilter";

  let { host, parent, user, oncloned, onclose }: {
    host: string;
    parent: string;
    user?: string;
    oncloned: (path: string) => void;
    onclose: () => void;
  } = $props();

  let repo = $state("");
  let query = $state("");
  let groups = $state<RepoGroup[]>([]);
  let listLoading = $state(true);
  let listError = $state("");
  let needLogin = $state(false);
  let cloning = $state(false);
  let cloneError = $state("");
  // The login code is short-lived and shown once. It is kept in memory only.
  let login = $state<{ code: string; url: string } | null>(null);
  let loginError = $state("");
  let destroyed = false;
  let cloneTimer: ReturnType<typeof setTimeout> | undefined;
  let loginTimer: ReturnType<typeof setTimeout> | undefined;

  const shown = $derived(filterGroups(groups, query));

  async function load() {
    listLoading = true;
    listError = "";
    needLogin = false;
    try {
      const r = await listRepos(host, user);
      if (destroyed) return;
      groups = r.groups;
    } catch (e) {
      if (destroyed) return;
      groups = [];
      if (e instanceof ApiError && e.status === 409 && e.body?.code === "github-login-required") needLogin = true;
      else listError = e instanceof ApiError ? e.message : "Failed to load repos";
    } finally {
      if (!destroyed) listLoading = false;
    }
  }
  onMount(load);
  onDestroy(() => {
    destroyed = true;
    clearTimeout(cloneTimer);
    clearTimeout(loginTimer);
  });

  function pick(name: string) {
    repo = name;
  }
  function date(pushedAt: string) {
    if (!pushedAt) return "";
    const d = new Date(pushedAt);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
  }

  async function clone() {
    if (!repo.trim() || cloning) return;
    cloning = true;
    cloneError = "";
    try {
      const { id } = await cloneStart(host, repo.trim(), parent, user);
      if (destroyed) return;
      pollClone(id);
    } catch (e) {
      cloning = false;
      cloneError = e instanceof ApiError ? e.message : "Failed to clone";
    }
  }
  function pollClone(id: string) {
    cloneTimer = setTimeout(async () => {
      try {
        const s = await cloneStatus(host, id);
        if (destroyed) return;
        if (s.state === "running") return pollClone(id);
        cloning = false;
        if (s.state === "done" && s.path) oncloned(s.path);
        else cloneError = s.error || "Clone failed";
      } catch (e) {
        if (destroyed) return;
        cloning = false;
        cloneError = e instanceof ApiError ? e.message : "Failed to read clone status";
      }
    }, 2000);
  }

  async function signIn() {
    loginError = "";
    try {
      const r = await githubLoginStart(host, user);
      if (destroyed) return;
      login = { code: r.code, url: r.url };
      pollLogin(r.id);
    } catch (e) {
      loginError = e instanceof ApiError ? e.message : "Failed to start sign-in";
    }
  }
  function pollLogin(id: string) {
    loginTimer = setTimeout(async () => {
      try {
        const s = await githubLoginStatus(host, id);
        if (destroyed) return;
        if (s.state === "pending") return pollLogin(id);
        login = null;
        if (s.state === "done") load();
        else loginError = s.error || "Sign-in failed";
      } catch (e) {
        if (destroyed) return;
        login = null;
        loginError = e instanceof ApiError ? e.message : "Failed to read sign-in status";
      }
    }, 3000);
  }
</script>

<div class="panel">
  <div class="top">
    <strong>Clone repo</strong>
    <button disabled={cloning} onclick={onclose}>Back</button>
  </div>
  <form onsubmit={(e) => { e.preventDefault(); clone(); }}>
    <input placeholder="owner/repo or GitHub link" bind:value={repo} disabled={cloning} aria-label="Repository link" />
    <button class="primary into" type="submit" disabled={!repo.trim() || cloning}>
      {#if cloning}Cloning...{:else}Clone into {parent}{/if}
    </button>
  </form>
  {#if cloneError}<p class="error">{cloneError}</p>{/if}

  <input class="search" type="search" placeholder="Search your repos" bind:value={query} aria-label="Search repos" />
  {#if listError}<p class="muted note">{listError}</p>{/if}
  {#if needLogin}
    <div class="login">
      {#if login}
        <p>Enter this code on GitHub:</p>
        <p class="code">{login.code}</p>
        <a href={login.url} target="_blank" rel="noopener noreferrer">Open {login.url}</a>
        <p class="muted">Waiting for you to finish...</p>
      {:else}
        <p class="muted">Sign in to GitHub to list your repos. A pasted link works without it.</p>
        <button class="primary" onclick={signIn}>Sign in to GitHub</button>
      {/if}
      {#if loginError}<p class="error">{loginError}</p>{/if}
    </div>
  {/if}
  <div class="list">
    {#if listLoading}
      <p class="muted pad">Loading repos...</p>
    {:else}
      {#each shown as g (g.owner)}
        <div class="owner muted">{g.owner}</div>
        <ul>
          {#each g.repos as r (r.name)}
            <li>
              <button class="repo" class:picked={repo === r.name} disabled={cloning} onclick={() => pick(r.name)}>
                <span class="rname">{r.name}</span>
                {#if r.private}<span class="badge">private</span>{/if}
                {#if date(r.pushedAt)}<span class="muted when">{date(r.pushedAt)}</span>{/if}
              </button>
            </li>
          {/each}
        </ul>
      {/each}
      {#if shown.length === 0 && !listError && !needLogin}<p class="muted pad">{query.trim() ? "No matching repos" : "No repos"}</p>{/if}
    {/if}
  </div>
</div>

<style>
  .panel { display: flex; flex-direction: column; gap: 8px; flex: 1; min-height: 0; margin-top: 8px; }
  .top { display: flex; justify-content: space-between; align-items: center; }
  form { display: grid; gap: 8px; }
  .into { overflow-wrap: anywhere; height: auto; padding: 8px 16px; }
  .error, .note { margin: 0; overflow-wrap: anywhere; }
  .note { font-size: 0.85rem; }
  .login { border: 1px solid var(--border); border-radius: 8px; padding: 8px; background: var(--surface); display: grid; gap: 4px; }
  .login p { margin: 0; }
  .code { font-family: ui-monospace, monospace; font-size: 1.4rem; letter-spacing: 0.1em; }
  .login a { color: var(--accent); overflow-wrap: anywhere; }
  .list { flex: 1; overflow: auto; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; min-height: 120px; }
  .owner { padding: 6px 12px; font-size: 0.8rem; background: var(--bg); border-bottom: 1px solid var(--border); }
  ul { list-style: none; margin: 0; padding: 0; }
  li + li { border-top: 1px solid var(--border); }
  .repo { width: 100%; text-align: left; border: none; border-radius: 0; background: transparent; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 12px; }
  .repo.picked { background: var(--bg); color: var(--accent); }
  .rname { overflow-wrap: anywhere; flex: 1; }
  .badge { font-size: 0.75rem; padding: 0 8px; border-radius: 999px; border: 1px solid var(--muted); color: var(--muted); }
  .when { font-size: 0.8rem; }
  .pad { padding: 12px; margin: 0; }
</style>

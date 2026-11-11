<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { ApiError } from "../../shared/http";
  import { cloneStart, cloneStatus, githubLoginStart, githubLoginStatus, listRepos, type RepoGroup } from "./api";
  import { filterGroups } from "./repofilter";
  import { startPolling } from "./poll";

  let { host, parent, user, oncloned, onclose, onbusy }: {
    host: string;
    parent: string;
    user?: string;
    oncloned: (path: string) => void;
    onclose: () => void;
    /** Called at once when a clone starts and when it ends in any way, so the dialog can lock Close. */
    onbusy?: (busy: boolean) => void;
  } = $props();

  let repo = $state("");
  let query = $state("");
  let groups = $state<RepoGroup[]>([]);
  let listLoading = $state(true);
  let listError = $state("");
  let needLogin = $state(false);
  let cloning = $state(false);
  // Every change of `cloning` goes through here, so the parent hears it at once (an $effect would run later).
  function setCloning(v: boolean) {
    cloning = v;
    onbusy?.(v);
  }
  let cloneError = $state("");
  // The login code is short-lived and shown once. It is kept in memory only.
  let login = $state<{ code: string; url: string } | null>(null);
  let loginError = $state("");
  let destroyed = false;
  let signingIn = $state(false);
  let stopClone: (() => void) | undefined;
  let stopLogin: (() => void) | undefined;

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
    stopClone?.();
    stopLogin?.();
    if (cloning) onbusy?.(false);
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
    setCloning(true);
    cloneError = "";
    try {
      const { id } = await cloneStart(host, repo.trim(), parent, user);
      if (destroyed) return;
      stopClone?.();
      stopClone = startPolling({
        fetch: () => cloneStatus(host, id),
        interval: 2000,
        maxFailures: 5,
        onResult: (s) => {
          if (s.state === "running") return false;
          setCloning(false);
          if (s.state === "done") {
            if (s.path) oncloned(s.path);
            else cloneError = "The server did not return the folder path.";
          } else cloneError = s.error || "Clone failed";
          return true;
        },
        onGiveUp: () => {
          setCloning(false);
          cloneError = "Lost track of the clone. Check the folder before trying again.";
        },
      });
    } catch (e) {
      setCloning(false);
      cloneError = e instanceof ApiError ? e.message : "Failed to clone";
    }
  }

  async function signIn() {
    if (signingIn) return;
    signingIn = true;
    loginError = "";
    try {
      const r = await githubLoginStart(host, user);
      if (destroyed) return;
      login = { code: r.code, url: r.url };
      stopLogin?.();
      stopLogin = startPolling({
        fetch: () => githubLoginStatus(host, r.id),
        interval: 3000,
        maxFailures: 5,
        onResult: (s) => {
          if (s.state === "pending") return false;
          login = null;
          signingIn = false;
          if (s.state === "done") load();
          else loginError = s.error || "Sign-in failed";
          return true;
        },
        onGiveUp: () => {
          login = null;
          signingIn = false;
          loginError = "Lost track of the sign-in. Try again.";
        },
      });
    } catch (e) {
      signingIn = false;
      loginError = e instanceof ApiError ? e.message : "Failed to start sign-in";
    }
  }
</script>

<div class="panel">
  <div class="top">
    <strong>Clone repo</strong>
    <button disabled={cloning} onclick={onclose}>Back</button>
  </div>
  <form onsubmit={(e) => { e.preventDefault(); clone(); }}>
    <label class="lbl" for="clone-repo">Repository</label>
    <input id="clone-repo" placeholder="owner/repo or GitHub link" bind:value={repo} disabled={cloning} />
    <button class="primary into" type="submit" disabled={!repo.trim() || cloning}>
      {#if cloning}Cloning...{:else}Clone into {parent}{/if}
    </button>
  </form>
  {#if cloneError}<p class="error" role="status">{cloneError}</p>{/if}

  <input class="search" type="search" placeholder="Search your repos" bind:value={query} aria-label="Search repos" />
  {#if listError}<p class="muted note" role="status">{listError}</p>{/if}
  {#if needLogin}
    <div class="login">
      {#if login}
        <p>Enter this code on GitHub:</p>
        <p class="code" role="status">{login.code}</p>
        <a href={login.url} target="_blank" rel="noopener noreferrer">Open {login.url}</a>
        <p class="muted">Waiting for you to finish...</p>
      {:else}
        <p class="muted">Sign in to GitHub to list your repos. A pasted link works without it.</p>
        <button class="primary" disabled={signingIn} onclick={signIn}>Sign in to GitHub</button>
      {/if}
      {#if loginError}<p class="error" role="status">{loginError}</p>{/if}
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
  .lbl { font-size: 0.85rem; color: var(--muted); }
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

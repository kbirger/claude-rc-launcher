<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { ApiError } from "../../shared/http";
  import { filterGroups } from "./repofilter";
  import { cloneJobQuery, cloneStartMutation, githubLoginStartMutation, isCloneDone, isLoginDone, loginJobQuery, reposQuery } from "./queries";

  let { host, parent, user, oncloned, onclose, onbusy }: {
    host: string;
    parent: string;
    user?: string;
    oncloned: (path: string) => void;
    onclose: () => void;
    /** Called at once when a clone starts and when it ends in any way, so the dialog can lock Close. */
    onbusy?: (busy: boolean) => void;
  } = $props();

  const client = useQueryClient();
  let repo = $state("");
  let query = $state("");
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
  let signingIn = $state(false);
  // A job keeps the host it started on. It is cleared once its result is handled, which also stops its query.
  let cloneJob = $state<{ host: string; id: string } | null>(null);
  let loginJob = $state<{ host: string; id: string } | null>(null);

  const reposQ = createQuery(() => reposQuery(host, user));
  const cloneM = createMutation(() => cloneStartMutation(host));
  const loginM = createMutation(() => githubLoginStartMutation(host));
  const cloneQ = createQuery(() => ({ ...cloneJobQuery(cloneJob?.host ?? host, cloneJob?.id ?? ""), enabled: cloneJob !== null }));
  const loginQ = createQuery(() => ({ ...loginJobQuery(loginJob?.host ?? host, loginJob?.id ?? ""), enabled: loginJob !== null }));

  const needLogin = $derived(reposQ.error instanceof ApiError && reposQ.error.status === 409 && reposQ.error.body?.code === "github-login-required");
  const listError = $derived(!reposQ.isError || needLogin ? "" : reposQ.error instanceof ApiError ? reposQ.error.message : "Failed to load repos");
  const groups = $derived(reposQ.data?.groups ?? []);
  const listLoading = $derived(reposQ.isPending);
  const shown = $derived(filterGroups(groups, query));

  onDestroy(() => {
    if (cloning) onbusy?.(false);
  });

  // Handle the end of a clone job once: clearing cloneJob makes the next run return early.
  $effect(() => {
    if (!cloneJob) return;
    const failed = cloneQ.isError;
    const s = cloneQ.data;
    if (!failed && !(cloneQ.isSuccess && isCloneDone(s))) return;
    untrack(() => {
      cloneJob = null;
      setCloning(false);
      if (failed) cloneError = "Lost track of the clone. Check the folder before trying again.";
      else if (s!.state === "done") {
        if (s!.path) oncloned(s!.path);
        else cloneError = "The server did not return the folder path.";
      } else cloneError = s!.error || "Clone failed";
    });
  });

  // Handle the end of a sign-in once, in the same way.
  $effect(() => {
    if (!loginJob) return;
    const failed = loginQ.isError;
    const s = loginQ.data;
    if (!failed && !(loginQ.isSuccess && isLoginDone(s))) return;
    untrack(() => {
      const jobHost = loginJob!.host;
      loginJob = null;
      login = null;
      signingIn = false;
      if (failed) loginError = "Lost track of the sign-in. Try again.";
      // A reset (not only an invalidate) drops the 409, so the list shows "Loading repos..." while it reloads.
      else if (s!.state === "done") client.resetQueries({ queryKey: reposQuery(jobHost, user).queryKey });
      else loginError = s!.error || "Sign-in failed";
    });
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
    const jobHost = host;
    try {
      const { id } = await cloneM.mutateAsync({ repo: repo.trim(), parent, user });
      cloneJob = { host: jobHost, id };
    } catch (e) {
      setCloning(false);
      cloneError = e instanceof ApiError ? e.message : "Failed to clone";
    }
  }

  async function signIn() {
    if (signingIn) return;
    signingIn = true;
    loginError = "";
    const jobHost = host;
    try {
      const r = await loginM.mutateAsync({ user });
      login = { code: r.code, url: r.url };
      loginJob = { host: jobHost, id: r.id };
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

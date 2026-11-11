<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import { onDestroy, untrack } from "svelte";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { createCloneModel } from "./model.svelte";

  let { host, parent, user, oncloned, onclose, onbusy }: {
    host: string;
    parent: string;
    user?: string;
    oncloned: (path: string) => void;
    onclose: () => void;
    /** Called at once when a clone starts and when it ends in any way, so the dialog can lock Close. */
    onbusy?: (busy: boolean) => void;
  } = $props();

  // The model holds the state and the rules. This file draws it. App remounts the dialog (#key) when the host changes.
  const model = createCloneModel({
    host: untrack(() => host),
    client: useQueryClient(),
    parent: () => parent,
    user: () => user,
    oncloned: (p) => oncloned(p),
    onbusy: (b) => onbusy?.(b),
  });
  onDestroy(() => model.destroy());

  function date(pushedAt: string) {
    if (!pushedAt) return "";
    const d = new Date(pushedAt);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
  }
</script>

<div class="panel">
  <div class="top">
    <strong>Clone repo</strong>
    <Button variant="outline" size="touch" disabled={model.cloning} onclick={onclose}>Back</Button>
  </div>
  <form onsubmit={(e) => { e.preventDefault(); model.clone(); }}>
    <label class="lbl" for="clone-repo">Repository</label>
    <input id="clone-repo" placeholder="owner/repo or GitHub link" bind:value={model.repo} disabled={model.cloning} />
    <Button size="touch" class="h-auto min-h-11 py-2 whitespace-normal [overflow-wrap:anywhere]" type="submit" disabled={!model.repo.trim() || model.cloning}>
      {#if model.cloning}Cloning...{:else}Clone into {parent}{/if}
    </Button>
  </form>
  {#if model.cloneError}<p class="error" role="status">{model.cloneError}</p>{/if}

  <input class="search" type="search" placeholder="Search your repos" bind:value={model.query} aria-label="Search repos" />
  {#if model.listError}<p class="muted note" role="status">{model.listError}</p>{/if}
  {#if model.needLogin}
    <div class="login">
      {#if model.login}
        <p>Enter this code on GitHub:</p>
        <p class="code" role="status">{model.login.code}</p>
        <a href={model.login.url} target="_blank" rel="noopener noreferrer">Open {model.login.url}</a>
        <p class="muted">Waiting for you to finish...</p>
      {:else}
        <p class="muted">Sign in to GitHub to list your repos. A pasted link works without it.</p>
        <Button size="touch" disabled={model.signingIn} onclick={() => model.signIn()}>Sign in to GitHub</Button>
      {/if}
      {#if model.loginError}<p class="error" role="status">{model.loginError}</p>{/if}
    </div>
  {/if}
  <div class="list">
    {#if model.listLoading}
      <p class="muted pad">Loading repos...</p>
    {:else}
      {#each model.shown as g (g.owner)}
        <div class="owner muted">{g.owner}</div>
        <ul>
          {#each g.repos as r (r.name)}
            <li>
              <button class="repo" class:picked={model.repo === r.name} disabled={model.cloning} onclick={() => model.pick(r.name)}>
                <span class="rname">{r.name}</span>
                {#if r.private}<span class="badge">private</span>{/if}
                {#if date(r.pushedAt)}<span class="muted when">{date(r.pushedAt)}</span>{/if}
              </button>
            </li>
          {/each}
        </ul>
      {/each}
      {#if model.shown.length === 0 && !model.listError && !model.needLogin}<p class="muted pad">{model.query.trim() ? "No matching repos" : "No repos"}</p>{/if}
    {/if}
  </div>
</div>

<style>
  .panel { display: flex; flex-direction: column; gap: 8px; flex: 1; min-height: 0; margin-top: 8px; }
  .top { display: flex; justify-content: space-between; align-items: center; }
  form { display: grid; gap: 8px; }
  .lbl { font-size: 0.85rem; color: var(--muted-foreground); }
  .error, .note { margin: 0; overflow-wrap: anywhere; }
  .note { font-size: 0.85rem; }
  .login { border: 1px solid var(--border); border-radius: 8px; padding: 8px; background: var(--card); display: grid; gap: 4px; }
  .login p { margin: 0; }
  .code { font-family: ui-monospace, monospace; font-size: 1.4rem; letter-spacing: 0.1em; }
  .login a { color: var(--primary); overflow-wrap: anywhere; }
  .list { flex: 1; overflow: auto; background: var(--card); border: 1px solid var(--border); border-radius: 8px; min-height: 120px; }
  .owner { padding: 6px 12px; font-size: 0.8rem; background: var(--background); border-bottom: 1px solid var(--border); }
  ul { list-style: none; margin: 0; padding: 0; }
  li + li { border-top: 1px solid var(--border); }
  .repo { width: 100%; text-align: left; border: none; border-radius: 0; background: transparent; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 12px; }
  .repo.picked { background: var(--background); color: var(--primary); }
  .rname { overflow-wrap: anywhere; flex: 1; }
  .badge { font-size: 0.75rem; padding: 0 8px; border-radius: 999px; border: 1px solid var(--muted-foreground); color: var(--muted-foreground); }
  .when { font-size: 0.8rem; }
  .pad { padding: 12px; margin: 0; }
</style>

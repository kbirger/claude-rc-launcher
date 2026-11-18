<script lang="ts">
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Empty from "#lib/components/ui/empty/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import * as Item from "#lib/components/ui/item/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import { onDestroy, untrack } from "svelte";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { createCloneModel } from "./model.svelte";

  let { host, parent, user, oncloned, onclose, onbusy, canSignIn = true }: {
    host: string;
    /** False hides the GitHub sign-in: the hub only lets an admin start it. */
    canSignIn?: boolean;
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

<div class="mt-2 flex min-h-0 flex-1 flex-col gap-2">
  <div class="flex items-center justify-between">
    <strong>Clone repo</strong>
    <Button variant="outline" size="touch" disabled={model.cloning} onclick={onclose}>Back</Button>
  </div>
  <form class="grid gap-2" onsubmit={(e) => { e.preventDefault(); model.clone(); }}>
    <Label for="clone-repo" class="text-muted-foreground">Repository</Label>
    <Input id="clone-repo" class="h-11" placeholder="owner/repo or GitHub link" bind:value={model.repo} disabled={model.cloning} />
    <Button size="touch" class="h-auto min-h-11 py-2 whitespace-normal [overflow-wrap:anywhere]" type="submit" disabled={!model.repo.trim() || model.cloning}>
      {#if model.cloning}Cloning...{:else}Clone into {parent}{/if}
    </Button>
  </form>
  {#if model.cloneError}<p class="text-destructive [overflow-wrap:anywhere]" role="status">{model.cloneError}</p>{/if}

  <Input class="h-11" type="search" placeholder="Search your repos" bind:value={model.query} aria-label="Search repos" />
  {#if model.listError}<p class="text-sm text-muted-foreground [overflow-wrap:anywhere]" role="status">{model.listError}</p>{/if}
  {#if model.needLogin}
    <div class="grid gap-1 rounded-lg border bg-card p-2">
      {#if model.login}
        <p>Enter this code on GitHub:</p>
        <p class="font-mono text-2xl tracking-widest" role="status">{model.login.code}</p>
        <a class="text-primary [overflow-wrap:anywhere]" href={model.login.url} target="_blank" rel="noopener noreferrer">Open {model.login.url}</a>
        <p class="text-muted-foreground">Waiting for you to finish...</p>
      {:else}
        {#if canSignIn}
          <p class="text-muted-foreground">Sign in to GitHub to list your repos. A pasted link works without it.</p>
          <Button size="touch" disabled={model.signingIn} onclick={() => model.signIn()}>Sign in to GitHub</Button>
        {:else}
          <p class="text-muted-foreground">An admin signs in to GitHub. A pasted link works without it.</p>
        {/if}
      {/if}
      {#if model.loginError}<p class="text-destructive [overflow-wrap:anywhere]" role="status">{model.loginError}</p>{/if}
    </div>
  {/if}
  <div class="min-h-[120px] flex-1 overflow-auto rounded-lg border bg-card">
    {#if model.listLoading}
      <p class="p-3 text-muted-foreground">Loading repos...</p>
    {:else}
      {#each model.shown as g (g.owner)}
        <div class="border-b bg-background px-3 py-1.5 text-xs text-muted-foreground">{g.owner}</div>
        <Item.Group class="gap-0 divide-y">
          {#each g.repos as r (r.name)}
            <Item.Root size="xs" class="min-h-11 rounded-none border-0 hover:bg-muted {model.repo === r.name ? 'text-primary' : ''}">
              {#snippet child({ props })}
                <button {...props} type="button" class="{props.class} cursor-pointer text-left disabled:pointer-events-none disabled:opacity-50" disabled={model.cloning} onclick={() => model.pick(r.name)}>
                  <Item.Content class="min-w-0 flex-1"><Item.Title class="line-clamp-none [overflow-wrap:anywhere]">{r.name}</Item.Title></Item.Content>
                  {#if r.private}<Badge variant="outline" class="text-muted-foreground">private</Badge>{/if}
                  {#if date(r.pushedAt)}<span class="text-xs text-muted-foreground">{date(r.pushedAt)}</span>{/if}
                </button>
              {/snippet}
            </Item.Root>
          {/each}
        </Item.Group>
      {/each}
      {#if model.shown.length === 0 && !model.listError && !model.needLogin}
        <Empty.Root class="border-0 p-4"><Empty.Header><Empty.Title class="font-sans font-normal text-muted-foreground">{model.query.trim() ? "No matching repos" : "No repos"}</Empty.Title></Empty.Header></Empty.Root>
      {/if}
    {/if}
  </div>
</div>

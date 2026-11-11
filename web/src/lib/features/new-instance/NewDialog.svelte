<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Select from "#lib/components/ui/select/index.js";
  import { untrack } from "svelte";
  import Lock from "@tabler/icons-svelte/icons/lock";
  import { useQueryClient } from "@tanstack/svelte-query";
  import type { NewInitial } from "./trustprompt";
  import { ClonePanel } from "../clone";
  import ActionIcon from "../../shared/ui/ActionIcon.svelte";
  import FolderIcon from "../../shared/ui/FolderIcon.svelte";
  import { iconKind } from "../../shared/ui/foldericon";
  import type { StartArgs } from "../instances";
  import { createNewDialogModel } from "./model.svelte";

  let { host, onclose, onstart, busyReason, initial }: {
    host: string;
    onclose: () => void;
    onstart: (a: StartArgs) => void;
    busyReason?: string;
    initial?: NewInitial;
  } = $props();

  // The model holds the state and the rules. This file draws it. App remounts the dialog (#key) when the host changes;
  // a new `initial` (a 428 while the dialog is open) reaches the model without a remount.
  const model = createNewDialogModel({
    host: untrack(() => host),
    client: useQueryClient(),
    initial: () => initial,
    busyReason: () => busyReason,
    onstart: (a) => onstart(a),
  });
</script>

<div class="overlay" role="dialog" aria-modal="true" aria-label="New instance">
  <div class="dialog">
    <div class="top">
      <h2>New instance</h2>
      <Button variant="outline" size="touch" onclick={onclose} disabled={model.cloneBusy} aria-label="Close">Close</Button>
    </div>
    {#if busyReason}
      <div class="warn" role="alert">
        <p>This machine {busyReason}. A session or a clone that you start now can be cut off, and the page can show an error for something that worked.</p>
        <label><input type="checkbox" bind:checked={model.ack} /> Start anyway</label>
      </div>
    {/if}
    {#if model.usersInfo}
      <div class="runas">
        <span id="runas-label">Run as</span>
        <Select.Root type="single" value={model.user} disabled={model.cloning} onValueChange={(v) => model.changeUser(v)}>
          <Select.Trigger class="w-48 data-[size=default]:h-11" aria-labelledby="runas-label">{model.user}</Select.Trigger>
          <Select.Content>
            {#each model.usersInfo.users as u (u.name)}<Select.Item value={u.name} label={u.name}>{u.name}</Select.Item>{/each}
          </Select.Content>
        </Select.Root>
      </div>
    {/if}
    <nav class="crumbs">
      <button class="crumb" disabled={model.cloning} onclick={() => model.go()}>Roots</button>
      {#each model.crumbs as c (c.path)}
        <span class="muted">/</span><button class="crumb" disabled={model.cloning} onclick={() => model.go(c.path)}>{c.label}</button>
      {/each}
    </nav>
    <div class="bar">
      <Button variant="outline" size="icon-touch" aria-label="Up one folder" title="Up one folder" disabled={!model.listing || model.listing.parent === null || model.cloning} onclick={() => model.go(model.listing!.parent!)}><ActionIcon name="up" /></Button>
      <Button variant="outline" size="icon-touch" aria-label="New folder" title="New folder" aria-pressed={model.creating} disabled={model.atTop} onclick={() => (model.creating = !model.creating)}><ActionIcon name="new-folder" /></Button>
      {#if model.canClone}<Button size="touch" class="bg-[#0969da] text-white hover:bg-[#0969da]/90 dark:bg-[#1f6feb] dark:hover:bg-[#1f6feb]/90" disabled={model.atTop || model.cloning || model.needsAck} onclick={() => model.openClone()}><ActionIcon name="github" />Clone with GitHub</Button>{/if}
    </div>
    {#if model.creating}
      <form class="bar" onsubmit={(e) => { e.preventDefault(); model.createFolder(); }}>
        <input placeholder="Folder name" bind:value={model.folderName} />
        <Button size="touch" type="submit" disabled={model.mkdirPending}>Create</Button>
      </form>
    {/if}
    {#if model.cloning && model.listing}
      <ClonePanel {host} parent={model.listing.path} user={model.chosenUser} oncloned={model.cloned} onclose={model.closeClone} onbusy={model.setCloneBusy} />
    {:else}
    <ul>
      {#each model.listing?.dirs ?? [] as d (d.path)}
        <li><button class="dir" class:untrusted={d.trusted === false} onclick={() => model.go(d.path)}><FolderIcon kind={iconKind(d)} /><span class="name">{d.name}</span>{#if d.trusted === false}<span class="lock" role="img" aria-label="not trusted"><Lock size={18} aria-hidden="true" /></span>{/if}</button></li>
      {/each}
      {#if model.listing && model.listing.dirs.length === 0}<li class="muted pad">No subfolders</li>{/if}
    </ul>
    <div class="footer">
      <input placeholder="Name (optional)" bind:value={model.name} />
      {#if model.error}<p class="error">{model.error}</p>{/if}
      {#if model.trustPrompt}
        <div class="trust" role="alert">
          <p><code>{model.trustPrompt.path}</code> is not trusted for <code>{model.trustPrompt.user}</code>.</p>
          <div class="bar">
            <Button size="touch" disabled={model.needsAck} onclick={() => model.start(true)}>Trust and start</Button>
            <Button variant="outline" size="touch" onclick={() => model.cancelTrust()}>Cancel</Button>
          </div>
        </div>
      {/if}
      <Button size="touch" disabled={model.atTop || model.needsAck} onclick={() => model.start()}>Start here</Button>
    </div>
    {/if}
  </div>
</div>

<style>
  .warn { border-left: 3px solid var(--warn); padding: 4px 8px; margin: 0 0 8px; }
  .warn p { margin: 0 0 4px; }
  .warn label { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; }
  .overlay { position: fixed; inset: 0; z-index: 50; background: rgba(0, 0, 0, 0.5); display: flex; align-items: stretch; justify-content: center; }
  .dialog { background: var(--background); width: 100%; display: flex; flex-direction: column; padding: 12px 16px; overflow: hidden; }
  @media (min-width: 640px) {
    .overlay { align-items: center; }
    .dialog { max-width: 560px; max-height: 80vh; border-radius: 12px; }
  }
  .top { display: flex; justify-content: space-between; align-items: center; }
  h2 { margin: 0; font-size: 1.1rem; }
  .crumbs { display: flex; flex-wrap: wrap; align-items: center; margin: 4px 0; }
  .crumb { border: none; background: transparent; padding: 0 6px; color: var(--primary); }
  .bar { display: flex; gap: 8px; margin-bottom: 8px; }
  ul { list-style: none; margin: 0 0 8px; padding: 0; flex: 1; overflow: auto; background: var(--card); border: 1px solid var(--border); border-radius: 8px; }
  li + li { border-top: 1px solid var(--border); }
  .dir { width: 100%; display: flex; align-items: center; gap: 6px; text-align: left; border: none; border-radius: 0; background: transparent; }
  .name { min-width: 0; overflow-wrap: anywhere; }
  .runas { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
  .untrusted { color: var(--muted-foreground); }
  .lock { flex: none; display: inline-flex; }
  .trust { border: 1px solid var(--border); border-radius: 8px; padding: 8px; background: var(--card); }
  .trust p { margin: 0 0 8px; overflow-wrap: anywhere; }
  .pad { padding: 12px; }
  .footer { display: grid; gap: 8px; }
</style>

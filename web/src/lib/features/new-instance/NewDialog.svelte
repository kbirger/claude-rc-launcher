<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Checkbox } from "#lib/components/ui/checkbox/index.js";
  import * as Dialog from "#lib/components/ui/dialog/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
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

  let { host, onclose, onstart, busyReason, initial, canChooseUser = true, canSignInGitHub = true }: {
    host: string;
    /** False hides Run as: the hub only lets an admin start an instance as another user. */
    canChooseUser?: boolean;
    /** False hides the GitHub sign-in: the hub only lets an admin start it. */
    canSignInGitHub?: boolean;
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
    canChooseUser: () => canChooseUser,
    onstart: (a) => onstart(a),
  });

  // Escape and a click outside ask to close. A clone in progress keeps the dialog open, like the disabled Close button.
  function openChange(open: boolean) {
    if (!open && !model.cloneBusy) onclose();
  }
</script>

<Dialog.Root open={true} onOpenChange={openChange}>
  <Dialog.Content
    showCloseButton={false}
    class="flex h-dvh max-w-full flex-col gap-0 overflow-hidden rounded-none bg-background p-4 sm:h-auto sm:max-h-[80vh] sm:max-w-[560px] sm:rounded-xl"
  >
    <div class="flex items-center justify-between">
      <Dialog.Title class="font-heading text-lg">New instance</Dialog.Title>
      <Button variant="outline" size="touch" onclick={onclose} disabled={model.cloneBusy}>Close</Button>
    </div>
    <Dialog.Description class="sr-only">Choose a folder, then start an instance in it.</Dialog.Description>
    {#if busyReason}
      <Alert.Root class="my-2 border-l-[3px] border-l-warning">
        <Alert.Description>
          This machine {busyReason}. A session or a clone that you start now can be cut off, and the page can show an error for something that worked.
        </Alert.Description>
        <div class="flex items-center gap-2">
          <Checkbox id="start-anyway" bind:checked={model.ack} />
          <Label for="start-anyway" class="min-h-11">Start anyway</Label>
        </div>
      </Alert.Root>
    {/if}
    {#if model.usersInfo}
      <div class="my-1 flex items-center gap-2">
        <Label id="runas-label">Run as</Label>
        <Select.Root type="single" value={model.user} disabled={model.cloning} onValueChange={(v) => model.changeUser(v)}>
          <Select.Trigger class="w-48 data-[size=default]:h-11" aria-labelledby="runas-label">{model.user}</Select.Trigger>
          <Select.Content>
            {#each model.usersInfo.users as u (u.name)}<Select.Item value={u.name} label={u.name}>{u.name}</Select.Item>{/each}
          </Select.Content>
        </Select.Root>
      </div>
    {/if}
    <nav class="my-1 flex flex-wrap items-center" aria-label="Folder">
      <Button variant="link" class="min-h-11 px-1.5" disabled={model.cloning} onclick={() => model.go()}>Roots</Button>
      {#each model.crumbs as c (c.path)}
        <span class="text-muted-foreground">/</span><Button variant="link" class="min-h-11 px-1.5" disabled={model.cloning} onclick={() => model.go(c.path)}>{c.label}</Button>
      {/each}
    </nav>
    <div class="mb-2 flex gap-2">
      <Button variant="outline" size="icon-touch" aria-label="Up one folder" title="Up one folder" disabled={!model.listing || model.listing.parent === null || model.cloning} onclick={() => model.go(model.listing!.parent!)}><ActionIcon name="up" /></Button>
      <Button variant="outline" size="icon-touch" aria-label="New folder" title="New folder" aria-pressed={model.creating} disabled={model.atTop} onclick={() => (model.creating = !model.creating)}><ActionIcon name="new-folder" /></Button>
      {#if model.canClone}<Button size="touch" class="bg-[#0969da] text-white hover:bg-[#0969da]/90 dark:bg-[#1f6feb] dark:hover:bg-[#1f6feb]/90" disabled={model.atTop || model.cloning || model.needsAck} onclick={() => model.openClone()}><ActionIcon name="github" />Clone with GitHub</Button>{/if}
    </div>
    {#if model.creating}
      <form class="mb-2 flex gap-2" onsubmit={(e) => { e.preventDefault(); model.createFolder(); }}>
        <Input class="h-11" placeholder="Folder name" aria-label="Folder name" bind:value={model.folderName} />
        <Button size="icon-touch" type="submit" aria-label="Create folder" title="Create folder" disabled={model.mkdirPending}><ActionIcon name="new-folder" /></Button>
      </form>
    {/if}
    {#if model.cloning && model.listing}
      <ClonePanel {host} parent={model.listing.path} user={model.chosenUser} oncloned={model.cloned} onclose={model.closeClone} onbusy={model.setCloneBusy} canSignIn={canSignInGitHub} />
    {:else}
      <ul class="m-0 mb-2 min-h-0 flex-1 list-none overflow-auto rounded-lg border bg-card p-0">
        {#each model.listing?.dirs ?? [] as d (d.path)}
          <li class="[&+li]:border-t">
            <Button variant="ghost" class="h-auto min-h-11 w-full justify-start gap-1.5 rounded-none py-2 text-left font-normal {d.trusted === false ? 'text-muted-foreground' : ''}" onclick={() => model.go(d.path)}><FolderIcon kind={iconKind(d)} /><span class="min-w-0 [overflow-wrap:anywhere]">{d.name}</span>{#if d.trusted === false}<span class="inline-flex flex-none" role="img" aria-label="not trusted"><Lock size={18} aria-hidden="true" /></span>{/if}</Button>
          </li>
        {/each}
        {#if model.listing && model.listing.dirs.length === 0}<li class="p-3 text-muted-foreground">No subfolders</li>{/if}
      </ul>
      <div class="grid gap-2">
        <Input class="h-11" placeholder="Name (optional)" aria-label="Name" bind:value={model.name} />
        {#if model.error}<p class="m-0 text-destructive">{model.error}</p>{/if}
        {#if model.trustPrompt}
          <Alert.Root>
            <Alert.Description class="[overflow-wrap:anywhere]">
              <code>{model.trustPrompt.path}</code> is not trusted for <code>{model.trustPrompt.user}</code>.
            </Alert.Description>
            <div class="flex gap-2 pt-1">
              <Button size="touch" disabled={model.needsAck} onclick={() => model.start(true)}>Trust and start</Button>
              <Button variant="outline" size="touch" onclick={() => model.cancelTrust()}>Cancel</Button>
            </div>
          </Alert.Root>
        {/if}
        <Button size="touch" disabled={model.atTop || model.needsAck} onclick={() => model.start()}>Start here</Button>
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>

<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import * as Sheet from "#lib/components/ui/sheet/index.js";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { onDestroy } from "svelte";
  import type { SshStatus } from "./api";
  import { MIN_PASSPHRASE, PASSPHRASE_NAME } from "./passphrase";
  import { createRecoveryModel, slotKey } from "./recovery.svelte";
  import UsernameHint from "./UsernameHint.svelte";

  // Recovery with the recovery code, after the owner lost the passkey or the passphrase. The recovery model holds the
  // steps, the code and the passphrase. Both are cleared when the flow closes or unmounts. Mount it fresh each time.
  let { status, onclose }: { status: SshStatus; onclose: () => void } = $props();

  const model = createRecoveryModel({ client: useQueryClient(), onclose: () => onclose() });
  const uid = $props.id();
  const wrap = "min-w-0 [overflow-wrap:anywhere]";

  onDestroy(model.wipe);
</script>

<Sheet.Root
  open={true}
  onOpenChange={(value) => {
    if (!value && !model.busy) model.close();
  }}
>
  <Sheet.Content
    side="bottom"
    class="mx-auto max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-2xl border-x pb-[calc(1rem+env(safe-area-inset-bottom))]"
  >
    <Sheet.Header>
      <Sheet.Title>Recover SSH access</Sheet.Title>
      <Sheet.Description class="sr-only">Use the recovery code to choose a new unlock method.</Sheet.Description>
    </Sheet.Header>
    <form
      id="{uid}-form"
      class="grid min-w-0 gap-3 px-4"
      onsubmit={(event) => {
        event.preventDefault();
        if (model.step === "code" && !model.untested && !model.busy) void model.start();
      }}
    >
      {#if model.note && model.step === "code"}
        <p class="text-sm text-muted-foreground" role="status">{model.note}</p>
      {/if}
      {#if model.step === "code"}
        <p class="text-sm text-muted-foreground">
          Type the recovery code and choose the new unlock method. This ends every active grant.
          {#if status.pendingRewrap.length > 0}
            {status.pendingRewrap.length}
            {status.pendingRewrap.length === 1 ? "target waits" : "targets wait"} for a re-lock.
          {/if}
        </p>
        <div class="grid gap-1">
          <Label for="{uid}-code">Recovery code</Label>
          <Input
            id="{uid}-code"
            type="text"
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            class="h-11 font-mono"
            disabled={model.busy}
            bind:value={model.code}
          />
        </div>
        <fieldset class="grid gap-2" disabled={model.busy}>
          <legend class="sr-only">New unlock method</legend>
          <Label class="flex min-h-11 items-start gap-3 rounded-lg border p-3">
            <input
              type="radio"
              name="{uid}-method"
              value="prf"
              bind:group={model.choice}
              onchange={model.forgetPasskey}
              class="mt-1"
            />
            <span class="grid gap-0.5">
              <span class="font-medium">Passkey</span>
              <span class="text-xs font-normal text-muted-foreground">
                A new passkey. It must support the PRF extension.
              </span>
            </span>
          </Label>
          <Label class="flex min-h-11 items-start gap-3 rounded-lg border p-3">
            <input
              type="radio"
              name="{uid}-method"
              value="passphrase"
              bind:group={model.choice}
              onchange={model.forgetPasskey}
              class="mt-1"
            />
            <span class="grid gap-0.5">
              <span class="font-medium">Passphrase</span>
              <span class="text-xs font-normal text-muted-foreground">You type it for each unlock.</span>
            </span>
          </Label>
        </fieldset>
        {#if model.choice === "passphrase"}
          <div class="grid gap-1">
            <Label for="{uid}-pass">New passphrase</Label>
            <UsernameHint />
            <Input
              id="{uid}-pass"
              name={PASSPHRASE_NAME}
              type="password"
              autocomplete="new-password"
              autocapitalize="off"
              spellcheck={false}
              class="h-11"
              disabled={model.busy}
              bind:value={model.passphrase}
            />
            <p class="text-xs text-muted-foreground">
              Use at least {MIN_PASSPHRASE} characters. A password manager can make and save one.
            </p>
          </div>
          <div class="grid gap-1">
            <Label for="{uid}-again">Type the passphrase again</Label>
            <Input
              id="{uid}-again"
              name="{PASSPHRASE_NAME}-again"
              type="password"
              autocomplete="new-password"
              autocapitalize="off"
              spellcheck={false}
              class="h-11"
              disabled={model.busy}
              bind:value={model.again}
            />
          </div>
        {/if}
      {:else}
        {#if model.complete}
          <Alert.Root role="status">
            <Alert.Description>Recovery is complete.</Alert.Description>
          </Alert.Root>
        {:else}
          <p class="text-sm text-muted-foreground">
            Each target needs one re-lock with the new unlock method. Tap Re-lock for each one.
          </p>
        {/if}
        <ul class="grid gap-2">
          {#each model.rows as row (slotKey(row))}
            <li class="flex min-h-11 min-w-0 items-center justify-between gap-3 rounded-lg border p-3">
              <span class="font-medium {wrap}">
                {row.id}
                {#if row.key === "provisioner"}<span class="block text-xs font-normal text-muted-foreground">
                    provisioner key
                  </span>{/if}
              </span>
              {#if model.isDone(row)}
                <span class="text-sm text-muted-foreground">Done</span>
              {:else}
                <Button
                  type="button"
                  size="touch"
                  variant="outline"
                  aria-label={row.key === "main" ? `Re-lock ${row.id}` : `Re-lock the provisioner key of ${row.id}`}
                  disabled={model.busy}
                  onclick={() => model.relock(row)}
                >
                  {model.working === slotKey(row) ? "Working..." : "Re-lock"}
                </Button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
      {#if model.step === "relock" && model.listProblem}
        <Alert.Root variant="destructive" role="alert">
          <Alert.Description class="{wrap} grid gap-2">
            <span>{model.listProblem}</span>
            <span>
              <Button type="button" size="touch" variant="outline" disabled={model.busy} onclick={model.retryList}>
                Try again
              </Button>
            </span>
          </Alert.Description>
        </Alert.Root>
      {/if}
      {#if model.problem}
        <Alert.Root variant="destructive" role="alert">
          <Alert.Description class={wrap}>
            {model.problem}
            {#if model.hint}If the phone showed no passkey to pick, wait a few seconds and try again.{/if}
          </Alert.Description>
        </Alert.Root>
      {/if}
      {#if model.untested && model.step === "code"}
        <p class="text-sm">Tap to test the passkey you just created.</p>
      {/if}
    </form>
    <Sheet.Footer class="px-4">
      {#if model.step === "code"}
        {#if model.untested}
          <Button type="button" size="touch" disabled={model.busy} onclick={model.testPasskey}>
            {model.busy ? "Working..." : "Test your passkey"}
          </Button>
        {:else}
          <Button type="submit" form="{uid}-form" size="touch" disabled={model.busy}>
            {model.busy ? "Working..." : "Continue"}
          </Button>
        {/if}
        {#if model.offerPassphrase}
          <Button type="button" variant="outline" size="touch" disabled={model.busy} onclick={model.usePassphrase}>
            Use a passphrase instead
          </Button>
        {/if}
        <Button type="button" variant="outline" size="touch" disabled={model.busy} onclick={model.close}>Cancel</Button>
      {:else if model.complete}
        <Button type="button" size="touch" onclick={model.close}>Close</Button>
      {:else}
        <Button type="button" variant="outline" size="touch" disabled={model.busy} onclick={model.close}>Close</Button>
      {/if}
    </Sheet.Footer>
  </Sheet.Content>
</Sheet.Root>

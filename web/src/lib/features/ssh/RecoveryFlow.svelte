<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import * as Sheet from "#lib/components/ui/sheet/index.js";
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { onDestroy } from "svelte";
  import { ApiError } from "../../shared/http";
  import { getSalt, getStatus, type SshStatus, type Unlock, type UnlockMethod } from "./api";
  import { beginRecoveryMutation, rewrapTargetMutation } from "./mutations";
  import { longEnough, MIN_PASSPHRASE, PASSPHRASE_NAME, TOO_SHORT } from "./passphrase";
  import UsernameHint from "./UsernameHint.svelte";
  import { registerPasskey, toBase64Url, unlockWithPasskey, UnlockError } from "./prf";

  // Recovery with the recovery code, after the owner lost the passkey or the passphrase. Step 1: the code and the new
  // unlock method, then the hub switches to it and ends every active grant. Step 2: one re-lock for each target. The
  // recovery code and the passphrase live in this component and nowhere else: not in a store, a cache, the address or
  // a log. Both are cleared when the flow closes. Mount it fresh each time: it reads nothing from a refetch, so a failed
  // refetch of the status cannot change it.
  let { status, onclose }: { status: SshStatus; onclose: () => void } = $props();

  const client = useQueryClient();
  const begin = createMutation(() => beginRecoveryMutation(client));
  const rewrap = createMutation(() => rewrapTargetMutation(client));
  const uid = $props.id();
  const SALT_BYTES = 32;
  const WRONG_CODE = "The recovery code does not belong to this hub.";
  const wrap = "min-w-0 [overflow-wrap:anywhere]";

  let step = $state<"code" | "relock">("code");
  let code = $state("");
  let choice = $state<UnlockMethod>("prf");
  let passphrase = $state("");
  let again = $state("");
  // The id of the new passkey, once it is registered and has a secret (at creation or from the test unlock). A retry after a wrong code reuses it.
  let credentialId = $state("");
  let method = $state<UnlockMethod>("prf");
  let offerPassphrase = $state(false);
  // The id of a new passkey whose creation gave no secret. The owner tests it with a separate tap.
  let untested = $state("");
  let note = $state("");
  let hint = $state(false);
  // One re-lock for each key: the main key of each target, and the provisioner key of a target that has one.
  type Row = { id: string; key: "main" | "provisioner" };
  let rows = $state<Row[]>([]);
  let done = $state<string[]>([]);
  let provisionerKnown = $state(false);
  let listProblem = $state("");
  let busy = $state(false);
  let working = $state("");
  let problem = $state("");

  const slotKey = (row: Row) => `${row.key}:${row.id}`;
  const left = $derived(rows.filter((row) => !done.includes(slotKey(row))));
  const complete = $derived(step === "relock" && left.length === 0 && provisionerKnown);

  function wipe() {
    code = "";
    passphrase = "";
    again = "";
  }

  onDestroy(wipe);

  function close() {
    wipe();
    begin.reset();
    rewrap.reset();
    onclose();
  }

  const passphraseUnlock = (): Unlock => ({
    method: "passphrase",
    secret: toBase64Url(new TextEncoder().encode(passphrase)),
  });

  // A passkey that waits for its test is dropped when the owner changes the method, so Continue returns.
  function forgetPasskey() {
    untested = "";
    note = "";
    hint = false;
    problem = "";
  }

  const randomSalt = () => toBase64Url(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));

  function fail(error: unknown) {
    if (error instanceof ApiError && error.status === 403) problem = WRONG_CODE;
    else if (error instanceof UnlockError) {
      problem = error.message;
      offerPassphrase = choice === "prf";
    } else problem = error instanceof Error ? error.message : "The recovery failed.";
  }

  // The provisioner keys that wait are in the status. Without that list the flow cannot say that it is complete.
  async function loadProvisioner() {
    try {
      const ids = (await getStatus()).pendingProvisionerRewrap ?? [];
      const known = rows.filter((row) => row.key === "provisioner").map((row) => row.id);
      rows = [...rows, ...ids.filter((id) => !known.includes(id)).map((id): Row => ({ id, key: "provisioner" }))];
      provisionerKnown = true;
      listProblem = "";
    } catch {
      listProblem = "The hub did not give the list of provisioner keys. Tap Try again to read it.";
    }
  }

  async function retryList() {
    busy = true;
    await loadProvisioner();
    busy = false;
  }

  // The hub switches to the new method. For a passkey, `credentialId` already holds a passkey with a secret.
  async function submit() {
    const answer = await begin.mutateAsync({
      code: code.trim(),
      method: choice,
      ...(choice === "prf" ? { credentialId } : {}),
    });
    method = choice;
    // The answer names the main keys. The provisioner keys that wait are in the status.
    rows = answer.targets.map((id): Row => ({ id, key: "main" }));
    done = [];
    provisionerKnown = false;
    await loadProvisioner();
    step = "relock";
  }

  async function start() {
    problem = "";
    offerPassphrase = false;
    hint = false;

    if (code.trim() === "") {
      problem = "Type the recovery code.";
      return;
    }

    if (choice === "passphrase") {
      if (passphrase === "") {
        problem = "Type the new passphrase.";
        return;
      }

      if (!longEnough(passphrase)) {
        problem = TOO_SHORT;
        return;
      }

      if (passphrase !== again) {
        problem = "The two passphrases do not match.";
        return;
      }
    }

    busy = true;

    try {
      if (choice === "prf" && credentialId === "") {
        // The passkey must support PRF, or every later unlock would fail.
        const registered = await registerPasskey({});

        if (!registered.prf) {
          problem = "This passkey does not support the PRF extension, so it cannot unlock SSH keys.";
          offerPassphrase = true;
          return;
        }

        if (!registered.proved) {
          // Enabled, but no secret came back at creation. The test needs a new tap, so it waits for a button.
          note = "Passkey created.";
          untested = registered.credentialId;
          return;
        }

        note = "Passkey created. It returns a PRF secret.";
        credentialId = registered.credentialId;
      }

      await submit();
    } catch (error) {
      fail(error);
    } finally {
      begin.reset();
      busy = false;
    }
  }

  async function testPasskey() {
    problem = "";
    hint = false;
    offerPassphrase = false;

    if (code.trim() === "") {
      problem = "Type the recovery code.";
      return;
    }

    busy = true;

    try {
      await unlockWithPasskey(untested, randomSalt());
      credentialId = untested;
      untested = "";
      await submit();
    } catch (error) {
      fail(error);
      hint = error instanceof UnlockError;
    } finally {
      begin.reset();
      busy = false;
    }
  }

  async function relock(row: Row) {
    const { id, key } = row;
    problem = "";
    busy = true;
    working = slotKey(row);

    try {
      let unlock: Unlock;

      if (method === "prf") {
        const { salt } = await getSalt(id, key);
        unlock = { method: "prf", secret: await unlockWithPasskey(credentialId, salt) };
      } else unlock = passphraseUnlock();

      await rewrap.mutateAsync({ id, code: code.trim(), unlock, ...(key === "provisioner" ? { key } : {}) });
      done = [...done, slotKey(row)];
    } catch (error) {
      if (error instanceof ApiError && error.status === 403 && error.message === "wrong recovery code")
        problem = WRONG_CODE;
      else problem = error instanceof Error ? error.message : "The re-lock failed.";
    } finally {
      rewrap.reset();
      busy = false;
      working = "";
    }
  }
</script>

<Sheet.Root
  open={true}
  onOpenChange={(value) => {
    if (!value && !busy) close();
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
        if (step === "code" && !untested && !busy) void start();
      }}
    >
      {#if note && step === "code"}
        <p class="text-sm text-muted-foreground" role="status">{note}</p>
      {/if}
      {#if step === "code"}
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
            disabled={busy}
            bind:value={code}
          />
        </div>
        <fieldset class="grid gap-2" disabled={busy}>
          <legend class="sr-only">New unlock method</legend>
          <Label class="flex min-h-11 items-start gap-3 rounded-lg border p-3">
            <input
              type="radio"
              name="{uid}-method"
              value="prf"
              bind:group={choice}
              onchange={forgetPasskey}
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
              bind:group={choice}
              onchange={forgetPasskey}
              class="mt-1"
            />
            <span class="grid gap-0.5">
              <span class="font-medium">Passphrase</span>
              <span class="text-xs font-normal text-muted-foreground">You type it for each unlock.</span>
            </span>
          </Label>
        </fieldset>
        {#if choice === "passphrase"}
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
              disabled={busy}
              bind:value={passphrase}
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
              disabled={busy}
              bind:value={again}
            />
          </div>
        {/if}
      {:else}
        {#if complete}
          <Alert.Root role="status">
            <Alert.Description>Recovery is complete.</Alert.Description>
          </Alert.Root>
        {:else}
          <p class="text-sm text-muted-foreground">
            Each target needs one re-lock with the new unlock method. Tap Re-lock for each one.
          </p>
        {/if}
        <ul class="grid gap-2">
          {#each rows as row (slotKey(row))}
            <li class="flex min-h-11 min-w-0 items-center justify-between gap-3 rounded-lg border p-3">
              <span class="font-medium {wrap}">
                {row.id}
                {#if row.key === "provisioner"}<span class="block text-xs font-normal text-muted-foreground">
                    provisioner key
                  </span>{/if}
              </span>
              {#if done.includes(slotKey(row))}
                <span class="text-sm text-muted-foreground">Done</span>
              {:else}
                <Button
                  type="button"
                  size="touch"
                  variant="outline"
                  aria-label={row.key === "main" ? `Re-lock ${row.id}` : `Re-lock the provisioner key of ${row.id}`}
                  disabled={busy}
                  onclick={() => relock(row)}
                >
                  {working === slotKey(row) ? "Working..." : "Re-lock"}
                </Button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
      {#if step === "relock" && listProblem}
        <Alert.Root variant="destructive" role="alert">
          <Alert.Description class="{wrap} grid gap-2">
            <span>{listProblem}</span>
            <span>
              <Button type="button" size="touch" variant="outline" disabled={busy} onclick={retryList}>
                Try again
              </Button>
            </span>
          </Alert.Description>
        </Alert.Root>
      {/if}
      {#if problem}
        <Alert.Root variant="destructive" role="alert">
          <Alert.Description class={wrap}>
            {problem}
            {#if hint}If the phone showed no passkey to pick, wait a few seconds and try again.{/if}
          </Alert.Description>
        </Alert.Root>
      {/if}
      {#if untested && step === "code"}
        <p class="text-sm">Tap to test the passkey you just created.</p>
      {/if}
    </form>
    <Sheet.Footer class="px-4">
      {#if step === "code"}
        {#if untested}
          <Button type="button" size="touch" disabled={busy} onclick={testPasskey}>
            {busy ? "Working..." : "Test your passkey"}
          </Button>
        {:else}
          <Button type="submit" form="{uid}-form" size="touch" disabled={busy}>
            {busy ? "Working..." : "Continue"}
          </Button>
        {/if}
        {#if offerPassphrase}
          <Button
            type="button"
            variant="outline"
            size="touch"
            disabled={busy}
            onclick={() => {
              choice = "passphrase";
              problem = "";
              hint = false;
              untested = "";
              note = "";
              offerPassphrase = false;
            }}
          >
            Use a passphrase instead
          </Button>
        {/if}
        <Button type="button" variant="outline" size="touch" disabled={busy} onclick={close}>Cancel</Button>
      {:else if complete}
        <Button type="button" size="touch" onclick={close}>Close</Button>
      {:else}
        <Button type="button" variant="outline" size="touch" disabled={busy} onclick={close}>Close</Button>
      {/if}
    </Sheet.Footer>
  </Sheet.Content>
</Sheet.Root>

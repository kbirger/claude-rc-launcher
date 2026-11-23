<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import type { UnlockMethod } from "./api";
  import { setupMutation } from "./mutations";
  import { registerPasskey, toBase64Url, unlockWithPasskey, UnlockError } from "./prf";
  import { SSH_KEY } from "./queries";

  // The first-time setup of SSH access: choose the unlock method, register and test a passkey, then show the recovery
  // code once. The code stays in this component and nowhere else: not in a store, a cache, the address or a log.
  // `holding` is true from the moment the hub made the code until Finish, so that a page can keep the form on screen
  // when the status says the setup is done already.
  let { holding = $bindable(false) }: { holding?: boolean } = $props();

  const client = useQueryClient();
  const setupCall = createMutation(() => setupMutation());
  const uid = $props.id();
  const GROUP_LENGTH = 4;
  const SALT_BYTES = 32;

  let choice = $state<UnlockMethod>("prf");
  let step = $state<"choose" | "code" | "done">("choose");
  let busy = $state(false);
  let problem = $state("");
  // Set when the passkey cannot be used: the form then offers the passphrase.
  let offerPassphrase = $state(false);
  let recoveryCode = $state("");
  let typed = $state("");

  const squash = (text: string) => text.replace(/[\s-]/g, "").toLowerCase();
  const matches = $derived(typed.trim() !== "" && squash(typed) === squash(recoveryCode).slice(0, GROUP_LENGTH));

  async function send(body: { method: UnlockMethod; credentialId?: string }) {
    const answer = await setupCall.mutateAsync(body);
    setupCall.reset();
    recoveryCode = answer.recoveryCode;
    holding = true;
    step = "code";
  }

  async function begin(method: UnlockMethod) {
    busy = true;
    problem = "";
    offerPassphrase = false;

    try {
      if (method === "passphrase") {
        await send({ method });
        return;
      }

      // The passkey must give a PRF secret now, or every later unlock would fail.
      const { credentialId, prf } = await registerPasskey({});

      if (!prf) {
        problem = "This passkey does not support the PRF extension, so it cannot unlock SSH keys.";
        offerPassphrase = true;
        return;
      }

      await unlockWithPasskey(credentialId, toBase64Url(crypto.getRandomValues(new Uint8Array(SALT_BYTES))));
      await send({ method, credentialId });
    } catch (error) {
      if (error instanceof UnlockError) {
        problem = error.message;
        offerPassphrase = method === "prf";
      } else problem = error instanceof Error ? error.message : "The setup failed.";
    } finally {
      busy = false;
    }
  }

  async function finish() {
    recoveryCode = "";
    typed = "";
    holding = false;
    step = "done";
    await client.invalidateQueries({ queryKey: [...SSH_KEY, "status"] });
  }
</script>

<section class="grid gap-4">
  <h2 class="font-heading text-lg font-bold">SSH access setup</h2>

  {#if step === "choose"}
    <p class="text-sm text-muted-foreground">
      The hub keeps one SSH key for each target, locked with a secret that only you can give. Choose how you unlock
      them.
    </p>
    <fieldset class="grid gap-2" disabled={busy}>
      <legend class="sr-only">Unlock method</legend>
      <Label class="flex min-h-11 items-start gap-3 rounded-lg border p-3">
        <input type="radio" name="{uid}-method" value="prf" bind:group={choice} class="mt-1" />
        <span class="grid gap-0.5">
          <span class="font-medium">Passkey</span>
          <span class="text-xs font-normal text-muted-foreground">
            A passkey of this device or a security key. It must support the PRF extension.
          </span>
        </span>
      </Label>
      <Label class="flex min-h-11 items-start gap-3 rounded-lg border p-3">
        <input type="radio" name="{uid}-method" value="passphrase" bind:group={choice} class="mt-1" />
        <span class="grid gap-0.5">
          <span class="font-medium">Passphrase</span>
          <span class="text-xs font-normal text-muted-foreground">
            You type the same passphrase for each unlock. Nothing to register now.
          </span>
        </span>
      </Label>
    </fieldset>
    {#if problem}
      <Alert.Root variant="destructive" role="alert"><Alert.Description>{problem}</Alert.Description></Alert.Root>
    {/if}
    <div class="flex flex-wrap gap-2">
      <Button size="touch" disabled={busy} onclick={() => begin(choice)}>
        {busy ? "Working..." : "Continue"}
      </Button>
      {#if offerPassphrase}
        <Button variant="outline" size="touch" disabled={busy} onclick={() => begin("passphrase")}>
          Use a passphrase instead
        </Button>
      {/if}
    </div>
  {:else if step === "code"}
    <Alert.Root>
      <Alert.Description>
        This is the recovery code. It opens every key if you lose your {choice === "prf" ? "passkey" : "passphrase"}.
        Write it down and keep it safe. The hub cannot show it again.
      </Alert.Description>
    </Alert.Root>
    <code class="block rounded-lg border bg-muted p-3 font-mono text-base tracking-wider break-all select-all">
      {recoveryCode}
    </code>
    <div class="grid gap-2">
      <Label for="{uid}-group">Type the first group of four characters of the code</Label>
      <Input
        id="{uid}-group"
        type="text"
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
        class="h-11 font-mono"
        bind:value={typed}
      />
    </div>
    <div>
      <Button size="touch" disabled={!matches} onclick={finish}>Finish</Button>
    </div>
  {:else}
    <p>SSH access is set up.</p>
  {/if}
</section>

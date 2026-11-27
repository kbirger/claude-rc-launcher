<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import * as RadioGroup from "#lib/components/ui/radio-group/index.js";
  import { useQueryClient } from "@tanstack/svelte-query";
  import type { UnlockMethod } from "./api";
  import { createSetupModel } from "./setup.svelte";

  // The first-time setup of SSH access. The setup model holds the steps and the recovery code. `holding` is true from
  // the moment the hub made the code until Finish, so that a page can keep the form on screen when the status says the
  // setup is done already.
  let { holding = $bindable(false) }: { holding?: boolean } = $props();

  const model = createSetupModel({ client: useQueryClient(), onholding: (value) => (holding = value) });
  const uid = $props.id();
</script>

<section class="grid gap-4">
  <h2 class="font-heading text-lg font-bold">SSH access setup</h2>

  {#if model.note && model.step !== "done"}
    <p class="text-sm text-muted-foreground" role="status">{model.note}</p>
  {/if}

  {#if model.step === "choose"}
    <p class="text-sm text-muted-foreground">
      The hub keeps one SSH key for each target, locked with a secret that only you can give. Choose how you unlock
      them.
    </p>
    <fieldset class="grid gap-2" disabled={model.busy}>
      <legend class="sr-only">Unlock method</legend>
      <RadioGroup.Root
        value={model.choice}
        disabled={model.busy}
        aria-label="Unlock method"
        onValueChange={(value) => {
          model.choice = value as UnlockMethod;
          model.forgetPasskey();
        }}
      >
        <Label class="flex min-h-11 items-start gap-3 rounded-lg border p-3">
          <RadioGroup.Item value="prf" class="mt-1" />
          <span class="grid gap-0.5">
            <span class="font-medium">Passkey</span>
            <span class="text-xs font-normal text-muted-foreground">
              A passkey of this device or a security key. It must support the PRF extension.
            </span>
          </span>
        </Label>
        <Label class="flex min-h-11 items-start gap-3 rounded-lg border p-3">
          <RadioGroup.Item value="passphrase" class="mt-1" />
          <span class="grid gap-0.5">
            <span class="font-medium">Passphrase</span>
            <span class="text-xs font-normal text-muted-foreground">
              You type the same passphrase for each unlock. Nothing to register now.
            </span>
          </span>
        </Label>
      </RadioGroup.Root>
    </fieldset>
    {#if model.problem}
      <Alert.Root variant="destructive" role="alert">
        <Alert.Description>
          {model.problem}
          {#if model.hint}If the phone showed no passkey to pick, wait a few seconds and try again.{/if}
        </Alert.Description>
      </Alert.Root>
    {/if}
    {#if model.untested}
      <p class="text-sm">Tap to test the passkey you just created.</p>
    {/if}
    <div class="flex flex-wrap gap-2">
      {#if model.untested}
        <Button size="touch" disabled={model.busy} onclick={model.testPasskey}>
          {model.busy ? "Working..." : "Test your passkey"}
        </Button>
      {:else}
        <Button size="touch" disabled={model.busy} onclick={() => model.begin(model.choice)}>
          {model.busy ? "Working..." : "Continue"}
        </Button>
      {/if}
      {#if model.offerPassphrase}
        <Button variant="outline" size="touch" disabled={model.busy} onclick={() => model.begin("passphrase")}>
          Use a passphrase instead
        </Button>
      {/if}
    </div>
  {:else if model.step === "code"}
    <Alert.Root>
      <Alert.Description>
        This is the recovery code. It opens every key if you lose your {model.choice === "prf"
          ? "passkey"
          : "passphrase"}. Write it down and keep it safe. The hub cannot show it again.
      </Alert.Description>
    </Alert.Root>
    <code class="block rounded-lg border bg-muted p-3 font-mono text-base tracking-wider break-all select-all">
      {model.recoveryCode}
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
        bind:value={model.typed}
      />
    </div>
    <div>
      <Button size="touch" disabled={!model.matches} onclick={model.finish}>Finish</Button>
    </div>
  {:else}
    <p>SSH access is set up.</p>
  {/if}
</section>

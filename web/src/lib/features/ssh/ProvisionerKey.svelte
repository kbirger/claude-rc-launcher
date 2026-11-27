<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import * as Sheet from "#lib/components/ui/sheet/index.js";
  import { untrack } from "svelte";
  import { useQueryClient } from "@tanstack/svelte-query";
  import type { SshStatus } from "./api";
  import { PASSPHRASE_NAME } from "./passphrase";
  import { createProvisionerKeyModel } from "./provisioner.svelte";
  import UsernameHint from "./UsernameHint.svelte";

  // The card of the link `/ssh?target=<id>&provisioner=1`. The CLI cannot tap a passkey, so the owner makes the
  // provisioner key here. The command waits for the key and goes on by itself. Mount it fresh for each use.
  let {
    targetId,
    status,
    onclose,
  }: {
    targetId: string;
    /** The last status that loaded. A failed refetch keeps it. */
    status: SshStatus;
    onclose: () => void;
  } = $props();

  const model = createProvisionerKeyModel({
    client: useQueryClient(),
    targetId: untrack(() => targetId),
    status: () => status,
  });
  const uid = $props.id();
  const wrap = "min-w-0 [overflow-wrap:anywhere]";
  const EXISTS = "The hub already holds a provisioner key for this target.";
</script>

<Sheet.Root
  open={true}
  onOpenChange={(value) => {
    if (!value && !model.busy) onclose();
  }}
>
  <Sheet.Content
    side="bottom"
    class="mx-auto max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-2xl border-x pb-[calc(1rem+env(safe-area-inset-bottom))]"
  >
    <Sheet.Header>
      <Sheet.Title>Make the provisioner key</Sheet.Title>
      <Sheet.Description class="text-xs {wrap}">Target {targetId}</Sheet.Description>
    </Sheet.Header>
    <div class="grid min-w-0 gap-3 px-4" data-provisioner-key>
      {#if model.loading}
        <p class="text-sm text-muted-foreground">Loading the target...</p>
      {:else if model.failed}
        <Alert.Root variant="destructive" role="alert">
          <Alert.Description class={wrap}>{model.loadProblem}</Alert.Description>
        </Alert.Root>
      {:else if !model.eligible}
        <Alert.Root variant="destructive" role="alert">
          <Alert.Description class={wrap}>{model.refusal}</Alert.Description>
        </Alert.Root>
      {:else if model.finished}
        <Alert.Root role="status">
          <Alert.Description class="{wrap} grid gap-1">
            <span class="font-semibold">
              {model.existing ? EXISTS : "The provisioner key is made."}
            </span>
            {#if model.fingerprint}<span class="font-mono text-xs">{model.fingerprint}</span>{/if}
            <span>Go back to the command on your own machine. It goes on by itself and installs the key.</span>
          </Alert.Description>
        </Alert.Root>
      {:else}
        <p class="text-sm">
          The hub makes a second key for {targetId}. It changes the key line on the machine later, and only after you
          approve each change. The hub locks it with your {status.method === "prf" ? "passkey" : "passphrase"}.
        </p>
        {#if status.method === "prf"}
          <p class="text-sm text-muted-foreground">The passkey asks you to confirm.</p>
        {:else}
          <div class="grid gap-1">
            <Label for="{uid}-pass">Passphrase</Label>
            <UsernameHint />
            <Input
              id="{uid}-pass"
              name={PASSPHRASE_NAME}
              type="password"
              class="h-11"
              autocomplete="current-password"
              autocapitalize="off"
              spellcheck={false}
              disabled={model.busy}
              bind:value={model.passphrase}
            />
          </div>
        {/if}
      {/if}
      {#if model.problem}
        <Alert.Root variant="destructive" role="alert">
          <Alert.Description class={wrap}>{model.problem} Try again, or close this card.</Alert.Description>
        </Alert.Root>
      {/if}
    </div>
    <Sheet.Footer class="px-4">
      {#if model.eligible && !model.finished}
        <Button type="button" size="touch" disabled={model.busy} onclick={model.submit}>
          {model.busy ? "Working..." : "Make the key"}
        </Button>
      {/if}
      <Button type="button" variant="outline" size="touch" disabled={model.busy} onclick={onclose}>
        {model.finished ? "Close" : "Cancel"}
      </Button>
    </Sheet.Footer>
  </Sheet.Content>
</Sheet.Root>

<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import * as Sheet from "#lib/components/ui/sheet/index.js";
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { ApiError } from "../../shared/http";
  import { getSalt, getTarget, type SshStatus, type Unlock } from "./api";
  import { createProvisionerKeyMutation } from "./mutations";
  import { PASSPHRASE_NAME } from "./passphrase";
  import { toBase64Url, unlockWithPasskey } from "./prf";
  import { SSH_KEY } from "./queries";
  import UsernameHint from "./UsernameHint.svelte";

  // The card of the link `/ssh?target=<id>&provisioner=1`, which `claude-rc ssh target add --provisioner` prints for an
  // owner with a passkey. The CLI cannot tap a passkey, so the owner makes the provisioner key here. The command waits
  // for the key and goes on by itself. Mount it fresh for each use. A secret (a passkey output, a passphrase) lives in
  // a local variable of one call, and the passphrase field is cleared when the call ends.
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

  const client = useQueryClient();
  const make = createMutation(() => createProvisionerKeyMutation(client));
  const uid = $props.id();
  const wrap = "min-w-0 [overflow-wrap:anywhere]";
  // The text of the 409 of the hub for a second key.
  const HAS_PROVISIONER_KEY_TEXT = "the target has a provisioner key already";
  const EXISTS = "The hub already holds a provisioner key for this target.";

  let passphrase = $state("");
  let busy = $state(false);
  let problem = $state("");
  let fingerprint = $state("");
  let existing = $state(false);

  const loaded = createQuery(() => ({
    queryKey: [...SSH_KEY, "target", targetId] as readonly string[],
    queryFn: () => getTarget(targetId),
    retry: false as const,
    staleTime: 0,
  }));
  const eligible = $derived(
    loaded.data !== undefined &&
      loaded.data.managedHost === undefined &&
      loaded.data.systemType !== "windows" &&
      loaded.data.keyFingerprint !== undefined,
  );
  const finished = $derived(fingerprint !== "" || existing);

  async function withUnlock<T>(use: (unlock: Unlock) => Promise<T>): Promise<T> {
    try {
      if (status.method === "prf") {
        if (!status.credentialId) throw new Error("The hub has no passkey on record.");
        const { salt } = await getSalt(targetId, "provisioner");
        return await use({ method: "prf", secret: await unlockWithPasskey(status.credentialId, salt) });
      }

      if (passphrase === "") throw new Error("Type the passphrase.");
      return await use({ method: "passphrase", secret: toBase64Url(new TextEncoder().encode(passphrase)) });
    } finally {
      passphrase = "";
    }
  }

  async function submit() {
    if (busy) return;
    busy = true;
    problem = "";

    try {
      const made = await withUnlock((unlock) => make.mutateAsync({ id: targetId, unlock }));
      fingerprint = made.fingerprint;
    } catch (error) {
      // A second key is refused. The command that waits can use the key that exists, so this is not a dead end.
      if (error instanceof ApiError && error.status === 409 && error.message === HAS_PROVISIONER_KEY_TEXT)
        existing = true;
      else problem = error instanceof Error ? error.message : "The key could not be made.";
    } finally {
      make.reset();
      busy = false;
    }
  }
</script>

<Sheet.Root
  open={true}
  onOpenChange={(value) => {
    if (!value && !busy) onclose();
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
      {#if loaded.isPending}
        <p class="text-sm text-muted-foreground">Loading the target...</p>
      {:else if loaded.error}
        <Alert.Root variant="destructive" role="alert">
          <Alert.Description class={wrap}>
            Could not load the target: {loaded.error.message}. Close this card and open the link again.
          </Alert.Description>
        </Alert.Root>
      {:else if !eligible}
        <Alert.Root variant="destructive" role="alert">
          <Alert.Description class={wrap}>
            This target cannot have a provisioner key. Only an external linux or synology target with a key has one.
            Close this card and run the command again.
          </Alert.Description>
        </Alert.Root>
      {:else if finished}
        <Alert.Root role="status">
          <Alert.Description class="{wrap} grid gap-1">
            <span class="font-semibold">
              {existing ? EXISTS : "The provisioner key is made."}
            </span>
            {#if fingerprint}<span class="font-mono text-xs">{fingerprint}</span>{/if}
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
              disabled={busy}
              bind:value={passphrase}
            />
          </div>
        {/if}
      {/if}
      {#if problem}
        <Alert.Root variant="destructive" role="alert">
          <Alert.Description class={wrap}>{problem} Try again, or close this card.</Alert.Description>
        </Alert.Root>
      {/if}
    </div>
    <Sheet.Footer class="px-4">
      {#if eligible && !finished}
        <Button type="button" size="touch" disabled={busy} onclick={submit}>
          {busy ? "Working..." : "Make the key"}
        </Button>
      {/if}
      <Button type="button" variant="outline" size="touch" disabled={busy} onclick={onclose}>
        {finished ? "Close" : "Cancel"}
      </Button>
    </Sheet.Footer>
  </Sheet.Content>
</Sheet.Root>

<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import UsernameHint from "./UsernameHint.svelte";
  import { PASSPHRASE_NAME } from "./passphrase";
  import * as Sheet from "#lib/components/ui/sheet/index.js";
  import { untrack } from "svelte";
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { hostsQuery } from "../hosts";
  import { getSalt, type Grant, type SshStatus, type Unlock } from "./api";
  import { hostLabel } from "./hostlabel";
  import { approveGrantMutation } from "./mutations";
  import { toBase64Url, unlockWithPasskey } from "./prf";
  import { targetsQuery } from "./queries";

  // The owner reads one request and approves it. Mount it fresh for each grant: it reads `grant` once, so a refetch of
  // the list that changes or drops the grant never changes the sheet. The node cannot prove which instance asked, so
  // the instance is only "claimed by the session". Approval needs a new unlock: a secret (a passphrase, a PRF output)
  // lives in a local variable of one call, and the passphrase field is cleared when the call ends, whatever the answer.
  let {
    grant,
    status,
    onclose,
  }: {
    grant: Grant;
    /** The last status that loaded. A failed refetch keeps it. */
    status: SshStatus;
    onclose: () => void;
  } = $props();

  const client = useQueryClient();
  const targets = createQuery(() => targetsQuery());
  const hosts = createQuery(() => hostsQuery());
  const approve = createMutation(() => approveGrantMutation(client));
  const uid = $props.id();
  const wrap = "min-w-0 [overflow-wrap:anywhere]";
  const WARNING = "This gives the full power of the account on the target. The target cannot limit it to read-only.";

  const target = $derived(targets.data?.find((item) => item.id === grant.targetId));
  // A number input binds a number, or null while the field is empty.
  let minutes = $state<number | null>(untrack(() => grant.minutes));
  let passphrase = $state("");
  let busy = $state(false);
  let problem = $state("");

  async function withUnlock<T>(use: (unlock: Unlock) => Promise<T>): Promise<T> {
    try {
      if (status.method === "prf") {
        if (!status.credentialId) throw new Error("The hub has no passkey on record.");
        const { salt } = await getSalt(grant.targetId);
        return await use({ method: "prf", secret: await unlockWithPasskey(status.credentialId, salt) });
      }

      if (passphrase === "") throw new Error("Type the passphrase.");
      return await use({ method: "passphrase", secret: toBase64Url(new TextEncoder().encode(passphrase)) });
    } finally {
      passphrase = "";
    }
  }

  async function submit() {
    const count = minutes;
    problem = "";

    if (count === null || !Number.isInteger(count) || count < 1 || count > 480) {
      problem = "The minutes must be a whole number from 1 to 480.";
      return;
    }

    busy = true;

    try {
      await withUnlock((unlock) => approve.mutateAsync({ id: grant.id, unlock, minutes: count }));
      onclose();
    } catch (error) {
      problem = error instanceof Error ? error.message : "The approval failed.";
    } finally {
      approve.reset();
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
      <Sheet.Title>Approve SSH access</Sheet.Title>
      <Sheet.Description class="sr-only">Check the request, unlock, and approve it.</Sheet.Description>
    </Sheet.Header>
    <div class="grid min-w-0 gap-3 px-4">
      <dl class="grid min-w-0 gap-1.5 text-sm">
        <div class="flex min-w-0 justify-between gap-3">
          <dt class="text-muted-foreground">Node</dt>
          <dd class={wrap}>{hostLabel(grant.nodeId, hosts.data)}</dd>
        </div>
        <div class="flex min-w-0 justify-between gap-3">
          <dt class="text-muted-foreground">Instance</dt>
          <dd class={wrap}>{grant.instanceId} (claimed by the session)</dd>
        </div>
        <div class="flex min-w-0 justify-between gap-3">
          <dt class="text-muted-foreground">Target</dt>
          <dd class={wrap}>
            {grant.targetId}{#if target}
              <span class="block font-mono text-xs">{target.account}@{target.address}:{target.port}</span>
            {/if}
          </dd>
        </div>
        <div class="flex min-w-0 justify-between gap-3">
          <dt class="text-muted-foreground">Requested</dt>
          <dd>{grant.minutes} minutes</dd>
        </div>
        {#if grant.reason}
          <div class="flex min-w-0 justify-between gap-3">
            <dt class="text-muted-foreground">Reason</dt>
            <dd class={wrap}>{grant.reason}</dd>
          </div>
        {/if}
      </dl>
      <Alert.Root role="note" variant="destructive">
        <Alert.Description class={wrap}>{WARNING}</Alert.Description>
      </Alert.Root>
      <div class="grid gap-1">
        <Label for="{uid}-minutes">Minutes (1 to 480)</Label>
        <Input
          id="{uid}-minutes"
          type="number"
          inputmode="numeric"
          min="1"
          max="480"
          step="1"
          class="h-11"
          disabled={busy}
          bind:value={minutes}
        />
      </div>
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
      {#if problem}
        <Alert.Root variant="destructive" role="alert">
          <Alert.Description class={wrap}>{problem}</Alert.Description>
        </Alert.Root>
      {/if}
    </div>
    <Sheet.Footer class="px-4">
      <Button type="button" size="touch" disabled={busy} onclick={submit}>{busy ? "Approving..." : "Approve"}</Button>
      <Button type="button" variant="outline" size="touch" disabled={busy} onclick={onclose}>Cancel</Button>
    </Sheet.Footer>
  </Sheet.Content>
</Sheet.Root>

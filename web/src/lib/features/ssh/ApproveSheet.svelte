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
  import { getSalt, listGrants, type Grant, type Maintenance, type SshStatus, type Unlock } from "./api";
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

  const MAINTENANCE_WARNING =
    "It uses the provisioner key, not the key of a session. The change runs as soon as you approve.";
  const ACTIONS: Record<Maintenance["action"], string> = {
    sources: "Change the nodes",
    uninstall: "Retire: remove the key lines",
    install: "Put the key line back",
  };
  const work = $derived(grant.maintenance);
  const list = (items: string[]) => (items.length ? items.join(", ") : "none");
  const nodeNames = (ids: string[]) => (ids.length ? ids.map((id) => hostLabel(id, hosts.data)).join(", ") : "none");
  const headline = (maintenance: Maintenance, id: string) =>
    maintenance.action === "uninstall" ? `This removes the key line on ${id}.` : `This changes the key line on ${id}.`;
  const sameAddresses = $derived(work?.action === "sources" && list(work.fromSources) === list(work.toSources ?? []));
  // After a failed run the grant has ended, so a second approve can only give 409.
  let finished = $state(false);

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
        const { salt } = await getSalt(grant.targetId, work ? "provisioner" : "main");
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

    if (!work && (count === null || !Number.isInteger(count) || count < 1 || count > 480)) {
      problem = "The minutes must be a whole number from 1 to 480.";
      return;
    }

    busy = true;

    try {
      const done = await withUnlock((unlock) =>
        approve.mutateAsync({ id: grant.id, unlock, ...(work || count === null ? {} : { minutes: count }) }),
      );

      // A maintenance run that failed ends the grant, and the hub still answers 200. The owner must read why.
      if (done.maintenance?.result === "failed") {
        problem = `The change failed. ${done.maintenance.detail ?? ""}`.trim();
        finished = true;
        return;
      }

      onclose();
    } catch (error) {
      problem = error instanceof Error ? error.message : "The approval failed.";

      // The hub answers an error with a text only. The record of the grant holds the result and the detail.
      if (work) {
        try {
          const found = (await listGrants()).find((item) => item.id === grant.id)?.maintenance;
          if (found?.result === "failed") {
            problem = `The change failed. ${found.detail ?? (error instanceof Error ? error.message : "")}`;
            finished = true;
          }
        } catch {
          /* keep the error text */
        }
      }
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
      <Sheet.Title>{work ? "Approve SSH maintenance" : "Approve SSH access"}</Sheet.Title>
      <Sheet.Description class="sr-only">Check the request, unlock, and approve it.</Sheet.Description>
    </Sheet.Header>
    <div class="grid min-w-0 gap-3 px-4">
      <dl class="grid min-w-0 gap-1.5 text-sm">
        {#if work}
          <div class="flex min-w-0 justify-between gap-3">
            <dt class="text-muted-foreground">Action</dt>
            <dd class="{wrap} font-semibold">{ACTIONS[work.action]}</dd>
          </div>
        {:else}
          <div class="flex min-w-0 justify-between gap-3">
            <dt class="text-muted-foreground">Node</dt>
            <dd class={wrap}>{hostLabel(grant.nodeId, hosts.data)}</dd>
          </div>
          <div class="flex min-w-0 justify-between gap-3">
            <dt class="text-muted-foreground">Instance</dt>
            <dd class={wrap}>{grant.instanceId} (claimed by the session)</dd>
          </div>
        {/if}
        <div class="flex min-w-0 justify-between gap-3">
          <dt class="text-muted-foreground">Target</dt>
          <dd class={wrap}>
            {grant.targetId}{#if target}
              <span class="block font-mono text-xs">{target.account}@{target.address}:{target.port}</span>
            {/if}
          </dd>
        </div>
        {#if !work}
          <div class="flex min-w-0 justify-between gap-3">
            <dt class="text-muted-foreground">Requested</dt>
            <dd>{grant.minutes} minutes</dd>
          </div>
        {/if}
        {#if grant.reason}
          <div class="flex min-w-0 justify-between gap-3">
            <dt class="text-muted-foreground">Reason</dt>
            <dd class={wrap}>{grant.reason}</dd>
          </div>
        {/if}
      </dl>
      {#if work}
        <Alert.Root role="note" variant="destructive">
          <Alert.Description class="{wrap} grid gap-1">
            <span class="font-semibold">{headline(work, grant.targetId)}</span>
            {#if work.action === "sources"}
              {#if sameAddresses}
                <span>The list of addresses does not change: {list(work.fromSources)}</span>
              {:else}
                <span>SSH will be allowed only from: {list(work.toSources ?? [])}</span>
                <span>from: {list(work.fromSources)}</span>
              {/if}
              <span class="text-xs">
                Nodes now: {nodeNames(work.fromNodes)}. Nodes after: {nodeNames(work.toNodes ?? [])}.
              </span>
            {:else if work.action === "install"}
              <span>SSH will be allowed only from: {list(work.fromSources)}</span>
              <span class="text-xs">Nodes: {nodeNames(work.fromNodes)}</span>
            {:else}
              <span>The addresses now allowed: {list(work.fromSources)}</span>
              <span class="text-xs">Nodes: {nodeNames(work.fromNodes)}</span>
            {/if}
            <span>{MAINTENANCE_WARNING}</span>
          </Alert.Description>
        </Alert.Root>
      {:else}
        <Alert.Root role="note" variant="destructive">
          <Alert.Description class={wrap}>{WARNING}</Alert.Description>
        </Alert.Root>
      {/if}
      {#if !work}
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
      {/if}
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
      {#if !finished}
        <Button type="button" size="touch" disabled={busy} onclick={submit}>{busy ? "Approving..." : "Approve"}</Button>
      {/if}
      <Button type="button" variant="outline" size="touch" disabled={busy} onclick={onclose}>
        {finished ? "Close" : "Cancel"}
      </Button>
    </Sheet.Footer>
  </Sheet.Content>
</Sheet.Root>

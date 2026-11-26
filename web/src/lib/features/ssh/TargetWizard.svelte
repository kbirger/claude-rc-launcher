<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import * as Sheet from "#lib/components/ui/sheet/index.js";
  import { untrack } from "svelte";
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { hostsQuery } from "../hosts";
  import { getProvision, getSalt, getTarget, type HostKeyLine, type SshStatus, type Target, type Unlock } from "./api";
  import { hostLabel } from "./hostlabel";
  import {
    authorizeManagedMutation,
    createKeyMutation,
    createTargetMutation,
    pinHostKeyMutation,
    pinManagedMutation,
    scanHostKeyMutation,
    testTargetMutation,
  } from "./mutations";
  import { toBase64Url, unlockWithPasskey } from "./prf";
  import { SSH_KEY } from "./queries";
  import { longEnough, MIN_PASSPHRASE, PASSPHRASE_NAME, TOO_SHORT } from "./passphrase";
  import TargetForm from "./TargetForm.svelte";
  import UsernameHint from "./UsernameHint.svelte";

  // Adds a target and walks it through the key, the host key, the install and the test. Mount it fresh for each use: it
  // reads `targetId` once. With a `targetId` it loads that target and starts at the first step that is not done.
  //
  // From then on the step is local state that moves forward on each successful call. A refetch of the target, the
  // status or the list never moves it and never unmounts a step: the scanned fingerprints, the install line and the
  // typed text stay. A secret (a passphrase, a PRF output) lives in a local variable of one call. Each call that
  // needs an unlock makes a new one, and the passphrase field is cleared when the call ends.
  let {
    targetId,
    status,
    onclose,
  }: {
    targetId?: string;
    /** The last status that loaded. A failed refetch keeps it. */
    status: SshStatus;
    onclose: () => void;
  } = $props();

  type Step = "form" | "key" | "hostkey" | "install" | "test" | "done";
  const ORDER: Step[] = ["form", "key", "hostkey", "install", "test", "done"];
  const TITLES: Record<Step, string> = {
    form: "Target",
    key: "Key",
    hostkey: "Host key",
    install: "Install",
    test: "Test",
    done: "Ready",
  };

  const client = useQueryClient();
  const hosts = createQuery(() => hostsQuery());
  const create = createMutation(() => createTargetMutation(client));
  const keyCall = createMutation(() => createKeyMutation(client));
  const testCall = createMutation(() => testTargetMutation(client));
  const scan = createMutation(() => scanHostKeyMutation());
  const pin = createMutation(() => pinHostKeyMutation(client));
  const pinFromNode = createMutation(() => pinManagedMutation(client));
  const authorize = createMutation(() => authorizeManagedMutation());
  const uid = $props.id();
  const wrap = "min-w-0 [overflow-wrap:anywhere]";
  const field = "border-input bg-card h-11 w-full min-w-0 rounded-lg border px-2.5 text-base md:text-sm";

  // `null` while the target of `targetId` loads. It is set once and never goes back.
  let step = $state<Step | null>(untrack(() => (targetId ? null : "form")));
  let target = $state<Target | undefined>();
  let notes = $state<string[]>([]);
  let installLine = $state("");
  let found = $state<HostKeyLine[]>([]);
  let matched = $state(false);
  let busy = $state(false);
  let problem = $state("");
  let copied = $state("");
  let passphrase = $state("");
  let nodeChoice = $state("");
  let testFailure = $state("");

  const loaded = createQuery(() => ({
    queryKey: [...SSH_KEY, "target", targetId ?? ""] as readonly string[],
    queryFn: () => getTarget(targetId!),
    enabled: targetId !== undefined,
    retry: false as const,
    staleTime: 0,
  }));

  $effect(() => {
    const detail = loaded.data;
    if (step !== null || !detail) return;
    target = detail;
    notes = detail.notes;
    // The hub refuses a second key, so a target with a key never gets the key step.
    step = detail.state === "ready" ? "done" : !detail.keyFingerprint ? "key" : !detail.hostKey ? "hostkey" : "install";
  });

  const external = $derived(target?.managedHost === undefined);
  const allowed = $derived(target?.nodes ?? []);
  const node = $derived(allowed.includes(nodeChoice) ? nodeChoice : (allowed[0] ?? ""));
  const needsScript = $derived(step === "install" && external && installLine === "");
  const script = createQuery(() => ({
    queryKey: [...SSH_KEY, "provision", target?.id ?? ""] as readonly string[],
    queryFn: () => getProvision(target!.id),
    enabled: needsScript,
    retry: false as const,
  }));
  const position = $derived(step ? ORDER.indexOf(step) + 1 : 0);

  async function act(call: () => Promise<void>) {
    busy = true;
    problem = "";

    try {
      await call();
    } catch (error) {
      problem = error instanceof Error ? error.message : "The call failed.";
    } finally {
      busy = false;
    }
  }

  // A new unlock for one call. The secret is in this call and its caller only. The passphrase field is cleared when
  // the call ends, whatever the answer.
  async function withUnlock<T>(use: (unlock: Unlock) => Promise<T>, isNew = false): Promise<T> {
    if (status.method !== "prf" && isNew && !longEnough(passphrase)) throw new Error(TOO_SHORT);

    try {
      if (status.method === "prf") {
        if (!status.credentialId) throw new Error("The hub has no passkey on record.");
        const { salt } = await getSalt(target!.id);
        return await use({ method: "prf", secret: await unlockWithPasskey(status.credentialId, salt) });
      }

      if (passphrase === "") throw new Error("Type the passphrase.");
      return await use({ method: "passphrase", secret: toBase64Url(new TextEncoder().encode(passphrase)) });
    } finally {
      passphrase = "";
    }
  }

  const submitForm = (body: Parameters<typeof create.mutateAsync>[0]) =>
    act(async () => {
      target = await create.mutateAsync(body);
      step = "key";
    });

  const makeKey = () =>
    act(async () => {
      try {
        const made = await withUnlock(
          (unlock) => keyCall.mutateAsync({ id: target!.id, unlock }),
          status.hasKeys === false,
        );
        installLine = made.installLine;
        notes = made.notes;
        step = "hostkey";
      } finally {
        keyCall.reset();
      }
    });

  const scanKey = () =>
    act(async () => {
      matched = false;
      found = (await scan.mutateAsync({ id: target!.id, node })).keys;
      if (found.length === 0) throw new Error("The scan found no host key.");
    });

  const pinScanned = () =>
    act(async () => {
      const chosen = found.find((item) => item.line.startsWith("ssh-ed25519 ")) ?? found[0];
      if (!matched || !chosen) return;
      target = await pin.mutateAsync({ id: target!.id, hostKey: chosen.line });
      step = "install";
    });

  const pinManagedKey = () =>
    act(async () => {
      found = (await pinFromNode.mutateAsync(target!.id)).keys;
      step = "install";
    });

  const installOnNode = () =>
    act(async () => {
      await authorize.mutateAsync(target!.id);
      step = "test";
    });

  const runTest = () =>
    act(async () => {
      testFailure = "";

      try {
        const result = await withUnlock((unlock) => testCall.mutateAsync({ id: target!.id, node, unlock }));

        if (result.ok) step = "done";
        else testFailure = result.error ?? "The test failed.";
      } finally {
        testCall.reset();
      }
    });

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = label;
    } catch {
      copied = "";
      problem = "The browser did not allow the copy. Select the text and copy it.";
    }
  }
</script>

{#snippet unlockField(isNew: boolean)}
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
        autocomplete={isNew ? "new-password" : "current-password"}
        autocapitalize="off"
        spellcheck={false}
        bind:value={passphrase}
      />
      {#if isNew}
        <p class="text-xs text-muted-foreground">
          Use at least {MIN_PASSPHRASE} characters. A password manager can make and save one.
        </p>
      {/if}
    </div>
  {/if}
{/snippet}

<Sheet.Root
  open={true}
  onOpenChange={(value) => {
    if (!value) onclose();
  }}
>
  <Sheet.Content
    side="bottom"
    class="mx-auto max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-2xl border-x pb-[calc(1rem+env(safe-area-inset-bottom))]"
  >
    <Sheet.Header>
      <Sheet.Title>{target ? `Set up ${target.id}` : "Add a target"}</Sheet.Title>
      <Sheet.Description class="text-xs">
        {step ? `Step ${position} of ${ORDER.length}: ${TITLES[step]}` : "Loading the target"}
      </Sheet.Description>
    </Sheet.Header>
    <div class="grid min-w-0 gap-3 px-4">
      {#if step === null}
        {#if loaded.error}
          <Alert.Root variant="destructive" role="alert">
            <Alert.Description>Could not load the target: {loaded.error.message}</Alert.Description>
          </Alert.Root>
        {:else}
          <p class="text-sm text-muted-foreground">Loading the target...</p>
        {/if}
      {:else if step === "form"}
        <TargetForm
          nodes={status.nodes.filter((item) => item.enabled)}
          hosts={hosts.data}
          {busy}
          {problem}
          localAddress={status.nodes.find((item) => item.host === "local")?.sourceAddress ?? ""}
          onsubmit={submitForm}
        />
      {:else}
        {#if step === "key"}
          <p class="text-sm">
            The hub makes an SSH key for this target and locks it with your {status.method === "prf"
              ? "passkey"
              : "passphrase"}.
          </p>
          {@render unlockField(status.hasKeys === false)}
        {:else if step === "hostkey"}
          {#if external}
            <p class="text-sm">
              The hub reads the host key of the target through a node. Compare each fingerprint with the one the target
              shows, then confirm.
            </p>
            {#if allowed.length > 1}
              <div class="grid gap-1">
                <Label for="{uid}-scan-node">Node</Label>
                <select id="{uid}-scan-node" class={field} bind:value={() => node, (value) => (nodeChoice = value)}>
                  {#each allowed as item (item)}
                    <option value={item}>{hostLabel(item, hosts.data)}</option>
                  {/each}
                </select>
              </div>
            {/if}
            {#if found.length > 0}
              <ul class="grid min-w-0 gap-1">
                {#each found as item (item.line)}
                  <li class="font-mono text-xs {wrap}" data-fingerprint>{item.fingerprint}</li>
                {/each}
              </ul>
              <Label class="flex min-h-11 items-center gap-3 rounded-lg border p-3">
                <input type="checkbox" bind:checked={matched} />
                <span>They match</span>
              </Label>
            {/if}
          {:else}
            <p class="text-sm">
              The hub reads the host key from the node that holds the target. No question is needed.
            </p>
          {/if}
        {:else if step === "install"}
          {#if external}
            <p class="text-sm">
              Add this line to the authorized_keys file of {target?.account} on the target. The line limits the key to the
              source addresses of the nodes.
            </p>
            {#if installLine}
              <code class="block rounded-lg border bg-muted p-3 font-mono text-xs break-all select-all">
                {installLine}
              </code>
              <div>
                <Button type="button" variant="outline" size="touch" onclick={() => copy(installLine, "line")}>
                  Copy
                </Button>
                {#if copied === "line"}<span class="ml-2 text-sm text-muted-foreground">Copied</span>{/if}
              </div>
            {:else if script.data}
              <p class="text-sm text-muted-foreground">
                The line is not kept after this step. This script ({script.data.shell}) adds it.
              </p>
              <code
                class="block max-h-60 overflow-auto rounded-lg border bg-muted p-3 font-mono text-xs break-all whitespace-pre-wrap select-all"
              >
                {script.data.script}
              </code>
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="touch"
                  onclick={() => copy(script.data!.script, "script")}
                >
                  Copy
                </Button>
                {#if copied === "script"}<span class="ml-2 text-sm text-muted-foreground">Copied</span>{/if}
              </div>
            {:else if script.error}
              <Alert.Root variant="destructive" role="alert">
                <Alert.Description>Could not load the install script: {script.error.message}</Alert.Description>
              </Alert.Root>
            {:else}
              <p class="text-sm text-muted-foreground">Loading the install script...</p>
            {/if}
            {#each notes as note (note)}
              <p class="text-sm text-muted-foreground {wrap}" data-note>{note}</p>
            {/each}
            <p class="text-xs text-muted-foreground">
              <code class="font-mono">claude-rc ssh target add</code> can do the install over SSH from your own machine.
            </p>
          {:else}
            <p class="text-sm">The hub adds the key to the target through the node.</p>
          {/if}
        {:else if step === "test"}
          <p class="text-sm">
            A test opens a connection for one minute and needs a new unlock. A failed test leaves the target in draft.
          </p>
          {#if allowed.length > 1}
            <div class="grid gap-1">
              <Label for="{uid}-test-node">Node</Label>
              <select id="{uid}-test-node" class={field} bind:value={() => node, (value) => (nodeChoice = value)}>
                {#each allowed as item (item)}
                  <option value={item}>{hostLabel(item, hosts.data)}</option>
                {/each}
              </select>
            </div>
          {/if}
          {@render unlockField(false)}
          {#if testFailure}
            <Alert.Root variant="destructive" role="alert">
              <Alert.Description class="font-mono text-xs {wrap}">{testFailure}</Alert.Description>
            </Alert.Root>
          {/if}
        {:else}
          <Alert.Root role="status">
            <Alert.Description>The test passed. {target?.id} is ready.</Alert.Description>
          </Alert.Root>
          {#if external && target && (target.systemType === "linux" || target.systemType === "synology") && !target.provisionerFingerprint}
            <p class="text-sm text-muted-foreground {wrap}" data-provisioner-hint>
              To change the nodes of this target later with one approval, add the provisioner. On your own machine, run:
              <code class="mt-1 block rounded border bg-muted p-2 font-mono text-xs select-all">
                claude-rc ssh target provisioner {target.id} --identity &lt;file&gt;
              </code>
            </p>
          {/if}
        {/if}

        {#if problem}
          <Alert.Root variant="destructive" role="alert"><Alert.Description>{problem}</Alert.Description></Alert.Root>
        {/if}
      {/if}
    </div>
    <Sheet.Footer class="px-4">
      {#if step === "key"}
        <Button type="button" size="touch" disabled={busy} onclick={makeKey}>
          {busy ? "Working..." : "Create key"}
        </Button>
      {:else if step === "hostkey"}
        {#if !external}
          <Button type="button" size="touch" disabled={busy} onclick={pinManagedKey}>Pin from the node</Button>
        {:else}
          <Button
            type="button"
            size="touch"
            variant={found.length > 0 ? "outline" : "default"}
            disabled={busy || node === ""}
            onclick={scanKey}
          >
            {found.length > 0 ? "Scan again" : "Scan host key"}
          </Button>
          {#if found.length > 0}
            <Button type="button" size="touch" disabled={busy || !matched} onclick={pinScanned}>Pin host key</Button>
          {/if}
        {/if}
      {:else if step === "install"}
        {#if external}
          <Button type="button" size="touch" onclick={() => (step = "test")}>I installed it</Button>
        {:else}
          <Button type="button" size="touch" disabled={busy} onclick={installOnNode}>Install on the node</Button>
        {/if}
      {:else if step === "test"}
        <Button type="button" size="touch" disabled={busy || node === ""} onclick={runTest}>
          {busy ? "Working..." : testFailure ? "Try again" : "Test connection"}
        </Button>
      {/if}
      <Button type="button" variant="outline" size="touch" onclick={onclose}>
        {step === "done" ? "Close" : "Cancel"}
      </Button>
    </Sheet.Footer>
  </Sheet.Content>
</Sheet.Root>

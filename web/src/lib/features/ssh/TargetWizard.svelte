<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Checkbox } from "#lib/components/ui/checkbox/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import * as Select from "#lib/components/ui/select/index.js";
  import * as Sheet from "#lib/components/ui/sheet/index.js";
  import { untrack } from "svelte";
  import { useQueryClient } from "@tanstack/svelte-query";
  import type { SshStatus } from "./api";
  import { hostLabel } from "./hostlabel";
  import { MIN_PASSPHRASE, PASSPHRASE_NAME } from "./passphrase";
  import TargetForm from "./TargetForm.svelte";
  import UsernameHint from "./UsernameHint.svelte";
  import { createTargetWizardModel, WIZARD_STEPS, WIZARD_TITLES } from "./wizard.svelte";

  // Adds a target and walks it through the key, the host key, the install and the test. The wizard model holds the
  // steps. Mount it fresh for each use: it reads `targetId` once.
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

  const model = createTargetWizardModel({
    client: useQueryClient(),
    targetId: untrack(() => targetId),
    status: () => status,
  });
  const uid = $props.id();
  const wrap = "min-w-0 [overflow-wrap:anywhere]";
  const step = $derived(model.step);
  const target = $derived(model.target);
  const script = model.script;
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
        bind:value={model.passphrase}
      />
      {#if isNew}
        <p class="text-xs text-muted-foreground">
          Use at least {MIN_PASSPHRASE} characters. A password manager can make and save one.
        </p>
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet noNode()}
  <Alert.Root variant="destructive" role="alert">
    <Alert.Description>
      No node of this target has SSH access on. Turn it on, with a source address, on the Nodes card.
    </Alert.Description>
  </Alert.Root>
{/snippet}

{#snippet nodeSelect(name: string, label: string)}
  <div class="grid gap-1">
    <Label for="{uid}-{name}">{label}</Label>
    <Select.Root type="single" bind:value={model.node}>
      <Select.Trigger id="{uid}-{name}" class="w-full min-w-0 data-[size=default]:h-11">
        {hostLabel(model.node, model.hosts)}
      </Select.Trigger>
      <Select.Content>
        {#each model.allowed as item (item)}
          <Select.Item value={item} label={hostLabel(item, model.hosts)}>{hostLabel(item, model.hosts)}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </div>
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
        {step ? `Step ${model.position} of ${WIZARD_STEPS.length}: ${WIZARD_TITLES[step]}` : "Loading the target"}
      </Sheet.Description>
    </Sheet.Header>
    <div class="grid min-w-0 gap-3 px-4">
      {#if step === null}
        {#if model.loaded.error}
          <Alert.Root variant="destructive" role="alert">
            <Alert.Description>Could not load the target: {model.loaded.error.message}</Alert.Description>
          </Alert.Root>
        {:else}
          <p class="text-sm text-muted-foreground">Loading the target...</p>
        {/if}
      {:else if step === "form"}
        <TargetForm
          nodes={status.nodes.filter((item) => item.enabled)}
          hosts={model.hosts}
          busy={model.busy}
          problem={model.problem}
          localAddress={status.nodes.find((item) => item.host === "local")?.sourceAddress ?? ""}
          onsubmit={model.submitForm}
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
          {#if model.external}
            <p class="text-sm">
              The hub reads the host key of the target through a node. Compare each fingerprint with the one the target
              shows, then confirm.
            </p>
            {#if model.allowed.length === 0}
              {@render noNode()}
            {:else if model.allowed.length > 1}
              {@render nodeSelect("scan-node", "Read the host key from this node")}
            {/if}
            {#if model.found.length > 0}
              <ul class="grid min-w-0 gap-1">
                {#each model.found as item (item.line)}
                  <li class="font-mono text-xs {wrap}" data-fingerprint>{item.fingerprint}</li>
                {/each}
              </ul>
              <Label class="flex min-h-11 items-center gap-3 rounded-lg border p-3">
                <Checkbox bind:checked={model.matched} />
                <span>They match</span>
              </Label>
            {/if}
          {:else}
            <p class="text-sm">
              The hub reads the host key from the node that holds the target. No question is needed.
            </p>
          {/if}
        {:else if step === "install"}
          {#if model.external}
            {#if target?.systemType === "dropbear"}
              <p class="text-sm" data-dropbear-line>
                Add this line to the Authorized Keys of the router. Dropbear does not support from=, so the router does
                not limit this key by address. Your approval of each request is the control.
              </p>
            {:else}
              <p class="text-sm">
                Add this line to the authorized_keys file of {target?.account} on the target. The line limits the key to the
                source addresses of the nodes.
              </p>
            {/if}
            {#if model.installLine}
              <code class="block rounded-lg border bg-muted p-3 font-mono text-xs break-all select-all">
                {model.installLine}
              </code>
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="touch"
                  onclick={() => model.copy(model.installLine, "line")}
                >
                  Copy
                </Button>
                {#if model.copied === "line"}<span class="ml-2 text-sm text-muted-foreground">Copied</span>{/if}
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
                  onclick={() => model.copy(script.data!.script, "script")}
                >
                  Copy
                </Button>
                {#if model.copied === "script"}<span class="ml-2 text-sm text-muted-foreground">Copied</span>{/if}
              </div>
            {:else if script.error}
              <Alert.Root variant="destructive" role="alert">
                <Alert.Description>Could not load the install script: {script.error.message}</Alert.Description>
              </Alert.Root>
            {:else}
              <p class="text-sm text-muted-foreground">Loading the install script...</p>
            {/if}
            {#each model.notes as note (note)}
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
            A test connects to the target from the node you choose. The address of that node must be allowed for this
            target. The test opens a connection for one minute and needs a new unlock. A failed test leaves the target
            in draft.
          </p>
          {#if model.sshdSkipped}
            <p class="text-sm text-muted-foreground" data-sshd-note>
              The node did not check that sshd reads the key file. It is not root, or its version is older.
            </p>
          {/if}
          {#if model.allowed.length === 0}
            {@render noNode()}
          {:else if model.allowed.length > 1}
            {@render nodeSelect("test-node", "Run the test from this node")}
          {/if}
          {@render unlockField(false)}
          {#if model.testFailure}
            <Alert.Root variant="destructive" role="alert">
              <Alert.Description class="font-mono text-xs {wrap}">{model.testFailure}</Alert.Description>
            </Alert.Root>
          {/if}
        {:else}
          <Alert.Root role="status">
            <Alert.Description>The test passed. {target?.id} is ready.</Alert.Description>
          </Alert.Root>
          {#if model.external && target && target.systemType !== "windows" && !target.provisionerFingerprint}
            <p class="text-sm text-muted-foreground {wrap}" data-provisioner-hint>
              To change the nodes of this target later with one approval, add the provisioner. On your own machine, run:
              <code class="mt-1 block rounded border bg-muted p-2 font-mono text-xs select-all">
                claude-rc ssh target provisioner {target.id} --identity &lt;file&gt;
              </code>
            </p>
          {/if}
        {/if}

        {#if model.problem}
          <Alert.Root variant="destructive" role="alert">
            <Alert.Description>{model.problem}</Alert.Description>
          </Alert.Root>
        {/if}
      {/if}
    </div>
    <Sheet.Footer class="px-4">
      {#if step === "key"}
        <Button type="button" size="touch" disabled={model.busy} onclick={model.makeKey}>
          {model.busy ? "Working..." : "Create key"}
        </Button>
      {:else if step === "hostkey"}
        {#if !model.external}
          <Button type="button" size="touch" disabled={model.busy} onclick={model.pinManagedKey}>
            Pin from the node
          </Button>
        {:else}
          <Button
            type="button"
            size="touch"
            variant={model.found.length > 0 ? "outline" : "default"}
            disabled={model.busy || model.node === ""}
            onclick={model.scanKey}
          >
            {model.found.length > 0 ? "Scan again" : "Scan host key"}
          </Button>
          {#if model.found.length > 0}
            <Button type="button" size="touch" disabled={model.busy || !model.matched} onclick={model.pinScanned}>
              Pin host key
            </Button>
          {/if}
        {/if}
      {:else if step === "install"}
        {#if model.external}
          <Button type="button" size="touch" onclick={model.installed}>I installed it</Button>
        {:else}
          <Button type="button" size="touch" disabled={model.busy} onclick={model.installOnNode}>
            Install on the node
          </Button>
        {/if}
      {:else if step === "test"}
        <Button type="button" size="touch" disabled={model.busy || model.node === ""} onclick={model.runTest}>
          {model.busy ? "Working..." : model.testFailure ? "Try again" : "Test connection"}
        </Button>
      {/if}
      <Button type="button" variant="outline" size="touch" onclick={onclose}>
        {step === "done" ? "Close" : "Cancel"}
      </Button>
    </Sheet.Footer>
  </Sheet.Content>
</Sheet.Root>

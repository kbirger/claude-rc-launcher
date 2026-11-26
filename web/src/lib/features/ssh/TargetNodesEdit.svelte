<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import type { HostInfo } from "../hosts";
  import { ApiError } from "../../shared/http";
  import {
    CONFIRM_NODES_SUFFIX,
    isMaintenanceAnswer,
    type Grant,
    type NodeStatus,
    type Target,
    type TargetNodesResult,
  } from "./api";
  import { patchTargetNodesMutation } from "./mutations";
  import NodePicker from "./NodePicker.svelte";

  // Changes the nodes of one target. Only nodes with SSH access on are offered, and the nodes that the target has now
  // stay on the list so that they can be taken out. After a save, an external target shows the new key line, which the
  // owner installs in place of the old line. A managed target gets the new line from the hub. A target with a provisioner
  // stores nothing at the save: the hub answers with a request that the owner approves, and only a good run stores the
  // new list. A list that allows none of the addresses in use needs a yes first.
  let {
    target,
    nodes,
    hosts,
    ondone,
    onapprove,
  }: {
    target: Target;
    /** The nodes of the status: the ones with access on are offered. Undefined while the status loads. */
    nodes: NodeStatus[] | undefined;
    hosts: HostInfo[] | undefined;
    ondone: () => void;
    /** Opens the approve sheet of a grant. Without it, the text points to the list of requests. */
    onapprove?: (grant: Grant) => void;
  } = $props();

  const client = useQueryClient();
  const save = createMutation(() => patchTargetNodesMutation(client));

  const enabled = $derived((nodes ?? []).filter((node) => node.enabled).map((node) => node.host));
  // A target that has a key needs one node with access, because its key line holds the source addresses. Without a key,
  // the hub accepts an empty list.
  const hasKey = $derived(target.keyFingerprint !== undefined);
  // svelte-ignore state_referenced_locally
  let picked = $state<string[]>([...target.nodes]);
  let problem = $state("");
  let result = $state<TargetNodesResult | null>(null);
  // The request that waits for the approval of the owner, and the question about a list that locks every address out.
  let waiting = $state<Grant | null>(null);
  let question = $state("");
  let copied = $state(false);
  const viaApproval = $derived(target.managedHost === undefined && target.provisionerFingerprint !== undefined);

  const changed = $derived(
    picked.length !== target.nodes.length || picked.some((host) => !target.nodes.includes(host)),
  );
  const valid = $derived(nodes !== undefined && changed && (picked.length > 0 || !hasKey));

  async function send(confirm: boolean) {
    if (!valid || save.isPending) return;
    problem = "";

    try {
      const answer = await save.mutateAsync({ id: target.id, nodes: [...picked], ...(confirm ? { confirm } : {}) });
      question = "";
      if (isMaintenanceAnswer(answer)) waiting = answer.maintenance;
      else result = answer;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.message.endsWith(CONFIRM_NODES_SUFFIX)) {
        const text = error.message.slice(0, -CONFIRM_NODES_SUFFIX.length);
        question = `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
      } else problem = error instanceof Error ? error.message : "The change failed.";
    }
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    void send(false);
  }

  function approveNow() {
    if (!waiting) return;
    onapprove?.(waiting);
    ondone();
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      copied = false;
      problem = "The browser did not allow the copy. Select the text and copy it.";
    }
  }
</script>

{#if waiting}
  <div class="grid gap-2" data-nodes-waiting>
    <Alert.Root role="status">
      <Alert.Description class="grid gap-1 [overflow-wrap:anywhere]">
        <span class="font-semibold">The change is not saved yet. You must approve the request.</span>
        <span>
          The request to change the nodes of {target.id} waits in the list of access requests. The hub changes the key line
          on the machine only after you approve it. Until then the nodes stay as they are. If you do not approve, nothing
          changes.
        </span>
      </Alert.Description>
    </Alert.Root>
    <div class="flex flex-wrap gap-2">
      {#if onapprove}<Button type="button" size="touch" onclick={approveNow}>Approve now</Button>{/if}
      <Button type="button" variant="outline" size="touch" onclick={ondone}>
        {onapprove ? "Later" : "Done"}
      </Button>
    </div>
  </div>
{:else if question}
  <div class="grid gap-2" data-nodes-confirm>
    <Alert.Root variant="destructive" role="alert">
      <Alert.Description class="grid gap-1 [overflow-wrap:anywhere]">
        <span class="font-semibold">{question}</span>
        <span>
          Nothing has changed yet. If you go on, the request asks for a key line that allows only the new nodes. Do you
          want to go on?
        </span>
      </Alert.Description>
    </Alert.Root>
    {#if problem}
      <Alert.Root variant="destructive" role="alert"><Alert.Description>{problem}</Alert.Description></Alert.Root>
    {/if}
    <div class="flex flex-wrap gap-2">
      <Button type="button" size="touch" disabled={save.isPending} onclick={() => send(true)}>
        {save.isPending ? "Working..." : "Yes, ask for this change"}
      </Button>
      <Button type="button" variant="outline" size="touch" disabled={save.isPending} onclick={() => (question = "")}>
        No, go back
      </Button>
    </div>
  </div>
{:else if result}
  <div class="grid gap-2" data-nodes-saved>
    <Alert.Root role="status">
      <Alert.Description>
        The nodes of {target.id} are saved.
        {#if result.lineUpdated}The key line on the machine was updated.{/if}
        {#if result.pushed === false}
          Some nodes could not be told yet. They get the change when they connect again.{/if}
      </Alert.Description>
    </Alert.Root>
    {#if result.installLine}
      <p class="text-sm">
        The key line changed. On the target, replace the old line that ends with claude-rc:{target.id} in the authorized keys
        file of the account {target.account} with this line.
      </p>
      <code class="block rounded-lg border bg-muted p-3 font-mono text-xs break-all select-all">
        {result.installLine}
      </code>
      <div>
        <Button type="button" variant="outline" size="touch" onclick={() => copy(result!.installLine!)}>Copy</Button>
        {#if copied}<span class="ml-2 text-sm text-muted-foreground">Copied</span>{/if}
      </div>
    {/if}
    {#if problem}
      <Alert.Root variant="destructive" role="alert"><Alert.Description>{problem}</Alert.Description></Alert.Root>
    {/if}
    <div><Button type="button" size="touch" onclick={ondone}>Done</Button></div>
  </div>
{:else}
  <form class="grid min-w-0 gap-3" onsubmit={submit}>
    {#if nodes === undefined}
      <p class="text-sm text-muted-foreground">Loading the nodes...</p>
    {:else}
      <NodePicker nodes={enabled} {hosts} bind:picked legend="Nodes that can reach {target.id}" off={target.nodes} />
      {#if !hasKey}
        <p class="text-xs text-muted-foreground">
          This target has no key yet. The list is saved and nothing else changes.
        </p>
      {:else if viaApproval}
        <p class="text-xs text-muted-foreground">
          The change needs your approval. After the save, a request waits for you. The list changes only after the hub
          has changed the key line on the machine.
        </p>
      {:else if target.managedHost !== undefined}
        <p class="text-xs text-muted-foreground">
          The hub updates the key line on the machine. If that fails, the nodes stay as they are.
        </p>
      {:else}
        <p class="text-xs text-muted-foreground">After the save, you get the new key line to install on the target.</p>
      {/if}
      {#if hasKey}
        <p class="text-xs text-muted-foreground">At least one node must have access turned on.</p>
      {/if}
    {/if}
    {#if problem}
      <Alert.Root variant="destructive" role="alert"><Alert.Description>{problem}</Alert.Description></Alert.Root>
    {/if}
    <div class="flex flex-wrap gap-2">
      <Button type="submit" size="touch" disabled={!valid || save.isPending}>
        {save.isPending ? "Working..." : "Save"}
      </Button>
      <Button type="button" variant="outline" size="touch" onclick={ondone}>Cancel</Button>
    </div>
  </form>
{/if}

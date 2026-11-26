<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import type { HostInfo } from "../hosts";
  import type { NodeStatus, Target, TargetNodesResult } from "./api";
  import { patchTargetNodesMutation } from "./mutations";
  import NodePicker from "./NodePicker.svelte";

  // Changes the nodes of one target. Only nodes with SSH access on are offered, and the nodes that the target has now
  // stay on the list so that they can be taken out. After a save, an external target shows the new key line, which the
  // owner installs in place of the old line. A managed target gets the new line from the hub.
  let {
    target,
    nodes,
    hosts,
    ondone,
  }: {
    target: Target;
    /** The nodes of the status: the ones with access on are offered. */
    nodes: NodeStatus[];
    hosts: HostInfo[] | undefined;
    ondone: () => void;
  } = $props();

  const client = useQueryClient();
  const save = createMutation(() => patchTargetNodesMutation(client));

  const enabled = $derived(nodes.filter((node) => node.enabled).map((node) => node.host));
  // svelte-ignore state_referenced_locally
  let picked = $state<string[]>([...target.nodes]);
  let problem = $state("");
  let result = $state<TargetNodesResult | null>(null);
  let copied = $state(false);

  const changed = $derived(
    picked.length !== target.nodes.length || picked.some((host) => !target.nodes.includes(host)),
  );
  const valid = $derived(picked.length > 0 && changed);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!valid || save.isPending) return;
    problem = "";

    try {
      result = await save.mutateAsync({ id: target.id, nodes: [...picked] });
    } catch (error) {
      problem = error instanceof Error ? error.message : "The change failed.";
    }
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

{#if result}
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
        The key line changed. On the target, replace the old line that ends with claude-rc:{target.id} in the authorized_keys
        file of {target.account} with this line.
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
    <NodePicker nodes={enabled} {hosts} bind:picked legend="Nodes that can reach {target.id}" off={target.nodes} />
    {#if target.managedHost !== undefined}
      <p class="text-xs text-muted-foreground">
        The hub updates the key line on the machine. If that fails, the nodes stay as they are.
      </p>
    {:else}
      <p class="text-xs text-muted-foreground">After the save, you get the new key line to install on the target.</p>
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

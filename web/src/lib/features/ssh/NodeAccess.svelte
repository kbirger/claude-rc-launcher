<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { hostsQuery } from "../hosts";
  import type { NodeStatus } from "./api";
  import { hostLabel } from "./hostlabel";
  import { putNodeMutation } from "./mutations";

  // The nodes that may carry a grant. Each row has a switch and the source address: the address that the targets see
  // when this node connects, which the hub writes into the `from=` limit of the key line. A node cannot be turned on
  // without an address. Turning a node off keeps the address. For a node that is on, a changed address needs Save: it
  // goes into the `from=` limit of the next install line.
  let { nodes }: { nodes: NodeStatus[] } = $props();

  const client = useQueryClient();
  const hosts = createQuery(() => hostsQuery());
  const save = createMutation(() => putNodeMutation(client));
  const uid = $props.id();

  // The text of each field while the owner types, by host id. Absent: the address from the status.
  let drafts = $state<Record<string, string>>({});
  let problems = $state<Record<string, string>>({});
  const addressOf = (node: NodeStatus) => drafts[node.host] ?? node.sourceAddress;

  /** An enabled node whose typed address is not the stored one. */
  const changed = (node: NodeStatus) => node.enabled && addressOf(node).trim() !== node.sourceAddress;

  async function saveAddress(node: NodeStatus) {
    const sourceAddress = addressOf(node).trim();
    problems[node.host] = "";

    if (sourceAddress === "") {
      problems[node.host] = "Enter the source address, or turn this node off.";
      return;
    }

    try {
      await save.mutateAsync({ host: node.host, enabled: true, sourceAddress });
      delete drafts[node.host];
    } catch (error) {
      problems[node.host] = error instanceof Error ? error.message : "The change failed.";
    }
  }

  async function change(node: NodeStatus, box: HTMLInputElement) {
    const enabled = box.checked;
    const typed = addressOf(node).trim();
    // Turning off sends the address that is known, so that a cleared field does not erase it.
    const sourceAddress = enabled ? typed : typed || node.sourceAddress;
    problems[node.host] = "";

    if (enabled && sourceAddress === "") {
      box.checked = false;
      problems[node.host] = "Enter the source address before you turn this node on.";
      return;
    }

    try {
      await save.mutateAsync({ host: node.host, enabled, sourceAddress });
      delete drafts[node.host];
    } catch (error) {
      box.checked = node.enabled;
      problems[node.host] = error instanceof Error ? error.message : "The change failed.";
    }
  }
</script>

<section class="grid gap-3">
  <h3 class="font-heading text-base font-bold">Nodes</h3>
  {#if nodes.length === 0}
    <p class="text-sm text-muted-foreground">No nodes are known yet.</p>
  {/if}
  <ul class="grid min-w-0 gap-2">
    {#each nodes as node (node.host)}
      <li data-node class="grid min-w-0 gap-2 rounded-lg border bg-card p-3">
        <Label class="flex min-h-11 items-center justify-between gap-3">
          <span class="min-w-0 font-medium [overflow-wrap:anywhere]">{hostLabel(node.host, hosts.data)}</span>
          <input
            type="checkbox"
            role="switch"
            class="size-5 shrink-0"
            checked={node.enabled}
            disabled={save.isPending}
            onchange={(event) => change(node, event.currentTarget)}
          />
        </Label>
        <div class="grid gap-1">
          <Label for="{uid}-{node.host}" class="text-xs text-muted-foreground">
            Source address (what the targets see when this node connects)
          </Label>
          <Input
            id="{uid}-{node.host}"
            type="text"
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            class="h-11 font-mono"
            value={addressOf(node)}
            oninput={(event) => (drafts[node.host] = event.currentTarget.value)}
          />
        </div>
        {#if changed(node)}
          <div class="flex flex-wrap gap-2">
            <Button size="touch" disabled={save.isPending} onclick={() => saveAddress(node)}>Save</Button>
          </div>
        {/if}
        {#if problems[node.host]}
          <p role="alert" class="text-sm text-destructive">{problems[node.host]}</p>
        {/if}
      </li>
    {/each}
  </ul>
</section>

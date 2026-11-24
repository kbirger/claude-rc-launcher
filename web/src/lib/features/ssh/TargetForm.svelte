<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import type { HostInfo } from "../hosts";
  import type { NewTarget, NodeStatus, SystemType } from "./api";
  import { hostLabel } from "./hostlabel";

  // The first step of the wizard: the data of a new target. The hub checks the same rules again.
  let {
    nodes,
    hosts,
    busy,
    problem,
    onsubmit,
  }: {
    /** The nodes that have SSH access turned on. */
    nodes: NodeStatus[];
    hosts: HostInfo[] | undefined;
    busy: boolean;
    problem: string;
    onsubmit: (body: NewTarget) => void;
  } = $props();

  const uid = $props.id();
  const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
  const TYPES: SystemType[] = ["linux", "windows", "synology", "dropbear"];
  const field = "border-input bg-card h-11 w-full min-w-0 rounded-lg border px-2.5 text-base md:text-sm";

  let id = $state("");
  let kind = $state<"external" | "managed">("external");
  let managedHost = $state("");
  let systemType = $state<SystemType>("linux");
  let address = $state("");
  let port = $state("");
  let account = $state("");
  let picked = $state<string[]>([]);

  const idOk = $derived(ID_RE.test(id));
  const portOk = $derived(port.trim() === "" || (/^\d+$/.test(port.trim()) && +port >= 1 && +port <= 65535));
  const external = $derived(kind === "external");
  const valid = $derived(
    idOk &&
      portOk &&
      account.trim() !== "" &&
      picked.length > 0 &&
      (external ? address.trim() !== "" : managedHost !== ""),
  );

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!valid || busy) return;
    onsubmit({
      id,
      account: account.trim(),
      systemType,
      nodes: [...picked],
      ...(external ? {} : { managedHost }),
      ...(address.trim() ? { address: address.trim() } : {}),
      ...(port.trim() ? { port: Number(port) } : {}),
    });
  }
</script>

<form class="grid min-w-0 gap-3" onsubmit={submit}>
  <div class="grid gap-1">
    <Label for="{uid}-id">Target id</Label>
    <Input
      id="{uid}-id"
      class="h-11 font-mono"
      bind:value={id}
      autocapitalize="off"
      autocomplete="off"
      spellcheck={false}
      aria-invalid={id !== "" && !idOk}
    />
    <p class="text-xs text-muted-foreground">
      Lower case letters, digits and dashes, 1 to 32 characters, and it starts with a letter or digit.
    </p>
  </div>

  <fieldset class="grid gap-2">
    <legend class="sr-only">Kind</legend>
    <Label class="flex min-h-11 items-center gap-3 rounded-lg border p-3">
      <input type="radio" name="{uid}-kind" value="external" bind:group={kind} />
      <span class="font-medium">External</span>
      <span class="text-xs font-normal text-muted-foreground">A machine you reach by address.</span>
    </Label>
    <Label class="flex min-h-11 items-center gap-3 rounded-lg border p-3">
      <input type="radio" name="{uid}-kind" value="managed" bind:group={kind} />
      <span class="font-medium">Managed</span>
      <span class="text-xs font-normal text-muted-foreground">A node of this hub.</span>
    </Label>
  </fieldset>

  {#if !external}
    <div class="grid gap-1">
      <Label for="{uid}-host">Managed host</Label>
      <select id="{uid}-host" class={field} bind:value={managedHost}>
        <option value="">Choose a host</option>
        {#each hosts ?? [] as host (host.id)}
          <option value={host.id}>{hostLabel(host.id, hosts)}</option>
        {/each}
      </select>
    </div>
  {/if}

  <div class="grid gap-1">
    <Label for="{uid}-type">System type</Label>
    <select id="{uid}-type" class={field} bind:value={systemType}>
      {#each TYPES as type (type)}
        <option value={type}>{type}</option>
      {/each}
    </select>
  </div>

  <div class="grid grid-cols-[1fr_6rem] gap-2">
    <div class="grid gap-1">
      <Label for="{uid}-address">Address{external ? "" : " (optional)"}</Label>
      <Input
        id="{uid}-address"
        class="h-11 font-mono"
        bind:value={address}
        autocapitalize="off"
        autocomplete="off"
        spellcheck={false}
      />
    </div>
    <div class="grid gap-1">
      <Label for="{uid}-port">Port</Label>
      <Input
        id="{uid}-port"
        class="h-11 font-mono"
        inputmode="numeric"
        placeholder="22"
        bind:value={port}
        aria-invalid={!portOk}
      />
    </div>
  </div>

  <div class="grid gap-1">
    <Label for="{uid}-account">Account</Label>
    <Input
      id="{uid}-account"
      class="h-11 font-mono"
      bind:value={account}
      autocapitalize="off"
      autocomplete="off"
      spellcheck={false}
    />
  </div>

  <fieldset class="grid gap-2">
    <legend class="text-sm font-medium">Nodes that can reach the target</legend>
    {#each nodes as node (node.host)}
      <Label class="flex min-h-11 items-center gap-3 rounded-lg border p-3">
        <input type="checkbox" value={node.host} bind:group={picked} />
        <span class="min-w-0 [overflow-wrap:anywhere]">{hostLabel(node.host, hosts)}</span>
      </Label>
    {:else}
      <p class="text-sm text-muted-foreground">No node has SSH access turned on. Turn one on in the list of nodes.</p>
    {/each}
  </fieldset>

  {#if problem}
    <Alert.Root variant="destructive" role="alert"><Alert.Description>{problem}</Alert.Description></Alert.Root>
  {/if}
  <Button type="submit" size="touch" disabled={!valid || busy}>{busy ? "Working..." : "Create target"}</Button>
</form>

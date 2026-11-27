<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import * as RadioGroup from "#lib/components/ui/radio-group/index.js";
  import * as Select from "#lib/components/ui/select/index.js";
  import type { HostInfo } from "../hosts";
  import type { NewTarget, NodeStatus, SystemType } from "./api";
  import { hostLabel } from "./hostlabel";
  import NodePicker from "./NodePicker.svelte";

  // The first step of the wizard: the data of a new target. The hub checks the same rules again.
  let {
    nodes,
    hosts,
    busy,
    problem,
    localAddress = "",
    onsubmit,
  }: {
    /** The nodes that have SSH access turned on. */
    nodes: NodeStatus[];
    hosts: HostInfo[] | undefined;
    busy: boolean;
    problem: string;
    /** The source address that the owner entered for the node `local`. Empty when there is none. */
    localAddress?: string;
    onsubmit: (body: NewTarget) => void;
  } = $props();

  const uid = $props.id();
  const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
  const TYPES: SystemType[] = ["linux", "windows", "synology", "dropbear"];
  const trigger = "w-full min-w-0 data-[size=default]:h-11";

  let id = $state("");
  let kind = $state<"external" | "managed">("external");
  let managedHost = $state("");
  let systemType = $state<SystemType>("linux");
  let address = $state("");
  let port = $state("");
  let account = $state("");
  let keyFile = $state("");
  let picked = $state<string[]>([]);

  const idOk = $derived(ID_RE.test(id));
  const portOk = $derived(port.trim() === "" || (/^\d+$/.test(port.trim()) && +port >= 1 && +port <= 65535));
  const external = $derived(kind === "external");
  // The hub cannot tell how the other nodes see its own host, and the public URL names another machine.
  const isLocal = $derived(!external && managedHost === "local");
  // Only a managed linux or synology target can use another key file.
  const takesKeyFile = $derived(!external && (systemType === "linux" || systemType === "synology"));
  // The hub picks the key file when the field is empty: a linux target gets its own file, synology the main one.
  const keyFilePlaceholder = $derived(systemType === "linux" ? "authorized_keys.claude-rc" : "authorized_keys");
  const valid = $derived(
    idOk &&
      portOk &&
      account.trim() !== "" &&
      picked.length > 0 &&
      (external ? address.trim() !== "" : managedHost !== "" && (!isLocal || address.trim() !== "")),
  );

  // Fill the address of `local` from its source address, and take the fill back when the owner picks another host.
  function pickHost() {
    if (managedHost === "local" && address.trim() === "") address = localAddress;
    else if (managedHost !== "local" && address !== "" && address === localAddress) address = "";
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!valid || busy) return;
    onsubmit({
      id,
      account: account.trim(),
      systemType,
      nodes: [...picked],
      ...(external ? {} : { managedHost }),
      ...(takesKeyFile && keyFile.trim() ? { keyFile: keyFile.trim() } : {}),
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
    <RadioGroup.Root bind:value={() => kind, (value) => (kind = value as typeof kind)} aria-label="Kind">
      <Label class="flex min-h-11 items-center gap-3 rounded-lg border p-3">
        <RadioGroup.Item value="external" />
        <span class="font-medium">External</span>
        <span class="text-xs font-normal text-muted-foreground">A machine you reach by address.</span>
      </Label>
      <Label class="flex min-h-11 items-center gap-3 rounded-lg border p-3">
        <RadioGroup.Item value="managed" />
        <span class="font-medium">Managed</span>
        <span class="text-xs font-normal text-muted-foreground">A node of this hub.</span>
      </Label>
    </RadioGroup.Root>
  </fieldset>

  {#if !external}
    <div class="grid gap-1">
      <Label for="{uid}-host">Managed host</Label>
      <Select.Root
        type="single"
        value={managedHost}
        onValueChange={(value) => {
          managedHost = value;
          pickHost();
        }}
      >
        <Select.Trigger id="{uid}-host" class={trigger}>
          {managedHost ? hostLabel(managedHost, hosts) : "Choose a host"}
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="" label="Choose a host">Choose a host</Select.Item>
          {#each hosts ?? [] as host (host.id)}
            <Select.Item value={host.id} label={hostLabel(host.id, hosts)}>{hostLabel(host.id, hosts)}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </div>
  {/if}

  <div class="grid gap-1">
    <Label for="{uid}-type">System type</Label>
    <Select.Root type="single" bind:value={() => systemType, (value) => (systemType = value as SystemType)}>
      <Select.Trigger id="{uid}-type" class={trigger}>{systemType}</Select.Trigger>
      <Select.Content>
        {#each TYPES as type (type)}
          <Select.Item value={type} label={type}>{type}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </div>

  <div class="grid grid-cols-[1fr_6rem] gap-2">
    <div class="grid gap-1">
      <Label for="{uid}-address">Address{external || isLocal ? "" : " (optional)"}</Label>
      <Input
        id="{uid}-address"
        class="h-11 font-mono"
        bind:value={address}
        autocapitalize="off"
        autocomplete="off"
        spellcheck={false}
      />
      {#if isLocal}
        <p class="text-xs text-muted-foreground">
          The LAN address of this machine as the other nodes see it. The hub cannot tell it.
        </p>
      {/if}
    </div>
    <div class="grid gap-1">
      <Label for="{uid}-port">Port</Label>
      <Input
        id="{uid}-port"
        autocomplete="off"
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

  {#if takesKeyFile}
    <div class="grid gap-1">
      <Label for="{uid}-keyfile">Key file (optional)</Label>
      <Input
        id="{uid}-keyfile"
        class="h-11 font-mono"
        placeholder={keyFilePlaceholder}
        bind:value={keyFile}
        autocapitalize="off"
        autocomplete="off"
        spellcheck={false}
      />
      {#if systemType === "linux"}
        <p class="text-xs text-muted-foreground">
          Empty uses authorized_keys.claude-rc, a file that no other tool writes. Type authorized_keys to use the main
          file.
        </p>
        <p class="text-xs text-muted-foreground">
          The machine needs the sshd drop-in. Run sudo claude-rc node sshd install once.
        </p>
      {:else}
        <p class="text-xs text-muted-foreground">
          Use another file when a job rewrites authorized_keys. sshd must list the file in AuthorizedKeysFile. The node
          must be up to date. To change the file later, retire the target and add it again.
        </p>
      {/if}
    </div>
  {/if}

  <NodePicker nodes={nodes.map((node) => node.host)} {hosts} bind:picked />

  {#if problem}
    <Alert.Root variant="destructive" role="alert"><Alert.Description>{problem}</Alert.Description></Alert.Root>
  {/if}
  <Button type="submit" size="touch" disabled={!valid || busy}>{busy ? "Working..." : "Create target"}</Button>
</form>

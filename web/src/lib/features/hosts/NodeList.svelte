<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import ArrowUp from "@tabler/icons-svelte/icons/circle-arrow-up";
  import Circle from "@tabler/icons-svelte/icons/circle";
  import Close from "@tabler/icons-svelte/icons/x";
  import Check from "@tabler/icons-svelte/icons/circle-check";
  import Pencil from "@tabler/icons-svelte/icons/pencil";
  import EntityCard from "#lib/components/EntityCard.svelte";
  import StatusDot from "#lib/components/StatusDot.svelte";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { cn } from "#lib/utils.js";
  import ConfirmDialog, { type Ask } from "../../shared/ui/ConfirmDialog.svelte";
  import type { HostInfo } from "./api";
  import { components, roleOf } from "./nodeline";

  // The look of a node badge: it grows with its text and wraps (the shadcn Badge is one fixed-height line). Primary marks the hub.
  const BADGE = "h-auto min-h-6 max-w-full gap-1.5 px-2.5 whitespace-normal [overflow-wrap:anywhere]";
  const PRIMARY = "border-primary/40 bg-primary/10 text-primary";
  const MUTED = "bg-muted text-muted-foreground";

  // `latest` is the newest release; a component behind it (or a service behind the hub) gets the update badge.
  // `onrename` makes the name of a node (one that was paired with the CLI, not the hub) editable. It rejects with the error to show.
  // `onupdate` updates a node to the latest release. It rejects with the error to show.
  let {
    hosts,
    selected,
    onselect,
    latest,
    onrename,
    onupdate,
  }: {
    hosts: HostInfo[];
    selected: string;
    onselect: (id: string) => void;
    latest?: string;
    onrename?: (id: string, name: string) => Promise<unknown>;
    onupdate?: (value: HostInfo) => Promise<unknown>;
  } = $props();

  let editing = $state<string | null>(null);
  let draft = $state("");
  let error = $state("");
  let saving = $state(false);
  let updating = $state<string | null>(null);
  let ask = $state<Ask | null>(null);
  let updateError = $state<Record<string, string>>({});
  const renamable = (hostInfo: HostInfo) => !!onrename && hostInfo.id !== "local" && hostInfo.source === "managed";
  function edit(hostInfo: HostInfo) {
    editing = hostInfo.id;
    draft = hostInfo.name;
    error = "";
  }
  async function save(hostInfo: HostInfo) {
    const name = draft.trim();
    if (!name || name === hostInfo.name) return void (editing = null);
    saving = true;

    try {
      await onrename!(hostInfo.id, name);
      editing = null;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      saving = false;
    }
  }
  async function update(hostInfo: HostInfo) {
    updating = hostInfo.id;
    delete updateError[hostInfo.id];

    try {
      await onupdate!(hostInfo);
    } catch (caught) {
      updateError[hostInfo.id] = caught instanceof Error ? caught.message : String(caught);
    } finally {
      updating = null;
    }
  }

  const hasContent = (hostInfo: HostInfo) =>
    hostInfo.status === "ok" || (editing === hostInfo.id && !!error) || !!updateError[hostInfo.id] || !!hostInfo.error;
</script>

<ul class="grid gap-3" aria-label="Nodes">
  {#each hosts as host (host.id)}
    {#snippet title()}{host.name}{/snippet}
    {#snippet titleEditor()}
      <form
        id="rename-{host.id}"
        class="flex min-w-0 flex-1 basis-32"
        onsubmit={(event) => {
          event.preventDefault();
          void save(host);
        }}
      >
        <Input
          autofocus
          bind:value={draft}
          maxlength={64}
          aria-label="Node name"
          class="h-7 flex-1 px-2 font-semibold"
          onkeydown={(event) => event.key === "Escape" && (editing = null)}
        />
      </form>
    {/snippet}
    <!-- The hub is the special node, so its pill has the primary tone. An agent has the plain pill. -->
    {#snippet titleAside()}<Badge variant="outline" class={cn(BADGE, roleOf(host) === "hub" ? PRIMARY : MUTED)}>
        {roleOf(host)}
      </Badge>{/snippet}
    <!-- The health of the node is a plain dot: green (ok), orange (restarting) or red (any other status). The status is the tooltip and the label for a screen reader. -->
    {#snippet status()}
      <StatusDot
        tone={host.status === "ok" ? "ok" : host.status === "restarting" ? "warn" : "bad"}
        label="Status: {host.status}"
      />
    {/snippet}
    <!-- One pill for each component, with its update badge, then the error texts. -->
    {#snippet content()}
      {#if host.status === "ok"}
        {#each components(host, latest) as component (component.key)}
          <Badge variant="outline" class={cn(BADGE, MUTED)}>
            {component.text}
            {#if component.outdated}
              <span
                class="size-2 flex-none rounded-full bg-warning"
                title="Update available"
                role="img"
                aria-label="Update available for the {component.key}"
              ></span>
            {/if}
          </Badge>
        {/each}
      {/if}
      {#if editing === host.id && error}<span class="w-full text-xs text-destructive" role="alert">{error}</span>{/if}
      {#if updateError[host.id]}<span class="w-full text-xs text-destructive" role="alert">
          {updateError[host.id]}
        </span>{/if}
      {#if host.status !== "ok" && host.error}
        <span class="w-full text-xs text-muted-foreground [overflow-wrap:anywhere]">{host.error}</span>
      {/if}
    {/snippet}
    {#snippet actions()}
      {#if editing === host.id}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          class="h-8 px-2 text-muted-foreground"
          onclick={() => (editing = null)}
          aria-label="Cancel rename"
        >
          <Close aria-hidden="true" />Cancel
        </Button>
      {:else}
        <Button
          variant="ghost"
          size="sm"
          class="h-8 px-2 text-muted-foreground"
          onclick={() => edit(host)}
          aria-label="Rename {host.name}"
        >
          <Pencil aria-hidden="true" />Rename
        </Button>
      {/if}
    {/snippet}
    {#snippet actionsEnd()}
      {#if editing === host.id}
        <Button
          type="submit"
          form="rename-{host.id}"
          variant="ghost"
          size="sm"
          class="h-8 px-2 text-primary"
          disabled={saving}
          aria-label="Save name"
        >
          <Check aria-hidden="true" />Save
        </Button>
      {:else}
        {#if onupdate && host.status === "ok" && components(host, latest).some((component) => component.outdated)}
          <!-- The yellow dot on the pill shows that a component is behind. This button updates the service and the client of the node. -->
          <Button
            variant="ghost"
            size="sm"
            class="h-8 px-2 text-warning hover:bg-warning/10 hover:text-warning"
            disabled={updating === host.id}
            onclick={() =>
              (ask = {
                title: `Update ${host.name}?`,
                body: "The update replaces the service and the client of this node.",
                label: "Update",
                run: () => update(host),
              })}
            aria-label="Update {host.name}"
          >
            <ArrowUp aria-hidden="true" />{updating === host.id ? "Updating..." : "Update"}
          </Button>
        {/if}
        <!-- One button for the state of the node in the app: Active (the node in use), Use (it can be used), or Unavailable (it is not running). -->
        <Button
          variant="ghost"
          size="sm"
          class={cn("h-8 min-w-24 px-2", host.id === selected && "text-primary disabled:opacity-100")}
          disabled={host.id === selected || host.status !== "ok"}
          onclick={() => onselect(host.id)}
          aria-pressed={host.id === selected}
        >
          {#if host.id === selected}<Check aria-hidden="true" />Active{:else if host.status === "ok"}<Circle
              aria-hidden="true"
            />Use{:else}<Circle aria-hidden="true" />Unavailable{/if}
        </Button>
      {/if}
    {/snippet}
    <li class="min-w-0">
      <EntityCard
        {title}
        titleText={host.name}
        titleEditor={editing === host.id ? titleEditor : undefined}
        {titleAside}
        {status}
        selected={host.id === selected}
        children={hasContent(host) ? content : undefined}
        actions={editing === host.id || renamable(host) ? actions : undefined}
        {actionsEnd}
      />
    </li>
  {/each}
</ul>
<ConfirmDialog bind:ask />

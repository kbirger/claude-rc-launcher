<script lang="ts">
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import EntityCard, { stripLabel } from "#lib/components/EntityCard.svelte";
  import StatusDot from "#lib/components/StatusDot.svelte";
  import ChevronDown from "@tabler/icons-svelte/icons/chevron-down";
  import FileText from "@tabler/icons-svelte/icons/file-text";
  import Pause from "@tabler/icons-svelte/icons/player-pause";
  import Play from "@tabler/icons-svelte/icons/player-play";
  import Stop from "@tabler/icons-svelte/icons/player-stop";
  import SettingsIcon from "@tabler/icons-svelte/icons/settings";
  import { cn } from "#lib/utils.js";
  import { untrack } from "svelte";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { PermissionsLink } from "#lib/features/permissions";
  import { SessionsLink } from "#lib/features/sessions";
  import ActionIcon from "../../shared/ui/ActionIcon.svelte";
  import ConfirmDialog, { type Ask } from "../../shared/ui/ConfirmDialog.svelte";
  import InstanceLogs from "./InstanceLogs.svelte";
  import InstanceSettingsDialog from "./InstanceSettingsDialog.svelte";
  import { createInstancesModel } from "./model.svelte";
  import { isPaused, stateLabel, stateTone } from "./state";
  import type { Instance } from "./api";

  let {
    host,
    startError = "",
    canWrite = true,
  }: {
    host: string;
    startError?: string;
    /** False hides pause, resume, stop and settings: the hub only lets a writer use them. */ canWrite?: boolean;
  } = $props();

  // The model holds the state and the rules. This file draws it. App remounts the list (#key) when the host changes.
  const model = createInstancesModel({
    host: untrack(() => host),
    client: useQueryClient(),
    startError: () => startError,
  });
  // The instances whose logs are open in the card.
  let open = $state<Record<string, true>>({});
  const now = $derived(model.now);

  // A paused instance is idle (grey). Any other state that is not active or failed is a warning.
  const dotTone = (state: string) =>
    isPaused(state) ? "idle" : ({ ok: "ok", failed: "bad", other: "warn" } as const)[stateTone(state)];

  function uptime(state: string, startedAt: string | null): string {
    if (state !== "active" || !startedAt) return "";
    const time = new Date(startedAt).getTime();
    if (Number.isNaN(time)) return "";
    const seconds = Math.max(0, Math.floor((now - time) / 1000));
    const days = Math.floor(seconds / 86400),
      hours = Math.floor((seconds % 86400) / 3600),
      minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `up ${days}d ${hours}h`;
    if (hours > 0) return `up ${hours}h ${minutes}m`;
    return `up ${minutes}m`;
  }

  function toggleLogs(id: string) {
    if (id in open) {
      const { [id]: _unused, ...rest } = open;
      open = rest;
    } else open = { ...open, [id]: true };
  }

  // The instance whose settings dialog is open. The dialog mounts fresh for each open.
  let editing = $state<Instance | null>(null);
  let editOpen = $state(false);
  // Counts the opens: a second open of the same instance must also mount a fresh dialog.
  let opens = $state(0);
  // An old node has no help and its instances have no settings: then there is no Settings action. A reader gets none either.
  const canEditSettings = (instance: Instance) => canWrite && !!model.settingsHelp && !!instance.settings;

  function openSettings(instance: Instance) {
    editing = instance;
    opens++;
    editOpen = true;
  }

  function overflowFor(instance: Instance, pending: boolean) {
    if (!canWrite) return [];
    return [
      ...(canEditSettings(instance)
        ? [{ label: "Settings", icon: SettingsIcon, disabled: pending, onselect: () => openSettings(instance) }]
        : []),
      { label: "Stop", icon: Stop, destructive: true, disabled: pending, onselect: () => stop(instance) },
    ];
  }

  // The question that waits for the user (Stop and Restart).
  let ask = $state<Ask | null>(null);

  // The sessions of the folder stop with the server. They wake when the user opens them on claude.ai, for about four hours.
  // A server that starts with no session is archived at each stop, so nothing comes back.
  function restart(instance: Instance) {
    const body =
      "The sessions of this folder stop. After the restart, open a session on claude.ai to bring it back. This works for about four hours.";
    const warn =
      instance.settings?.createSession === false
        ? " This instance starts with no session. Its sessions are archived at each stop and do not come back."
        : "";
    ask = {
      title: `Restart ${instance.name}?`,
      body: body + warn,
      label: "Restart",
      run: () => model.restart(instance.id),
    };
  }

  function stop(instance: Instance) {
    ask = {
      title: `Stop ${instance.name}?`,
      body: "This removes it from the list. Use Pause to keep it.",
      label: "Stop",
      destructive: true,
      run: () => model.stop(instance.id),
    };
  }
</script>

{#each model.errors as error, index (index)}<Alert.Root variant="destructive">
    <Alert.Description>{error}</Alert.Description>
  </Alert.Root>{/each}
{#if model.loaded && model.rows.length === 0}
  <p class="text-muted-foreground">No running instances. Tap New to start one.</p>
{/if}
<ul class="grid gap-3">
  {#each model.rows as row (row.key)}
    {@const instance = row.instance}
    {#snippet title()}{row.name}{/snippet}
    {#snippet status()}
      {#if row.pending}
        <StatusDot tone="warn" pulse label="{row.pending}..." />
      {:else if instance}
        <StatusDot tone={dotTone(instance.state)} label={stateLabel(instance.state)} />
      {/if}
    {/snippet}
    {#snippet subtitle()}
      {#if instance}
        <p class="font-mono [overflow-wrap:anywhere]">{instance.path}</p>
        {#if instance.user || uptime(instance.state, instance.startedAt)}
          <p>{[instance.user, uptime(instance.state, instance.startedAt)].filter(Boolean).join(" · ")}</p>
        {/if}
      {/if}
    {/snippet}
    {#snippet actions()}
      {#if instance}
        <Button
          variant="ghost"
          size="sm"
          class="h-8 px-2"
          disabled={!!row.pending}
          onclick={() => toggleLogs(instance.id)}
          aria-expanded={instance.id in open}
          title="Logs"
        >
          <FileText aria-hidden="true" /><span class={stripLabel}>Logs</span><ChevronDown
            class={cn("transition-transform", instance.id in open && "rotate-180")}
            aria-hidden="true"
          />
        </Button>
        <SessionsLink {host} instance={instance.id} />
        <PermissionsLink {host} instance={instance.id} />
      {/if}
    {/snippet}
    {#snippet actionsEnd()}
      {#if instance && canWrite}
        {#if isPaused(instance.state)}
          <Button
            variant="ghost"
            size="icon"
            disabled={!!row.pending}
            onclick={() => model.resume(instance.id)}
            aria-label="Resume {row.name}"
            title="Resume"
          >
            <Play aria-hidden="true" />
          </Button>
        {:else}
          <Button
            variant="ghost"
            size="icon"
            disabled={!!row.pending}
            onclick={() => restart(instance)}
            aria-label="Restart {row.name}"
            title="Restart: stops and starts the server"
          >
            <ActionIcon name="refresh" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            disabled={!!row.pending}
            onclick={() => model.pause(instance.id)}
            aria-label="Pause {row.name}"
            title="Pause: stops the service and keeps the instance"
          >
            <Pause aria-hidden="true" />
          </Button>
        {/if}
      {/if}
    {/snippet}
    {#snippet logs()}
      {#if instance}<div class="w-full"><InstanceLogs {host} id={instance.id} /></div>{/if}
    {/snippet}
    <li class="min-w-0">
      <!-- A starting row has no instance yet: it passes no subtitle, strip, or menu, so the card draws none. -->
      <EntityCard
        {title}
        titleText={row.name}
        {status}
        pending={row.pending}
        subtitle={instance ? subtitle : undefined}
        actions={instance ? actions : undefined}
        actionsEnd={instance ? actionsEnd : undefined}
        footer={instance && instance.id in open ? logs : undefined}
        overflowLabel="More actions for {row.name}"
        overflow={instance ? overflowFor(instance, !!row.pending) : []}
      />
    </li>
  {/each}
</ul>
{#if editing && model.settingsHelp}
  {#key opens}
    <InstanceSettingsDialog bind:open={editOpen} {host} instance={editing} help={model.settingsHelp} />
  {/key}
{/if}
<ConfirmDialog bind:ask />

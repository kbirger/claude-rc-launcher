<script lang="ts">
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
  import InstanceLogs from "./InstanceLogs.svelte";
  import InstanceSettingsDialog from "./InstanceSettingsDialog.svelte";
  import { createInstancesModel } from "./model.svelte";
  import { isPaused, stateLabel, stateTone } from "./state";
  import type { Instance } from "./api";

  let { host, startError = "", canWrite = true }: { host: string; startError?: string; /** False hides pause, resume, stop and settings: the hub only lets a writer use them. */ canWrite?: boolean } = $props();

  // The model holds the state and the rules. This file draws it. App remounts the list (#key) when the host changes.
  const model = createInstancesModel({ host: untrack(() => host), client: useQueryClient(), startError: () => startError });
  // The instances whose logs are open in the card.
  let open = $state<Record<string, true>>({});
  const now = $derived(model.now);

  // A paused instance is idle (grey). Any other state that is not active or failed is a warning.
  const dotTone = (state: string) => (isPaused(state) ? "idle" : ({ ok: "ok", failed: "bad", other: "warn" } as const)[stateTone(state)]);

  function uptime(state: string, startedAt: string | null): string {
    if (state !== "active" || !startedAt) return "";
    const t = new Date(startedAt).getTime();
    if (Number.isNaN(t)) return "";
    const s = Math.max(0, Math.floor((now - t) / 1000));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d > 0) return `up ${d}d ${h}h`;
    if (h > 0) return `up ${h}h ${m}m`;
    return `up ${m}m`;
  }

  function toggleLogs(id: string) {
    if (id in open) {
      const { [id]: _, ...rest } = open;
      open = rest;
    } else open = { ...open, [id]: true };
  }

  // The instance whose settings dialog is open. The dialog mounts fresh for each open.
  let editing = $state<Instance | null>(null);
  let editOpen = $state(false);
  // Counts the opens: a second open of the same instance must also mount a fresh dialog.
  let opens = $state(0);
  // An old node has no help and its instances have no settings: then there is no Settings action. A reader gets none either.
  const canEditSettings = (i: Instance) => canWrite && !!model.settingsHelp && !!i.settings;

  function openSettings(i: Instance) {
    editing = i;
    opens++;
    editOpen = true;
  }

  function overflowFor(i: Instance, pending: boolean) {
    if (!canWrite) return [];
    return [
      ...(canEditSettings(i) ? [{ label: "Settings", icon: SettingsIcon, disabled: pending, onselect: () => openSettings(i) }] : []),
      { label: "Stop", icon: Stop, destructive: true, disabled: pending, onselect: () => stop(i) },
    ];
  }

  function stop(i: Instance) {
    if (confirm(`Stop ${i.name}? This removes it from the list. Use Pause to keep it.`)) model.stop(i.id);
  }
</script>

{#each model.errors as e}<p class="text-destructive">{e}</p>{/each}
{#if model.loaded && model.rows.length === 0}
  <p class="text-muted-foreground">No running instances. Tap New to start one.</p>
{/if}
<ul class="m-0 grid list-none gap-3 p-0">
  {#each model.rows as r (r.key)}
    {@const i = r.instance}
    {#snippet title()}{r.name}{/snippet}
    {#snippet status()}
      {#if r.pending}
        <StatusDot tone="warn" pulse label="{r.pending}..." />
      {:else if i}
        <StatusDot tone={dotTone(i.state)} label={stateLabel(i.state)} />
      {/if}
    {/snippet}
    {#snippet subtitle()}
      {#if i}
        <p class="m-0 font-mono [overflow-wrap:anywhere]">{i.path}</p>
        {#if i.user || uptime(i.state, i.startedAt)}
          <p class="m-0">{[i.user, uptime(i.state, i.startedAt)].filter(Boolean).join(" · ")}</p>
        {/if}
      {/if}
    {/snippet}
    {#snippet actions()}
      {#if i}
        <Button variant="ghost" size="sm" class="h-8 px-2" disabled={!!r.pending} onclick={() => toggleLogs(i.id)} aria-expanded={i.id in open} title="Logs">
          <FileText aria-hidden="true" /><span class={stripLabel}>Logs</span><ChevronDown class={cn("transition-transform", i.id in open && "rotate-180")} aria-hidden="true" />
        </Button>
        <SessionsLink {host} instance={i.id} />
        <PermissionsLink {host} instance={i.id} />
      {/if}
    {/snippet}
    {#snippet actionsEnd()}
      {#if i && canWrite}
        {#if isPaused(i.state)}
          <Button variant="ghost" size="icon" class="hover:border-border" disabled={!!r.pending} onclick={() => model.resume(i.id)} aria-label="Resume {r.name}" title="Resume">
            <Play aria-hidden="true" />
          </Button>
        {:else}
          <Button variant="ghost" size="icon" class="hover:border-border" disabled={!!r.pending} onclick={() => model.pause(i.id)} aria-label="Pause {r.name}" title="Pause: stops the service and keeps the instance">
            <Pause aria-hidden="true" />
          </Button>
        {/if}
      {/if}
    {/snippet}
    {#snippet logs()}
      {#if i}<div class="w-full"><InstanceLogs {host} id={i.id} /></div>{/if}
    {/snippet}
    <li class="min-w-0">
      <!-- A starting row has no instance yet: it passes no subtitle, strip, or menu, so the card draws none. -->
      <EntityCard
        {title}
        titleText={r.name}
        {status}
        pending={r.pending}
        subtitle={i ? subtitle : undefined}
        actions={i ? actions : undefined}
        actionsEnd={i ? actionsEnd : undefined}
        footer={i && i.id in open ? logs : undefined}
        overflowLabel="More actions for {r.name}"
        overflow={i ? overflowFor(i, !!r.pending) : []}
      />
    </li>
  {/each}
</ul>
{#if editing && model.settingsHelp}
  {#key opens}
    <InstanceSettingsDialog bind:open={editOpen} {host} instance={editing} help={model.settingsHelp} />
  {/key}
{/if}

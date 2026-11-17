import { untrack } from "svelte";
import { createMutation, createQuery, useMutationState, type QueryClient } from "@tanstack/svelte-query";
import { ApiError } from "../../shared/http";
import { DEFAULT_SETTINGS, type Instance, type InstanceSettings, type SettingsPatch } from "./api";
import { pauseInstanceMutation, resumeInstanceMutation, stopInstanceMutation, updateSettingsMutation, type SettingsArgs, type StartArgs } from "./mutations";
import { mergePending } from "./pending";
import { instancesQuery, settingsHelpQuery } from "./queries";

// The state and rules of the instance list for one host. InstanceList only draws this.
// It must run inside a component or an $effect.root, because it makes queries and effects. The host is read once:
// App remounts the list (#key) when the host changes.
export function createInstancesModel(opts: { host: string; client: QueryClient; startError?: () => string }) {
  const { host, client } = opts;
  const listQ = createQuery(() => instancesQuery(host), () => client);
  const stopM = createMutation(() => stopInstanceMutation(host, client), () => client);
  const stopping = useMutationState(
    { filters: { mutationKey: ["instances", host, "stop"], status: "pending" }, select: (m) => m.state.variables as string },
    client,
  );
  const pauseM = createMutation(() => pauseInstanceMutation(host, client), () => client);
  const resumeM = createMutation(() => resumeInstanceMutation(host, client), () => client);
  const pausing = useMutationState(
    { filters: { mutationKey: ["instances", host, "pause"], status: "pending" }, select: (m) => m.state.variables as string },
    client,
  );
  const resuming = useMutationState(
    { filters: { mutationKey: ["instances", host, "resume"], status: "pending" }, select: (m) => m.state.variables as string },
    client,
  );
  const applying = useMutationState(
    { filters: { mutationKey: ["instances", host, "settings"], status: "pending" }, select: (m) => (m.state.variables as SettingsArgs).id },
    client,
  );
  // Null for an old node (no settings route) and for a failed read: the list then shows no settings controls and no message.
  const helpQ = createQuery(() => settingsHelpQuery(host), () => client);
  // The message of the last pause or resume that failed. The next pause or resume clears it.
  let actionError = $state("");
  const starting = useMutationState(
    { filters: { mutationKey: ["instances", host, "start"], status: "pending" }, select: (m) => m.state.variables as StartArgs },
    client,
  );
  // Every failed stop keeps its own message: the mutation cache holds them all, whatever observer started the stop.
  const stopFailures = useMutationState(
    {
      filters: { mutationKey: ["instances", host, "stop"], status: "error" },
      select: (m) => ({ key: m.mutationId, message: m.state.error instanceof ApiError ? m.state.error.message : "Failed to stop" }),
    },
    client,
  );

  const rows = $derived(mergePending(listQ.data ?? [], starting, [...stopping.map((id) => ({ id, kind: "stopping" as const })), ...pausing.map((id) => ({ id, kind: "pausing" as const })), ...resuming.map((id) => ({ id, kind: "resuming" as const })), ...applying.map((id) => ({ id, kind: "applying" as const }))]));
  // Reading dataUpdatedAt makes the uptimes recompute (with a fresh Date.now()) on each list refresh.
  const now = $derived.by(() => (listQ.dataUpdatedAt, Date.now()));

  // A message stays until the next successful list refresh after it, or the next stop. The value is the list time at the
  // error (-1: hidden). Failures that are already in the cache at mount are old, so they start hidden.
  const shownAt = new Map<number, number>(untrack(() => stopFailures.map((f) => [f.key, -1] as [number, number])));
  let hideTick = $state(0);
  $effect(() => {
    for (const f of stopFailures) if (!shownAt.has(f.key)) shownAt.set(f.key, untrack(() => listQ.dataUpdatedAt));
  });
  const stopErrors = $derived.by(() => {
    void hideTick;
    return stopFailures.filter((f) => listQ.dataUpdatedAt <= (shownAt.get(f.key) ?? Infinity)).map((f) => f.message);
  });
  const errors = $derived(
    [
      listQ.isError ? (listQ.error instanceof ApiError ? listQ.error.message : "Failed to load instances") : "",
      ...stopErrors,
      actionError,
      opts.startError?.() ?? "",
    ].filter(Boolean),
  );

  return {
    get rows() { return rows; },
    get now() { return now; },
    get errors() { return errors; },
    /** True once the list loaded, so an empty list can say "no instances" and not "loading". */
    get loaded() { return listQ.isSuccess; },
    /** The settings help of the node, or null: then the list shows no settings controls. */
    get settingsHelp() { return helpQ.data ?? null; },
    /** Stops the service and keeps the instance in the list. */
    pause(id: string) {
      actionError = "";
      pauseM.mutate(id, { onError: (e) => (actionError = e instanceof ApiError ? e.message : "Failed to pause") });
    },
    resume(id: string) {
      actionError = "";
      resumeM.mutate(id, { onError: (e) => (actionError = e instanceof ApiError ? e.message : "Failed to resume") });
    },
    /** The caller asks the user first. This hides the old stop messages and starts the stop. */
    stop(id: string) {
      for (const f of stopFailures) shownAt.set(f.key, -1);
      hideTick++;
      stopM.mutate(id);
    },
  };
}

const sameSettings = (a: InstanceSettings, b: InstanceSettings) => a.createSession === b.createSession && a.spawnMode === b.spawnMode;
const isSettings = (v: unknown): v is InstanceSettings =>
  !!v && typeof (v as InstanceSettings).createSession === "boolean" && ((v as InstanceSettings).spawnMode === "same-dir" || (v as InstanceSettings).spawnMode === "worktree");

/** The message for a settings change that failed. A 409 means the node refused or undid it: the old settings stay. */
export function settingsErrorMessage(e: unknown): string {
  if (e instanceof ApiError && e.status === 409) {
    const first = e.body?.code === "settings_refused" ? "The node refused the change." : "The node undid the change.";
    return `${first} The old settings stay. Reason: ${e.message}`;
  }
  if (e instanceof ApiError) return e.message;
  return "The change did not reach the hub. Check the connection and try again.";
}

// The state and rules of the settings dialog of one instance. InstanceSettingsDialog only draws this.
// It must run inside a component or an $effect.root. Mount it fresh for each open: it reads the instance once.
export function createSettingsDialogModel(opts: { host: string; client: QueryClient; instance: Instance; onclose: () => void }) {
  const { host, client } = opts;
  const id = opts.instance.id;
  // The settings that the node has now. A 409 answer sends them again.
  let current = $state<InstanceSettings>({ ...(opts.instance.settings ?? DEFAULT_SETTINGS) });
  let value = $state<InstanceSettings>({ ...current });
  let error = $state("");
  const m = createMutation(() => updateSettingsMutation(host, client), () => client);
  // A change of this instance that runs anywhere (also one that a closed dialog started) makes the dialog busy.
  const running = useMutationState(
    { filters: { mutationKey: ["instances", host, "settings"], status: "pending" }, select: (x) => (x.state.variables as SettingsArgs).id },
    client,
  );
  const busy = $derived(m.isPending || running.includes(id));
  const changed = $derived(!sameSettings(value, current));

  return {
    get value() { return value; },
    get changed() { return changed; },
    get busy() { return busy; },
    get error() { return error; },
    set(v: InstanceSettings) { value = v; },
    /** Sends the changed values. Nothing happens while a change runs or when nothing changed. */
    apply() {
      if (busy || !changed) return;
      const patch: SettingsPatch = {};
      if (value.createSession !== current.createSession) patch.createSession = value.createSession;
      if (value.spawnMode !== current.spawnMode) patch.spawnMode = value.spawnMode;
      error = "";
      m.mutate(
        { id, patch },
        {
          onSuccess: () => opts.onclose(),
          onError: (e) => {
            error = settingsErrorMessage(e);
            if (e instanceof ApiError && isSettings(e.body?.settings)) current = { ...e.body.settings };
          },
        },
      );
    },
  };
}

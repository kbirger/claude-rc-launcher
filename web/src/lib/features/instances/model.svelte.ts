import { untrack } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import { createMutation, createQuery, useMutationState, type QueryClient } from "@tanstack/svelte-query";
import { ApiError } from "../../shared/http";
import { DEFAULT_SETTINGS, type Instance, type InstanceSettings, type SettingsPatch } from "./api";
import {
  pauseInstanceMutation,
  restartInstanceMutation,
  resumeInstanceMutation,
  stopInstanceMutation,
  updateSettingsMutation,
  type SettingsArgs,
  type StartArgs,
} from "./mutations";
import { mergePending } from "./pending";
import { instancesQuery, settingsHelpQuery } from "./queries";

// The state and rules of the instance list for one host. InstanceList only draws this.
// It must run inside a component or an $effect.root, because it makes queries and effects. The host is read once:
// App remounts the list (#key) when the host changes.
export function createInstancesModel(opts: { host: string; client: QueryClient; startError?: () => string }) {
  const { host, client } = opts;
  const listQ = createQuery(
    () => instancesQuery(host),
    () => client,
  );
  const stopM = createMutation(
    () => stopInstanceMutation(host, client),
    () => client,
  );
  const stopping = useMutationState(
    {
      filters: { mutationKey: ["instances", host, "stop"], status: "pending" },
      select: (mutation) => mutation.state.variables as string,
    },
    client,
  );
  const pauseM = createMutation(
    () => pauseInstanceMutation(host, client),
    () => client,
  );
  const resumeM = createMutation(
    () => resumeInstanceMutation(host, client),
    () => client,
  );
  const restartM = createMutation(
    () => restartInstanceMutation(host, client),
    () => client,
  );
  const pausing = useMutationState(
    {
      filters: { mutationKey: ["instances", host, "pause"], status: "pending" },
      select: (mutation) => mutation.state.variables as string,
    },
    client,
  );
  const resuming = useMutationState(
    {
      filters: { mutationKey: ["instances", host, "resume"], status: "pending" },
      select: (mutation) => mutation.state.variables as string,
    },
    client,
  );
  const restarting = useMutationState(
    {
      filters: { mutationKey: ["instances", host, "restart"], status: "pending" },
      select: (mutation) => mutation.state.variables as string,
    },
    client,
  );
  const applying = useMutationState(
    {
      filters: { mutationKey: ["instances", host, "settings"], status: "pending" },
      select: (mutation) => (mutation.state.variables as SettingsArgs).id,
    },
    client,
  );
  // Null for an old node (no settings route) and for a failed read: the list then shows no settings controls and no message.
  const helpQ = createQuery(
    () => settingsHelpQuery(host),
    () => client,
  );
  // The message of the last pause, resume or restart that failed. The next one clears it.
  let actionError = $state("");
  const starting = useMutationState(
    {
      filters: { mutationKey: ["instances", host, "start"], status: "pending" },
      select: (mutation) => mutation.state.variables as StartArgs,
    },
    client,
  );
  // Every failed stop keeps its own message: the mutation cache holds them all, whatever observer started the stop.
  const stopFailures = useMutationState(
    {
      filters: { mutationKey: ["instances", host, "stop"], status: "error" },
      select: (mutation) => ({
        key: mutation.mutationId,
        message: mutation.state.error instanceof ApiError ? mutation.state.error.message : "Failed to stop",
      }),
    },
    client,
  );

  const rows = $derived(
    mergePending(listQ.data ?? [], starting, [
      ...stopping.map((id) => ({ id, kind: "stopping" as const })),
      ...pausing.map((id) => ({ id, kind: "pausing" as const })),
      ...resuming.map((id) => ({ id, kind: "resuming" as const })),
      ...restarting.map((id) => ({ id, kind: "restarting" as const })),
      ...applying.map((id) => ({ id, kind: "applying" as const })),
    ]),
  );
  // Reading dataUpdatedAt makes the uptimes recompute (with a fresh Date.now()) on each list refresh.
  const now = $derived.by(() => (listQ.dataUpdatedAt, Date.now()));

  // A message stays until the next successful list refresh after it, or the next stop. The value is the list time at the
  // error (-1: hidden). Failures that are already in the cache at mount are old, so they start hidden.
  const shownAt = new SvelteMap<number, number>(
    untrack(() => stopFailures.map((stopFailure) => [stopFailure.key, -1] as [number, number])),
  );
  let hideTick = $state(0);
  $effect(() => {
    for (const stopFailure of stopFailures)
      if (!shownAt.has(stopFailure.key))
        shownAt.set(
          stopFailure.key,
          untrack(() => listQ.dataUpdatedAt),
        );
  });
  const stopErrors = $derived.by(() => {
    void hideTick;
    return stopFailures
      .filter((stopFailure) => listQ.dataUpdatedAt <= (shownAt.get(stopFailure.key) ?? Infinity))
      .map((stopFailure) => stopFailure.message);
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
    get rows() {
      return rows;
    },
    get now() {
      return now;
    },
    get errors() {
      return errors;
    },
    /** True once the list loaded, so an empty list can say "no instances" and not "loading". */
    get loaded() {
      return listQ.isSuccess;
    },
    /** The settings help of the node, or null: then the list shows no settings controls. */
    get settingsHelp() {
      return helpQ.data ?? null;
    },
    /** Stops the service and keeps the instance in the list. */
    pause(id: string) {
      actionError = "";
      pauseM.mutate(id, {
        onError: (error) => (actionError = error instanceof ApiError ? error.message : "Failed to pause"),
      });
    },
    resume(id: string) {
      actionError = "";
      resumeM.mutate(id, {
        onError: (error) => (actionError = error instanceof ApiError ? error.message : "Failed to resume"),
      });
    },
    /** Restarts the server of a running instance. The caller asks the user first. A second call while one runs does nothing. */
    restart(id: string) {
      if (restarting.includes(id)) return;
      actionError = "";
      restartM.mutate(id, {
        onError: (error) => (actionError = error instanceof ApiError ? error.message : "Failed to restart"),
      });
    },
    /** The caller asks the user first. This hides the old stop messages and starts the stop. */
    stop(id: string) {
      for (const stopFailure of stopFailures) shownAt.set(stopFailure.key, -1);
      hideTick++;
      stopM.mutate(id);
    },
  };
}

const sameSettings = (instanceSettings: InstanceSettings, right: InstanceSettings) =>
  instanceSettings.createSession === right.createSession && instanceSettings.spawnMode === right.spawnMode;
const isSettings = (value: unknown): value is InstanceSettings =>
  !!value &&
  typeof (value as InstanceSettings).createSession === "boolean" &&
  ((value as InstanceSettings).spawnMode === "same-dir" || (value as InstanceSettings).spawnMode === "worktree");

/** The message for a settings change that failed. A 409 with a settings code means the node refused or undid it. Another 409 means another change runs. */
export function settingsErrorMessage(response: unknown): string {
  if (response instanceof ApiError && response.status === 409) {
    if (response.body?.code === "settings_refused")
      return `The node refused the change. The old settings stay. Reason: ${response.message}`;
    if (response.body?.code === "settings_failed")
      return `The node undid the change. The old settings stay. Reason: ${response.message}`;
    // Another change runs on this instance (a CLI, another tab, a pause or a resume). Nothing was applied or undone.
    return `Another change is running for this folder. Try again in a minute. Reason: ${response.message}`;
  }

  // The answer is lost (no connection, or the hub could not reach the node). The node may still run the change.
  if (!(response instanceof ApiError) || response.status === 502) return LOST_ANSWER;
  return response.message;
}

const LOST_ANSWER =
  "The answer did not come back. The change may still be running. Look at the instance list before you try again.";
/** The notice after a change on a paused instance: the node only saved it. */
export const SAVED_NOT_APPLIED =
  "Saved. The new settings start when you resume this folder. The node does not check them before then.";

// The state and rules of the settings dialog of one instance. InstanceSettingsDialog only draws this.
// It must run inside a component or an $effect.root. Mount it fresh for each open: it reads the instance once.
export function createSettingsDialogModel(opts: {
  host: string;
  client: QueryClient;
  instance: Instance;
  onclose: () => void;
}) {
  const { host, client } = opts;
  const id = opts.instance.id;
  // The settings that the node has now. A 409 answer sends them again.
  let current = $state<InstanceSettings>({ ...(opts.instance.settings ?? DEFAULT_SETTINGS) });
  let value = $state<InstanceSettings>({ ...current });
  let error = $state("");
  // Set when the node only saved the change (a paused instance). The dialog then stays open to show it.
  let notice = $state("");
  const mutation = createMutation(
    () => updateSettingsMutation(host, client),
    () => client,
  );
  // A change of this instance that runs anywhere (also one that a closed dialog started) makes the dialog busy.
  const running = useMutationState(
    {
      filters: { mutationKey: ["instances", host, "settings"], status: "pending" },
      select: (item) => (item.state.variables as SettingsArgs).id,
    },
    client,
  );
  const busy = $derived(mutation.isPending || running.includes(id));
  const changed = $derived(!sameSettings(value, current));

  return {
    get value() {
      return value;
    },
    get changed() {
      return changed;
    },
    get busy() {
      return busy;
    },
    get error() {
      return error;
    },
    get notice() {
      return notice;
    },
    set(instanceSettings: InstanceSettings) {
      value = instanceSettings;
    },
    /** Sends the changed values. Nothing happens while a change runs or when nothing changed. */
    apply() {
      if (busy || !changed) return;
      const patch: SettingsPatch = {};
      if (value.createSession !== current.createSession) patch.createSession = value.createSession;
      if (value.spawnMode !== current.spawnMode) patch.spawnMode = value.spawnMode;
      error = "";
      notice = "";
      const sent = { ...value };
      mutation.mutate(
        { id, patch },
        {
          // An older node sends no `applied`: that reads as applied.
          onSuccess: (data) => {
            if (data?.applied !== false) return opts.onclose();
            current = isSettings(data.instance?.settings) ? { ...data.instance.settings } : sent;
            notice = SAVED_NOT_APPLIED;
          },
          onError: (failure) => {
            error = settingsErrorMessage(failure);
            if (failure instanceof ApiError && isSettings(failure.body?.settings))
              current = { ...failure.body.settings };
          },
        },
      );
    },
  };
}

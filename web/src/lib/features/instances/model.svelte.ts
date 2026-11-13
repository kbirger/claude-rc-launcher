import { untrack } from "svelte";
import { createMutation, createQuery, useMutationState, type QueryClient } from "@tanstack/svelte-query";
import { ApiError } from "../../shared/http";
import { pauseInstanceMutation, resumeInstanceMutation, stopInstanceMutation, type StartArgs } from "./mutations";
import { mergePending } from "./pending";
import { instancesQuery } from "./queries";

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

  const rows = $derived(mergePending(listQ.data ?? [], starting, [...stopping.map((id) => ({ id, kind: "stopping" as const })), ...pausing.map((id) => ({ id, kind: "pausing" as const })), ...resuming.map((id) => ({ id, kind: "resuming" as const }))]));
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

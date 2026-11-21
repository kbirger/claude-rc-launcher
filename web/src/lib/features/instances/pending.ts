import type { Instance } from "./api";
import type { StartArgs } from "./mutations";

export type PendingKind = "starting" | "stopping" | "pausing" | "resuming" | "restarting" | "applying";
export type ListRow = { key: string; name: string; instance?: Instance; pending?: PendingKind };

export function startRowName(options: { path: string; name?: string }): string {
  if (options.name) return options.name;
  const parts = options.path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? options.path;
}

export function mergePending(
  instances: Instance[],
  pendingStarts: StartArgs[],
  pendingActions: { id: string; kind: PendingKind }[],
): ListRow[] {
  const actions = new Map(pendingActions.map((pendingAction) => [pendingAction.id, pendingAction.kind]));
  const known = new Set(instances.map((instance) => instance.path));
  const starts: ListRow[] = pendingStarts
    .filter((pendingStart) => !known.has(pendingStart.path))
    .map((pendingStart, index) => ({
      key: `start:${pendingStart.path}:${index}`,
      name: startRowName(pendingStart),
      pending: "starting",
    }));
  const rows: ListRow[] = instances.map((instance) => ({
    key: instance.id,
    name: instance.name,
    instance: instance,
    ...(actions.has(instance.id) ? { pending: actions.get(instance.id) } : {}),
  }));
  return [...starts, ...rows];
}

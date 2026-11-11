import type { Instance } from "./api";
import type { StartArgs } from "./mutations";

export type PendingKind = "starting" | "stopping";
export type ListRow = { key: string; name: string; instance?: Instance; pending?: PendingKind };

export function startRowName(a: { path: string; name?: string }): string {
  if (a.name) return a.name;
  const parts = a.path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? a.path;
}

export function mergePending(instances: Instance[], pendingStarts: StartArgs[], pendingActions: { id: string; kind: PendingKind }[]): ListRow[] {
  const actions = new Map(pendingActions.map((a) => [a.id, a.kind]));
  const known = new Set(instances.map((i) => i.path));
  const starts: ListRow[] = pendingStarts
    .filter((s) => !known.has(s.path))
    .map((s, n) => ({ key: `start:${s.path}:${n}`, name: startRowName(s), pending: "starting" }));
  const rows: ListRow[] = instances.map((i) => ({
    key: i.id,
    name: i.name,
    instance: i,
    ...(actions.has(i.id) ? { pending: actions.get(i.id) } : {}),
  }));
  return [...starts, ...rows];
}

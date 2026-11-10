import type { HostInfo, UpdateEntry } from "./api";
import { stepText } from "./updateoutput";

export type BannerItem =
  | { kind: "hub-update"; target: string }
  | { kind: "node-update"; hosts: { id: string; name: string; target: string }[] }
  | { kind: "hub-local-build" }
  | { kind: "by-hand"; host: string; message: string }
  | { kind: "offline-after-hub-update"; hosts: string[] }
  | { kind: "failed"; host: string; error: string; id?: string }
  | { kind: "updating"; host: string; name: string; step?: string }
  | { kind: "reinstall-service"; hosts: string[] }
  | { kind: "latest-unknown" };

const OFFLINE_WINDOW_MS = 10 * 60_000;
export const BY_HAND_NODE = "run claude-rc node update on it once";
const BY_HAND_HUB = "the hub did not reach the latest version, update it by hand";
const ROLLED_BACK = "the new version did not start, the old version was restored";

const RUNNING_MAX_MS = 10 * 60_000;
export const lastEntry = (updates: UpdateEntry[], id: string) => [...updates].reverse().find((u) => u.host === id);
// A running entry older than 10 minutes counts as dead (the server lets a new update replace it).
export const isRunning = (e: UpdateEntry | undefined, now: Date) => e?.status === "running" && now.getTime() - Date.parse(e.startedAt) <= RUNNING_MAX_MS;

const unknownVersion = (v?: string) => v === "dev" || (v !== undefined && v.includes("+"));

export function bannerModel(o: { hosts: HostInfo[]; updates: UpdateEntry[]; latestError: boolean; now: Date }): BannerItem[] {
  const now = o.now;
  const items: BannerItem[] = [];
  const hub = o.hosts.find((h) => h.id === "local");
  const last = (id: string) => lastEntry(o.updates, id);
  const nameOf = (id: string) => o.hosts.find((h) => h.id === id)?.name ?? id;
  const hubEntry = last("local");

  for (const id of new Set(o.updates.map((u) => u.host))) {
    const e = last(id);
    if (e && isRunning(e, o.now)) {
      const step = stepText(e);
      items.push({ kind: "updating", host: id, name: nameOf(id), ...(step ? { step } : {}) });
    }
  }

  if (hub?.stale && hub.target && !isRunning(hubEntry, o.now)) items.push({ kind: "hub-update", target: hub.target });

  if (!isRunning(hubEntry, o.now)) {
    const nodes = o.hosts
      .filter((h) => h.id !== "local" && h.status === "ok" && h.stale && h.target && !isRunning(last(h.id), o.now))
      .map((h) => ({ id: h.id, name: h.name, target: h.target as string }));
    if (nodes.length) items.push({ kind: "node-update", hosts: nodes });
  }

  if (hub && unknownVersion(hub.version)) items.push({ kind: "hub-local-build" });

  // A client download that fails with 404 is not the service asset problem that BY_HAND_NODE explains.
  const CLIENT_FAILED = /^the client update failed/i;
  const byHand = new Set<string>();
  for (const id of new Set(o.updates.map((u) => u.host))) {
    const e = last(id);
    if (!e) continue;
    if (id === "local") {
      // Only right after the update. Later, a stale hub means that a newer release came out since.
      const age = now.getTime() - Date.parse(e.finishedAt ?? e.startedAt);
      if (e.status === "updated" && hub?.stale && age <= OFFLINE_WINDOW_MS) {
        byHand.add(id);
        items.push({ kind: "by-hand", host: nameOf(id), message: BY_HAND_HUB });
      }
    } else if (e.status === "failed" && e.error && !CLIENT_FAILED.test(e.error) && /404|not found/i.test(e.error)) {
      byHand.add(id);
      items.push({ kind: "by-hand", host: nameOf(id), message: BY_HAND_NODE });
    }
  }

  if (hubEntry?.status === "updated" && hubEntry.finishedAt) {
    const age = o.now.getTime() - Date.parse(hubEntry.finishedAt);
    const offline = o.hosts.filter((h) => h.status === "offline").map((h) => h.name);
    if (age <= OFFLINE_WINDOW_MS && offline.length) items.push({ kind: "offline-after-hub-update", hosts: offline });
  }

  for (const id of new Set(o.updates.map((u) => u.host))) {
    const e = last(id);
    if (!e || byHand.has(id)) continue;
    if (e.status === "failed" || e.status === "unknown") {
      if (e.error) items.push({ kind: "failed", host: nameOf(id), error: e.error, id });
    } else if (e.status === "rolled back") {
      items.push({ kind: "failed", host: nameOf(id), error: e.error || ROLLED_BACK, id });
    }
  }

  // The binary update never rewrites the service definition. A node that reports an older one needs install.ps1 again.
  const reinstall = o.hosts.filter((h) => h.id !== "local" && h.status === "ok" && h.definition && h.definition.installed < h.definition.required).map((h) => h.name);
  if (reinstall.length) items.push({ kind: "reinstall-service", hosts: reinstall });

  if (o.latestError) items.push({ kind: "latest-unknown" });
  return items;
}

export function bannerKey(item: BannerItem): string {
  switch (item.kind) {
    case "hub-update": return `hub-update:${item.target}`;
    case "node-update": return `node-update:${item.hosts.map((h) => `${h.id}@${h.target}`).sort().join(",")}`;
    case "updating": return `updating:${item.host}`;
    case "by-hand": return `by-hand:${item.host}`;
    case "offline-after-hub-update": return `offline:${[...item.hosts].sort().join(",")}`;
    case "reinstall-service": return `reinstall:${[...item.hosts].sort().join(",")}`;
    case "failed": return `failed:${item.id ?? ""}:${item.host}:${item.error}`;
    default: return item.kind;
  }
}

// Errors of update calls made from this page, by host name. A call error is dropped when the model already reports
// the host (failed, by-hand, updating); the rest are shown as failed items. The final list has unique keys.
export function mergeCallErrors(items: BannerItem[], callErrors: Record<string, CallError>): BannerItem[] {
  const reported = new Set<string>();
  for (const i of items) {
    if (i.kind === "failed" || i.kind === "by-hand") reported.add(i.host);
    if (i.kind === "updating") reported.add(i.name);
  }
  const out = [...items];
  for (const [host, c] of Object.entries(callErrors)) if (!reported.has(host)) out.push({ kind: "failed", host, error: c.error });
  const seen = new Set<string>();
  return out.filter((i) => {
    const k = bannerKey(i);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export type CallError = { error: string; at: number };

// Drops call errors that are out of date: the host finished an update after the call, is no longer stale, or runs a new update.
export function pruneCallErrors(callErrors: Record<string, CallError>, hosts: HostInfo[], updates: UpdateEntry[], now: Date): Record<string, CallError> {
  const out: Record<string, CallError> = {};
  for (const [name, c] of Object.entries(callErrors)) {
    const h = hosts.find((x) => x.name === name);
    const e = h ? lastEntry(updates, h.id) : undefined;
    if (!h || !h.stale || isRunning(e, now)) continue;
    if (e && (e.status === "updated" || e.status === "up-to-date") && Date.parse(e.finishedAt ?? e.startedAt) > c.at) continue;
    out[name] = c;
  }
  return out;
}

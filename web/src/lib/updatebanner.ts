import type { HostInfo, UpdateEntry } from "./api";

export type BannerItem =
  | { kind: "hub-update"; target: string }
  | { kind: "node-update"; hosts: { id: string; name: string; target: string }[] }
  | { kind: "hub-local-build" }
  | { kind: "by-hand"; host: string; message: string }
  | { kind: "offline-after-hub-update"; hosts: string[] }
  | { kind: "failed"; host: string; error: string }
  | { kind: "updating"; host: string; name: string }
  | { kind: "latest-unknown" };

const OFFLINE_WINDOW_MS = 10 * 60_000;
export const BY_HAND_NODE = "run claude-rc node update on it once";
const BY_HAND_HUB = "the hub did not reach the latest version, update it by hand";
const ROLLED_BACK = "the new version did not start, the old version was restored";

export const isRunning = (updates: UpdateEntry[], id: string) => [...updates].reverse().find((u) => u.host === id)?.status === "running";

const unknownVersion = (v?: string) => v === "dev" || (v !== undefined && v.includes("+"));

export function bannerModel(o: { hosts: HostInfo[]; updates: UpdateEntry[]; latestError: boolean; now: Date }): BannerItem[] {
  const items: BannerItem[] = [];
  const hub = o.hosts.find((h) => h.id === "local");
  const last = (id: string) => [...o.updates].reverse().find((u) => u.host === id);
  const nameOf = (id: string) => o.hosts.find((h) => h.id === id)?.name ?? id;
  const hubEntry = last("local");

  for (const id of new Set(o.updates.map((u) => u.host))) {
    if (isRunning(o.updates, id)) items.push({ kind: "updating", host: id, name: nameOf(id) });
  }

  if (hub?.stale && hub.target && hubEntry?.status !== "running") items.push({ kind: "hub-update", target: hub.target });

  if (hubEntry?.status !== "running") {
    const nodes = o.hosts
      .filter((h) => h.id !== "local" && h.status === "ok" && h.stale && h.target && !isRunning(o.updates, h.id))
      .map((h) => ({ id: h.id, name: h.name, target: h.target as string }));
    if (nodes.length) items.push({ kind: "node-update", hosts: nodes });
  }

  if (hub && unknownVersion(hub.version)) items.push({ kind: "hub-local-build" });

  const byHand = new Set<string>();
  for (const id of new Set(o.updates.map((u) => u.host))) {
    const e = last(id);
    if (!e) continue;
    if (id === "local") {
      if (e.status === "updated" && hub?.stale) {
        byHand.add(id);
        items.push({ kind: "by-hand", host: nameOf(id), message: BY_HAND_HUB });
      }
    } else if (e.status === "failed" && e.error && /404|not found/i.test(e.error)) {
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
      if (e.error) items.push({ kind: "failed", host: nameOf(id), error: e.error });
    } else if (e.status === "rolled back") {
      items.push({ kind: "failed", host: nameOf(id), error: e.error || ROLLED_BACK });
    }
  }

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
    case "failed": return `failed:${item.host}:${item.error}`;
    default: return item.kind;
  }
}

// Errors of update calls made from this page, by host name. A call error is dropped when the model already reports
// the host (failed, by-hand, updating); the rest are shown as failed items. The final list has unique keys.
export function mergeCallErrors(items: BannerItem[], callErrors: Record<string, string>): BannerItem[] {
  const reported = new Set<string>();
  for (const i of items) {
    if (i.kind === "failed" || i.kind === "by-hand") reported.add(i.host);
    if (i.kind === "updating") reported.add(i.name);
  }
  const out = [...items];
  for (const [host, error] of Object.entries(callErrors)) if (!reported.has(host)) out.push({ kind: "failed", host, error });
  const seen = new Set<string>();
  return out.filter((i) => {
    const k = bannerKey(i);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Drops call errors that are out of date: the host updated, is no longer stale, or runs a new update.
export function pruneCallErrors(callErrors: Record<string, string>, hosts: HostInfo[], updates: UpdateEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, error] of Object.entries(callErrors)) {
    const h = hosts.find((x) => x.name === name);
    const e = h ? [...updates].reverse().find((u) => u.host === h.id) : undefined;
    if (!h || !h.stale || e?.status === "updated" || e?.status === "up-to-date" || e?.status === "running") continue;
    out[name] = error;
  }
  return out;
}

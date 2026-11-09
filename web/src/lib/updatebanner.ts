import type { HostInfo, UpdateEntry } from "./api";

export type BannerItem =
  | { kind: "hub-update"; target: string }
  | { kind: "node-update"; hosts: { id: string; name: string; target: string }[] }
  | { kind: "hub-local-build" }
  | { kind: "by-hand"; host: string; message: string }
  | { kind: "offline-after-hub-update"; hosts: string[] }
  | { kind: "failed"; host: string; error: string }
  | { kind: "latest-unknown" };

const OFFLINE_WINDOW_MS = 10 * 60_000;
export const BY_HAND_NODE = "run claude-rc node update on it once";
const BY_HAND_HUB = "the hub did not reach the latest version, update it by hand";
const ROLLED_BACK = "the new version did not start, the old version was restored";

const unknownVersion = (v?: string) => v === "dev" || (v !== undefined && v.includes("+"));

export function bannerModel(o: { hosts: HostInfo[]; updates: UpdateEntry[]; latestError: boolean; now: Date }): BannerItem[] {
  const items: BannerItem[] = [];
  const hub = o.hosts.find((h) => h.id === "local");
  const last = (id: string) => [...o.updates].reverse().find((u) => u.host === id);
  const nameOf = (id: string) => o.hosts.find((h) => h.id === id)?.name ?? id;
  const hubEntry = last("local");

  if (hub?.stale && hub.target) items.push({ kind: "hub-update", target: hub.target });

  if (hubEntry?.status !== "running") {
    const nodes = o.hosts
      .filter((h) => h.id !== "local" && h.status === "ok" && h.stale && h.target)
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
    case "by-hand": return `by-hand:${item.host}`;
    case "offline-after-hub-update": return `offline:${[...item.hosts].sort().join(",")}`;
    case "failed": return `failed:${item.host}:${item.error}`;
    default: return item.kind;
  }
}

import type { HostInfo } from "../hosts";
import type { UpdateEntry } from "./api";
import { isBehind, releaseOf } from "../../shared/version";
import { stepText } from "./updateoutput";

export type BannerItem =
  | { kind: "hub-update"; target: string }
  | { kind: "node-update"; hosts: { id: string; name: string; target: string }[] }
  | { kind: "nodes-after-hub"; hosts: string[] }
  | { kind: "hub-local-build" }
  | { kind: "by-hand"; host: string; message: string }
  | { kind: "offline-after-hub-update"; hosts: string[] }
  | { kind: "failed"; host: string; error: string; id?: string }
  | { kind: "updating"; host: string; name: string; step?: string }
  | { kind: "reinstall-service"; hosts: string[] }
  | { kind: "latest-unknown" };

const OFFLINE_WINDOW_MS = 10 * 60_000;
export const BY_HAND_NODE = "run claude-rc node update on it once";
const BY_HAND_HUB =
  "the update finished, but the hub is still behind the latest release. Run claude-rc node update on the hub machine, then read the hub journal for lines that start with [update]";
const ROLLED_BACK = "the new version did not start, the old version was restored";

const RUNNING_MAX_MS = 10 * 60_000;
export const lastEntry = (updates: UpdateEntry[], id: string) =>
  [...updates].reverse().find((updateEntry) => updateEntry.host === id);
// A running entry older than 10 minutes counts as dead (the server lets a new update replace it).
export const isRunning = (updateEntry: UpdateEntry | undefined, now: Date) =>
  updateEntry?.status === "running" && now.getTime() - Date.parse(updateEntry.startedAt) <= RUNNING_MAX_MS;

// A local build (`0.12.4+branch.sha`) is compared by the release it is based on. Only `dev` and the like cannot be compared.
const unknownVersion = (value?: string) => value !== undefined && releaseOf(value) === undefined;

export function bannerModel(options: {
  hosts: HostInfo[];
  updates: UpdateEntry[];
  latestError: boolean;
  now: Date;
}): BannerItem[] {
  const now = options.now;
  const items: BannerItem[] = [];
  const hub = options.hosts.find((host) => host.id === "local");
  const last = (id: string) => lastEntry(options.updates, id);
  const nameOf = (id: string) => options.hosts.find((host) => host.id === id)?.name ?? id;
  const hubEntry = last("local");

  for (const id of new Set(options.updates.map((update) => update.host))) {
    const updateEntry = last(id);

    if (updateEntry && isRunning(updateEntry, options.now)) {
      const step = stepText(updateEntry);
      items.push({ kind: "updating", host: id, name: nameOf(id), ...(step ? { step } : {}) });
    }
  }

  if (hub?.stale && hub.target && !isRunning(hubEntry, options.now))
    items.push({ kind: "hub-update", target: hub.target });

  if (!isRunning(hubEntry, options.now)) {
    const nodes = options.hosts
      .filter(
        (host) =>
          host.id !== "local" &&
          host.status === "ok" &&
          host.stale &&
          host.target &&
          !isRunning(last(host.id), options.now),
      )
      .map((host) => ({ id: host.id, name: host.name, target: host.target as string }));
    if (nodes.length) items.push({ kind: "node-update", hosts: nodes });
    // A node can only be updated to the version of the hub. While the hub is behind the latest release, the nodes that
    // are behind it too (and are not listed above) wait for the hub update. They are named so that none looks forgotten.
    const latest = hub?.target;

    if (hub?.stale && latest) {
      const waiting = options.hosts
        .filter(
          (host) =>
            host.id !== "local" &&
            host.status === "ok" &&
            !nodes.some((node) => node.id === host.id) &&
            !isRunning(last(host.id), options.now) &&
            (isBehind(host.version, latest) || isBehind(host.clientVersion, latest)),
        )
        .map((host) => host.name);
      if (waiting.length) items.push({ kind: "nodes-after-hub", hosts: waiting });
    }
  }

  if (hub && unknownVersion(hub.version)) items.push({ kind: "hub-local-build" });

  // A client download that fails with 404 is not the service asset problem that BY_HAND_NODE explains.
  const CLIENT_FAILED = /^the client update failed/i;
  const byHand = new Set<string>();

  for (const id of new Set(options.updates.map((update) => update.host))) {
    const updateEntry = last(id);
    if (!updateEntry) continue;

    if (id === "local") {
      // Only right after the update. Later, a stale hub means that a newer release came out since.
      const age = now.getTime() - Date.parse(updateEntry.finishedAt ?? updateEntry.startedAt);

      if (updateEntry.status === "updated" && hub?.stale && age <= OFFLINE_WINDOW_MS) {
        byHand.add(id);
        items.push({ kind: "by-hand", host: nameOf(id), message: BY_HAND_HUB });
      }
    } else if (
      updateEntry.status === "failed" &&
      updateEntry.error &&
      !CLIENT_FAILED.test(updateEntry.error) &&
      /404|not found/i.test(updateEntry.error)
    ) {
      byHand.add(id);
      items.push({ kind: "by-hand", host: nameOf(id), message: BY_HAND_NODE });
    }
  }

  if (hubEntry?.status === "updated" && hubEntry.finishedAt) {
    const age = options.now.getTime() - Date.parse(hubEntry.finishedAt);
    const offline = options.hosts.filter((host) => host.status === "offline").map((host) => host.name);
    if (age <= OFFLINE_WINDOW_MS && offline.length) items.push({ kind: "offline-after-hub-update", hosts: offline });
  }

  for (const id of new Set(options.updates.map((update) => update.host))) {
    const updateEntry = last(id);
    if (!updateEntry || byHand.has(id)) continue;

    if (updateEntry.status === "failed" || updateEntry.status === "unknown") {
      if (updateEntry.error) items.push({ kind: "failed", host: nameOf(id), error: updateEntry.error, id });
    } else if (updateEntry.status === "rolled back") {
      items.push({ kind: "failed", host: nameOf(id), error: updateEntry.error || ROLLED_BACK, id });
    }
  }

  // The binary update never rewrites the service definition. A node that reports an older one needs install.ps1 again.
  const reinstall = options.hosts
    .filter(
      (host) =>
        host.id !== "local" &&
        host.status === "ok" &&
        host.definition &&
        host.definition.installed < host.definition.required,
    )
    .map((host) => host.name);
  if (reinstall.length) items.push({ kind: "reinstall-service", hosts: reinstall });

  if (options.latestError) items.push({ kind: "latest-unknown" });
  return items;
}

export function bannerKey(item: BannerItem): string {
  switch (item.kind) {
    case "hub-update":
      return `hub-update:${item.target}`;
    case "node-update":
      return `node-update:${item.hosts
        .map((host) => `${host.id}@${host.target}`)
        .sort()
        .join(",")}`;
    case "nodes-after-hub":
      return `after-hub:${[...item.hosts].sort().join(",")}`;
    case "updating":
      return `updating:${item.host}`;
    case "by-hand":
      return `by-hand:${item.host}`;
    case "offline-after-hub-update":
      return `offline:${[...item.hosts].sort().join(",")}`;
    case "reinstall-service":
      return `reinstall:${[...item.hosts].sort().join(",")}`;
    case "failed":
      return `failed:${item.id ?? ""}:${item.host}:${item.error}`;
    default:
      return item.kind;
  }
}

// Errors of update calls made from this page, by host name. A call error is dropped when the model already reports
// the host (failed, by-hand, updating); the rest are shown as failed items. The final list has unique keys.
export function mergeCallErrors(items: BannerItem[], callErrors: Record<string, CallError>): BannerItem[] {
  const reported = new Set<string>();

  for (const item of items) {
    if (item.kind === "failed" || item.kind === "by-hand") reported.add(item.host);
    if (item.kind === "updating") reported.add(item.name);
  }

  const out = [...items];
  for (const [host, callError] of Object.entries(callErrors))
    if (!reported.has(host)) out.push({ kind: "failed", host, error: callError.error });
  const seen = new Set<string>();
  return out.filter((item) => {
    const key = bannerKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type CallError = { error: string; at: number };

// Drops call errors that are out of date: the host finished an update after the call, is no longer stale, or runs a new update.
export function pruneCallErrors(
  callErrors: Record<string, CallError>,
  hosts: HostInfo[],
  updates: UpdateEntry[],
  now: Date,
): Record<string, CallError> {
  const out: Record<string, CallError> = {};

  for (const [name, callError] of Object.entries(callErrors)) {
    const hostInfo = hosts.find((host) => host.name === name);
    const updateEntry = hostInfo ? lastEntry(updates, hostInfo.id) : undefined;
    if (!hostInfo || !hostInfo.stale || isRunning(updateEntry, now)) continue;
    if (
      updateEntry &&
      (updateEntry.status === "updated" || updateEntry.status === "up-to-date") &&
      Date.parse(updateEntry.finishedAt ?? updateEntry.startedAt) > callError.at
    )
      continue;
    out[name] = callError;
  }

  return out;
}

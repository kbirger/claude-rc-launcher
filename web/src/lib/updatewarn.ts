import type { HostInfo, UpdateEntry } from "./api";
import { isRunning } from "./updatebanner";

/** Why starting a session or a clone on `host` now is risky, or undefined when it is not. */
export function busyReason(host: HostInfo | undefined, entry: UpdateEntry | undefined, now: Date): string | undefined {
  if (isRunning(entry, now)) return "is updating";
  if (host?.status === "restarting") return "is restarting";
  return undefined;
}

export type ReloadDecision = "none" | "reload" | "bar";

const MIN_GAP_MS = 30_000;

/**
 * What the page does when the hub runs another version than the one that served the page. A dialog that is open
 * gets a bar and no reload, so that a typed path is not lost. A reload within 30 seconds of the last one is
 * never repeated: it shows the bar, so that a hub that serves old files cannot make a loop.
 */
export function reloadDecision(o: { loaded: string | undefined; current: string | undefined; dialogOpen: boolean; lastReloadAt: number; now: number }): ReloadDecision {
  if (!o.loaded || !o.current || o.loaded === o.current) return "none";
  if (o.dialogOpen || o.now - o.lastReloadAt < MIN_GAP_MS) return "bar";
  return "reload";
}

/** The names of the hosts in `list` that run on Windows, where an update restarts the sessions. */
export function windowsNames(list: { id: string; name: string }[], hosts: HostInfo[]): string[] {
  return list.filter((n) => hosts.find((h) => h.id === n.id)?.platform === "win32").map((n) => n.name);
}

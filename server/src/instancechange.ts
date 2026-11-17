/**
 * Parts of a settings change that every platform shares. This file must not use systemd or the file system.
 */
import type { InstanceSettings, SettingsPatch } from "./instancesettings";

export type ProbeResult = "up" | "refused" | "down";
export type SettleResult = "ok" | "refused" | "failed";

/** The time to wait after a change before it counts as good. */
export const SETTLE_MS = 20_000;
/** The time between two probes while we wait. */
export const PROBE_INTERVAL_MS = 1_000;
/** The exit code of a server that refuses to start in its folder. */
export const REFUSED_EXIT_CODE = 69;

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Probe an instance until the window ends. The result is `ok` only if every probe says `up`.
 * A `refused` probe stops the wait at once with `refused`. A `down` probe or a probe that throws stops it with `failed`.
 * The time counts the sleeps, so a fake `sleep` makes a test run at once.
 */
export async function waitSettled(
  probe: () => Promise<ProbeResult>,
  o: { timeoutMs: number; intervalMs: number; sleep?: (ms: number) => Promise<void> },
): Promise<SettleResult> {
  const sleep = o.sleep ?? realSleep;
  const step = Math.max(1, o.intervalMs);
  let elapsed = 0;
  for (;;) {
    let r: ProbeResult;
    try {
      r = await probe();
    } catch {
      return "failed";
    }
    if (r === "refused") return "refused";
    if (r !== "up") return "failed";
    if (elapsed >= o.timeoutMs) return "ok";
    const ms = Math.min(step, o.timeoutMs - elapsed);
    await sleep(ms);
    elapsed += ms;
  }
}

/** Lets one change run for each instance at a time. */
export class ChangeLock {
  private held = new Map<string, symbol>();

  /** Takes the lock for `id`. Gives undefined if another change holds it. The release function works only once. */
  tryLock(id: string): (() => void) | undefined {
    if (this.held.has(id)) return undefined;
    const token = Symbol(id);
    this.held.set(id, token);
    return () => {
      if (this.held.get(id) === token) this.held.delete(id);
    };
  }
}

/** True if each field of the patch is missing or has an allowed value. */
export function isValidPatch(p: unknown): p is SettingsPatch {
  if (typeof p !== "object" || p === null || Array.isArray(p)) return false;
  const { createSession, spawnMode } = p as Record<string, unknown>;
  if (createSession !== undefined && typeof createSession !== "boolean") return false;
  if (spawnMode !== undefined && spawnMode !== "same-dir" && spawnMode !== "worktree") return false;
  return true;
}

export function sameSettings(a: InstanceSettings, b: InstanceSettings): boolean {
  return a.createSession === b.createSession && a.spawnMode === b.spawnMode;
}

/** The text for a change that did not settle. */
export function settleReason(r: Exclude<SettleResult, "ok">): string {
  return r === "refused"
    ? `the server refused to start with these settings (exit code ${REFUSED_EXIT_CODE}). The folder may hold a recoverable session, or a terminal claude remote-control may serve it`
    : "the server did not stay active after the change";
}

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

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Probe an instance until the window ends. The result is `ok` only if every probe says `up`.
 * A `refused` probe stops the wait at once with `refused`. A `down` probe or a probe that throws stops it with `failed`.
 * The time counts the sleeps, so a fake `sleep` makes a test run at once.
 */
export async function waitSettled(
  probe: () => Promise<ProbeResult>,
  options: { timeoutMs: number; intervalMs: number; sleep?: (ms: number) => Promise<void> },
): Promise<SettleResult> {
  const sleep = options.sleep ?? realSleep;
  const step = Math.max(1, options.intervalMs);
  let elapsed = 0;

  for (;;) {
    let probeResult: ProbeResult;

    try {
      probeResult = await probe();
    } catch {
      return "failed";
    }

    if (probeResult === "refused") return "refused";
    if (probeResult !== "up") return "failed";
    if (elapsed >= options.timeoutMs) return "ok";
    const ms = Math.min(step, options.timeoutMs - elapsed);
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
export function isValidPatch(value: unknown): value is SettingsPatch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { createSession, spawnMode } = value as Record<string, unknown>;
  if (createSession !== undefined && typeof createSession !== "boolean") return false;
  if (spawnMode !== undefined && spawnMode !== "same-dir" && spawnMode !== "worktree") return false;
  return true;
}

export function sameSettings(instanceSettings: InstanceSettings, right: InstanceSettings): boolean {
  return instanceSettings.createSession === right.createSession && instanceSettings.spawnMode === right.spawnMode;
}

/** The text for a change that did not settle. */
export function settleReason(exclude: Exclude<SettleResult, "ok">): string {
  return exclude === "refused"
    ? `the server refused to start with these settings (exit code ${REFUSED_EXIT_CODE}). The folder may hold a recoverable session, or a terminal claude remote-control may serve it`
    : "the server did not stay active after the change";
}

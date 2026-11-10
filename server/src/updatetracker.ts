import type { UpdateEntry, UpdateRecord } from "./updaterecord";
import { normalizeVersion } from "./versions";
import type { UpdateReport } from "./serviceupdate";
import type { Presence } from "./nodewatcher";

export type UpdateTracker = {
  /** Writes a `running` entry unless a recent one of that host still runs; true when it wrote. */
  begin(host: string, startedBy: string, from: string): Promise<boolean>;
  finish(host: string, report: UpdateReport | { status: "failed"; error: string }): Promise<void>;
};

/** A `running` entry older than this no longer blocks a new update. */
const STALE_MS = 600_000;

export const UNKNOWN_REASON = "the node did not answer with the new version within 90 seconds";

/**
 * Writes the result of each update into the record. A restart of a node is settled in the background by asking
 * the node for its version; a restart of the hub itself is settled by `reconcileHub` in the next process.
 */
export function createUpdateTracker(o: {
  record: UpdateRecord;
  hubVersion: string;
  probe(host: string): Promise<string | undefined>;
  /** A presence event that says the node is online with the target version settles the wait at once; the poll stays as the fallback. */
  presence?: { onChange(fn: (p: Presence) => void): () => void };
  now?: () => Date;
  waitMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): UpdateTracker {
  const now = o.now ?? (() => new Date());
  const waitMs = o.waitMs ?? 90_000;
  const intervalMs = o.intervalMs ?? 2_000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const current = (host: string) => o.record.list().find((e) => e.host === host);
  /** The run that owns the entry of each host; a wait of an older run stops without writing. */
  const tokens = new Map<string, number>();
  let counter = 0;
  const settle = (host: string, patch: Partial<UpdateEntry> & { status: UpdateEntry["status"] }, token?: number) => {
    const base: UpdateEntry = current(host) ?? { host, startedAt: now().toISOString(), startedBy: "unknown", from: o.hubVersion, status: "running" };
    const next = { ...base, ...patch, finishedAt: now().toISOString() };
    if (token === undefined) return o.record.set(next).then(() => {});
    return o.record.setIf(next, (cur) => tokens.get(host) === token && cur?.status === "running").then(() => {});
  };
  const same = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && normalizeVersion(a) === normalizeVersion(b);

  const waitForNode = async (host: string, report: UpdateReport, token: number) => {
    let early!: () => void;
    const early$ = new Promise<void>((r) => (early = r));
    let done = false;
    const off = o.presence?.onChange((p) => {
      if (done || p.host !== host || p.status !== "online" || tokens.get(host) !== token || !same(p.version, report.to)) return;
      done = true;
      early();
      void settle(host, { status: "updated", to: report.to }, token).catch((e) => console.error(`update of ${host} could not be written: ${e instanceof Error ? e.message : String(e)}`));
    });
    try {
      const started = now().getTime();
      let last: string | undefined;
      while (true) {
        await Promise.race([sleep(intervalMs), early$]);
        if (done || tokens.get(host) !== token) return;
        last = await o.probe(host).catch(() => undefined);
        if (done || tokens.get(host) !== token) return;
        if (same(last, report.to)) return settle(host, { status: "updated", to: report.to }, token);
        if (now().getTime() - started >= waitMs) break;
      }
      const old = current(host)?.from;
      if (same(last, old) || same(last, report.from)) return settle(host, { status: "rolled back" }, token);
      return settle(host, { status: "unknown", error: UNKNOWN_REASON }, token);
    } finally {
      done = true;
      off?.();
    }
  };

  return {
    async begin(host, startedBy, from) {
      const t = now();
      const wrote = await o.record.setIf({ host, startedAt: t.toISOString(), startedBy, from, status: "running" }, (cur) => !(cur?.status === "running" && t.getTime() - Date.parse(cur.startedAt) < STALE_MS));
      if (wrote) tokens.set(host, ++counter);
      return wrote;
    },
    async finish(host, report) {
      if (report.status === "failed") return settle(host, { status: "failed", error: report.error ?? "update failed" });
      if (report.status === "up-to-date") return settle(host, { status: "up-to-date", ...(report.to !== undefined ? { to: report.to } : {}) });
      if (report.status === "clients-only") return settle(host, { status: "updated", ...(report.to !== undefined ? { to: report.to } : {}) });
      if (host === "local") return;
      void waitForNode(host, report, tokens.get(host) ?? 0).catch((e) => console.error(`update wait for ${host} failed: ${e instanceof Error ? e.message : String(e)}`));
    },
  };
}

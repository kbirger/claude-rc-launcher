import type { UpdateEntry, UpdateRecord } from "./updaterecord";
import type { UpdateReport } from "./serviceupdate";

export type UpdateTracker = {
  begin(host: string, startedBy: string, from: string): Promise<void>;
  finish(host: string, report: UpdateReport | { status: "failed"; error: string }): Promise<void>;
};

export const UNKNOWN_REASON = "the node did not answer with the new version within 90 seconds";

/**
 * Writes the result of each update into the record. A restart of a node is settled in the background by asking
 * the node for its version; a restart of the hub itself is settled by `reconcileHub` in the next process.
 */
export function createUpdateTracker(o: {
  record: UpdateRecord;
  hubVersion: string;
  probe(host: string): Promise<string | undefined>;
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
  const settle = (host: string, patch: Partial<UpdateEntry> & { status: UpdateEntry["status"] }) => {
    const base: UpdateEntry = current(host) ?? { host, startedAt: now().toISOString(), startedBy: "unknown", from: o.hubVersion, status: "running" };
    return o.record.set({ ...base, ...patch, finishedAt: now().toISOString() });
  };

  const waitForNode = async (host: string, report: UpdateReport) => {
    let last: string | undefined;
    for (let waited = 0; waited < waitMs; waited += intervalMs) {
      await sleep(intervalMs);
      last = await o.probe(host).catch(() => undefined);
      if (last !== undefined && last === report.to) return settle(host, { status: "updated", to: report.to });
    }
    const old = current(host)?.from;
    if (last !== undefined && (last === old || last === report.from)) return settle(host, { status: "rolled back" });
    return settle(host, { status: "unknown", error: UNKNOWN_REASON });
  };

  return {
    begin: (host, startedBy, from) => o.record.set({ host, startedAt: now().toISOString(), startedBy, from, status: "running" }),
    async finish(host, report) {
      if (report.status === "failed") return settle(host, { status: "failed", error: report.error ?? "update failed" });
      if (report.status === "up-to-date") return settle(host, { status: "up-to-date", ...(report.to !== undefined ? { to: report.to } : {}) });
      if (report.status === "clients-only") return settle(host, { status: "updated", ...(report.to !== undefined ? { to: report.to } : {}) });
      if (host === "local") return;
      void waitForNode(host, report).catch((e) => console.error(`update wait for ${host} failed: ${e instanceof Error ? e.message : String(e)}`));
    },
  };
}

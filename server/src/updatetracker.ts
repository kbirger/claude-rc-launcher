import type { Presence } from "./nodewatcher";
import type { UpdateReport } from "./serviceupdate";
import type { UpdateEntry, UpdateRecord } from "./updaterecord";
import { normalizeVersion } from "./versions";

export interface UpdateTracker {
  /** Writes a `running` entry unless a recent one of that host still runs; true when it wrote. */
  begin(host: string, startedBy: string, from: string): Promise<boolean>;
  finish(host: string, report: UpdateReport | { status: "failed"; error: string }): Promise<void>;
}

/** A `running` entry older than this no longer blocks a new update. */
const STALE_MS = 600_000;

export const UNKNOWN_REASON = "the node did not answer with the new version within 90 seconds";

/**
 * Writes the result of each update into the record. A restart of a node is settled in the background by asking
 * the node for its version; a restart of the hub itself is settled by `reconcileHub` in the next process.
 */
export function createUpdateTracker(options: {
  record: UpdateRecord;
  hubVersion: string;
  probe(host: string): Promise<string | undefined>;
  /** A presence event that says the node is online with the target version settles the wait at once; the poll stays as the fallback. */
  presence?: { onChange(fn: (presence: Presence) => void): () => void };
  now?: () => Date;
  waitMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): UpdateTracker {
  const now = options.now ?? (() => new Date());
  const waitMs = options.waitMs ?? 90_000;
  const intervalMs = options.intervalMs ?? 2_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const current = (host: string) => options.record.list().find((updateEntry) => updateEntry.host === host);
  /** The run that owns the entry of each host; a wait of an older run stops without writing. */
  const tokens = new Map<string, number>();
  let counter = 0;

  const settle = (host: string, patch: Partial<UpdateEntry> & { status: UpdateEntry["status"] }, token?: number) => {
    const base: UpdateEntry = current(host) ?? {
      host,
      startedAt: now().toISOString(),
      startedBy: "unknown",
      from: options.hubVersion,
      status: "running",
    };
    const next = { ...base, ...patch, finishedAt: now().toISOString() };
    if (token === undefined) return options.record.set(next).then(() => {});
    return options.record.setIf(next, (cur) => tokens.get(host) === token && cur?.status === "running").then(() => {});
  };

  const same = (left: string | undefined, right: string | undefined) =>
    left !== undefined && right !== undefined && normalizeVersion(left) === normalizeVersion(right);

  const waitForNode = async (host: string, report: UpdateReport, token: number) => {
    let early!: () => void;
    const early$ = new Promise<void>((resolve) => (early = resolve));
    let done = false;
    // A function, so that TypeScript does not narrow `done` to false: the presence callback sets it during an await.
    const finished = () => done;
    const off = options.presence?.onChange((presence) => {
      if (
        done ||
        presence.host !== host ||
        presence.status !== "online" ||
        tokens.get(host) !== token ||
        !same(presence.version, report.to)
      )
        return;
      done = true;
      early();
      void settle(host, { status: "updated", to: report.to }, token).catch((error: unknown) => {
        console.error(
          `update of ${host} could not be written: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });

    try {
      const started = now().getTime();
      let last: string | undefined;

      for (;;) {
        await Promise.race([sleep(intervalMs), early$]);
        if (finished() || tokens.get(host) !== token) return;
        last = await options.probe(host).catch(() => undefined);
        if (finished() || tokens.get(host) !== token) return;

        if (same(last, report.to)) {
          await settle(host, { status: "updated", to: report.to }, token);
          return;
        }

        if (now().getTime() - started >= waitMs) break;
      }

      const old = current(host)?.from;

      if (same(last, old) || same(last, report.from)) {
        await settle(host, { status: "rolled back" }, token);
        return;
      }

      await settle(host, { status: "unknown", error: UNKNOWN_REASON }, token);
      return;
    } finally {
      done = true;
      off?.();
    }
  };

  return {
    async begin(host, startedBy, from) {
      const date = now();
      const wrote = await options.record.setIf(
        { host, startedAt: date.toISOString(), startedBy, from, status: "running" },
        (cur) => !(cur?.status === "running" && date.getTime() - Date.parse(cur.startedAt) < STALE_MS),
      );
      if (wrote) tokens.set(host, ++counter);
      return wrote;
    },
    async finish(host, report) {
      if (report.status === "failed") return settle(host, { status: "failed", error: report.error ?? "update failed" });
      if (report.status === "up-to-date")
        return settle(host, { status: "up-to-date", ...(report.to !== undefined ? { to: report.to } : {}) });
      if (report.status === "clients-only")
        return settle(host, { status: "updated", ...(report.to !== undefined ? { to: report.to } : {}) });
      if (host === "local") return;
      void waitForNode(host, report, tokens.get(host) ?? 0).catch((error: unknown) => {
        console.error(`update wait for ${host} failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
  };
}

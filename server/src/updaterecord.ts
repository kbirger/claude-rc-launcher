import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "./hostregistry";

export type UpdateStatus = "running" | "updated" | "up-to-date" | "failed" | "rolled back" | "unknown";
export type UpdateEntry = {
  host: string;
  startedAt: string;
  finishedAt?: string;
  startedBy: string;
  from: string;
  to?: string;
  status: UpdateStatus;
  error?: string;
};

const FILE = "updates.json";
const STATUSES: readonly string[] = ["running", "updated", "up-to-date", "failed", "rolled back", "unknown"];

/**
 * The last update of each machine, kept in `<stateDir>/updates.json`. The hub owns the file and writes it
 * atomically. A missing or corrupt file loads as an empty list, and the next `set` replaces it.
 */
export class UpdateRecord {
  private chain: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(e: UpdateEntry) => void>();

  private constructor(
    private entries: UpdateEntry[],
    private dir: string,
    private now: () => Date,
  ) {}

  static async load(o: { stateDir: string; now?: () => Date }): Promise<UpdateRecord> {
    let entries: UpdateEntry[] = [];
    const file = path.join(o.stateDir, FILE);
    let text: string | undefined;
    try {
      text = await readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`cannot read ${file}: ${(e as Error).message}`);
    }
    if (text !== undefined) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed?.updates)) entries = parsed.updates.filter(valid).map(clean);
      } catch {
        // corrupt: start empty, the next set replaces the file
      }
    }
    return new UpdateRecord(entries, o.stateDir, o.now ?? (() => new Date()));
  }

  list(): UpdateEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  set(e: UpdateEntry): Promise<void> {
    return this.locked(() => this.apply(e));
  }

  /** Writes `e` only when `allow(current entry of that host)` says so; the check and the write cannot be split by another `set`. */
  setIf(e: UpdateEntry, allow: (current: UpdateEntry | undefined) => boolean): Promise<boolean> {
    return this.locked(async () => {
      const cur = this.entries.find((x) => x.host === e.host);
      if (!allow(cur ? { ...cur } : undefined)) return false;
      await this.apply(e);
      return true;
    });
  }

  /** After a hub restart: a `running` entry of a node can no longer be followed. Writes only what changes. */
  markStaleRunning(reason = "the hub restarted while the update ran"): Promise<void> {
    return this.locked(async () => {
      for (const e of this.entries.filter((x) => x.host !== "local" && x.status === "running")) {
        await this.apply({ ...e, status: "unknown", error: reason, finishedAt: this.now().toISOString() });
      }
    });
  }

  onChange(fn: (e: UpdateEntry) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** After a hub restart: settle a `running` entry of the hub itself. Writes only when it changes an entry. */
  reconcileHub(currentVersion: string): Promise<void> {
    return this.locked(async () => {
      const e = this.entries.find((x) => x.host === "local");
      if (!e || e.status !== "running") return;
      const finishedAt = this.now().toISOString();
      await this.apply(
        currentVersion !== e.from ? { ...e, status: "updated", to: currentVersion, finishedAt } : { ...e, status: "rolled back", finishedAt },
      );
    });
  }

  private async apply(e: UpdateEntry): Promise<void> {
    const next = [...this.entries.filter((x) => x.host !== e.host), { ...e }];
    const created = await mkdir(this.dir, { recursive: true, mode: 0o700 });
    if (created && process.platform !== "win32") await chmod(this.dir, 0o700);
    await writeAtomic(path.join(this.dir, FILE), JSON.stringify({ updates: next }, null, 2) + "\n", 0o600);
    this.entries = next;
    for (const fn of [...this.listeners]) {
      try {
        fn({ ...e });
      } catch {
        // a broken listener must not affect the others or the write
      }
    }
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }
}

function valid(e: any): e is UpdateEntry {
  const str = (v: unknown) => typeof v === "string";
  const opt = (v: unknown) => v === undefined || str(v);
  return (
    e !== null &&
    typeof e === "object" &&
    str(e.host) &&
    str(e.startedAt) &&
    str(e.startedBy) &&
    str(e.from) &&
    STATUSES.includes(e.status) &&
    opt(e.finishedAt) &&
    opt(e.to) &&
    opt(e.error)
  );
}

/** Keep only the known fields. */
function clean(e: UpdateEntry): UpdateEntry {
  const { host, startedAt, finishedAt, startedBy, from, to, status, error } = e;
  return {
    host,
    startedAt,
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    startedBy,
    from,
    ...(to !== undefined ? { to } : {}),
    status,
    ...(error !== undefined ? { error } : {}),
  };
}

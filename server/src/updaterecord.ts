import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "./hostregistry";

export type UpdateStatus = "running" | "updated" | "up-to-date" | "failed" | "rolled back" | "unknown";
export interface UpdateEntry {
  host: string;
  startedAt: string;
  finishedAt?: string;
  startedBy: string;
  from: string;
  to?: string;
  status: UpdateStatus;
  error?: string;
  /** Only while `status` is `running`. */
  step?: string;
  stepDetail?: string;
}

const FILE = "updates.json";
const STATUSES: readonly string[] = ["running", "updated", "up-to-date", "failed", "rolled back", "unknown"];

/**
 * The last update of each machine, kept in `<stateDir>/updates.json`. The hub owns the file and writes it
 * atomically. A missing or corrupt file loads as an empty list, and the next `set` replaces it.
 */
export class UpdateRecord {
  private chain: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(updateEntry: UpdateEntry) => void>();

  private constructor(
    private entries: UpdateEntry[],
    private dir: string,
    private now: () => Date,
  ) {}

  static async load(options: { stateDir: string; now?: () => Date }): Promise<UpdateRecord> {
    let entries: UpdateEntry[] = [];
    const file = path.join(options.stateDir, FILE);
    let text: string | undefined;

    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(`cannot read ${file}: ${(error as Error).message}`);
    }

    if (text !== undefined) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed?.updates)) entries = parsed.updates.filter(valid).map(clean);
      } catch {
        // corrupt: start empty, the next set replaces the file
      }
    }

    return new UpdateRecord(entries, options.stateDir, options.now ?? (() => new Date()));
  }

  list(): UpdateEntry[] {
    return this.entries.map((updateEntry) => ({ ...updateEntry }));
  }

  set(updateEntry: UpdateEntry): Promise<void> {
    return this.locked(() => this.apply(updateEntry));
  }

  /** Writes `e` only when `allow(current entry of that host)` says so; the check and the write cannot be split by another `set`. */
  setIf(updateEntry: UpdateEntry, allow: (current: UpdateEntry | undefined) => boolean): Promise<boolean> {
    return this.locked(async () => {
      const cur = this.entries.find((existing) => existing.host === updateEntry.host);
      if (!allow(cur ? { ...cur } : undefined)) return false;
      await this.apply(updateEntry);
      return true;
    });
  }

  /** After a hub restart: a `running` entry of a node can no longer be followed. Writes only what changes. */
  markStaleRunning(reason = "the hub restarted while the update ran"): Promise<void> {
    return this.locked(async () => {
      for (const updateEntry of this.entries.filter(
        (response) => response.host !== "local" && response.status === "running",
      )) {
        await this.apply({ ...updateEntry, status: "unknown", error: reason, finishedAt: this.now().toISOString() });
      }
    });
  }

  onChange(fn: (updateEntry: UpdateEntry) => void): () => void {
    this.listeners.add(fn);

    return () => {
      this.listeners.delete(fn);
    };
  }

  /** After a hub restart: settle a `running` entry of the hub itself. Writes only when it changes an entry. */
  reconcileHub(currentVersion: string): Promise<void> {
    return this.locked(async () => {
      const updateEntry = this.entries.find((updateEntry) => updateEntry.host === "local");
      if (!updateEntry || updateEntry.status !== "running") return;
      const finishedAt = this.now().toISOString();
      await this.apply(
        currentVersion !== updateEntry.from
          ? { ...updateEntry, status: "updated", to: currentVersion, finishedAt }
          : { ...updateEntry, status: "rolled back", finishedAt },
      );
    });
  }

  private async apply(updateEntry: UpdateEntry): Promise<void> {
    updateEntry = clean(updateEntry);
    const next = [...this.entries.filter((existing) => existing.host !== updateEntry.host), updateEntry];
    const created = await mkdir(this.dir, { recursive: true, mode: 0o700 });
    if (created && process.platform !== "win32") await chmod(this.dir, 0o700);
    await writeAtomic(path.join(this.dir, FILE), JSON.stringify({ updates: next }, null, 2) + "\n", 0o600);
    this.entries = next;

    for (const fn of [...this.listeners]) {
      try {
        fn({ ...updateEntry });
      } catch {
        // a broken listener must not affect the others or the write
      }
    }
  }

  private locked<Value>(fn: () => Promise<Value>): Promise<Value> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }
}

function valid(response: any): response is UpdateEntry {
  const str = (value: unknown) => typeof value === "string";
  const opt = (value: unknown) => value === undefined || str(value);
  return (
    response !== null &&
    typeof response === "object" &&
    str(response.host) &&
    str(response.startedAt) &&
    str(response.startedBy) &&
    str(response.from) &&
    STATUSES.includes(response.status) &&
    opt(response.finishedAt) &&
    opt(response.to) &&
    opt(response.error) &&
    opt(response.step) &&
    opt(response.stepDetail)
  );
}

/** Keep only the known fields. A final status drops `step` and `stepDetail`. */
function clean(updateEntry: UpdateEntry): UpdateEntry {
  const { host, startedAt, finishedAt, startedBy, from, to, status, error, step, stepDetail } = updateEntry;
  const running = status === "running";
  return {
    host,
    startedAt,
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    startedBy,
    from,
    ...(to !== undefined ? { to } : {}),
    status,
    ...(error !== undefined ? { error } : {}),
    ...(running && step !== undefined ? { step } : {}),
    ...(running && stepDetail !== undefined ? { stepDetail } : {}),
  };
}

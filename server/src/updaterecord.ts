import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

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
    try {
      const parsed = JSON.parse(await readFile(path.join(o.stateDir, FILE), "utf8"));
      if (Array.isArray(parsed?.updates)) entries = parsed.updates.filter(valid).map(clean);
    } catch {
      // missing or corrupt: start empty
    }
    return new UpdateRecord(entries, o.stateDir, o.now ?? (() => new Date()));
  }

  list(): UpdateEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  set(e: UpdateEntry): Promise<void> {
    return this.locked(() => this.apply(e));
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

async function writeAtomic(file: string, data: string, mode: number): Promise<void> {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, data, { mode });
  if (process.platform !== "win32") await chmod(tmp, mode);
  await rename(tmp, file);
}

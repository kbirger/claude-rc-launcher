import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "./hostregistry";
import { cutLine, type LogLine } from "./updatelog";
import type { UpdateEntry } from "./updaterecord";

export type HistoryItem = { entry: UpdateEntry; lines: LogLine[] };

const FILE = "update-history.json";
export const MAX_ITEMS = 20;
export const MAX_LINES = 200;
const MAX_FIELD = 500;

const isStr = (v: unknown): v is string => typeof v === "string";

function cleanEntry(v: any): UpdateEntry | undefined {
  if (!v || typeof v !== "object" || !isStr(v.host) || !isStr(v.startedAt) || !isStr(v.startedBy) || !isStr(v.from) || !isStr(v.status) || v.status === "running") return undefined;
  const cut = (s: unknown) => (isStr(s) ? s.slice(0, MAX_FIELD) : undefined);
  const out: UpdateEntry = { host: v.host.slice(0, MAX_FIELD), startedAt: v.startedAt.slice(0, 64), startedBy: v.startedBy.slice(0, MAX_FIELD), from: v.from.slice(0, 64), status: v.status };
  if (isStr(v.finishedAt)) out.finishedAt = v.finishedAt.slice(0, 64);
  if (isStr(v.to)) out.to = v.to.slice(0, 64);
  const err = cut(v.error);
  if (err !== undefined) out.error = err;
  return out;
}

function cleanLines(v: unknown): LogLine[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((l) => l && isStr(l.line) && isStr(l.at))
    .slice(-MAX_LINES)
    .map((l) => ({ line: cutLine(l.line), at: l.at.slice(0, 40) }));
}

/**
 * The last 20 finished updates of each host with their output lines, kept in `<stateDir>/update-history.json`.
 * The hub owns the file and writes it atomically. A missing or corrupt file loads as empty.
 */
export class UpdateHistory {
  private chain: Promise<unknown> = Promise.resolve();
  private constructor(
    private items: HistoryItem[],
    private dir: string,
  ) {}

  static async load(o: { stateDir: string }): Promise<UpdateHistory> {
    const file = path.join(o.stateDir, FILE);
    let items: HistoryItem[] = [];
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      if (Array.isArray(parsed?.items)) {
        items = parsed.items.flatMap((i: any) => {
          const entry = cleanEntry(i?.entry);
          return entry ? [{ entry, lines: cleanLines(i.lines) }] : [];
        });
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" && !(e instanceof SyntaxError)) throw new Error(`cannot read ${file}: ${(e as Error).message}`);
    }
    return new UpdateHistory(items, o.stateDir);
  }

  /** Newest first, for each host. */
  list(): Record<string, HistoryItem[]> {
    const out: Record<string, HistoryItem[]> = {};
    for (const i of [...this.items].reverse()) (out[i.entry.host] ??= []).push({ entry: { ...i.entry }, lines: i.lines.map((l) => ({ ...l })) });
    return out;
  }

  /** Adds a finished update. The same host and start time replace the item. A running entry is ignored. */
  add(entry: UpdateEntry, lines: LogLine[]): Promise<void> {
    const clean = cleanEntry(entry);
    if (!clean) return Promise.resolve();
    const item = { entry: clean, lines: cleanLines(lines) };
    const run = this.chain.then(() => this.apply(item));
    this.chain = run.catch(() => {});
    return run;
  }

  private async apply(item: HistoryItem): Promise<void> {
    const host = item.entry.host;
    const same = (i: HistoryItem) => i.entry.host === host && i.entry.startedAt === item.entry.startedAt;
    const old = this.items.find(same);
    // A later settle of the same update (for example a hub restart) keeps the lines that an earlier write held.
    if (old && item.lines.length === 0) item.lines = old.lines;
    let next = [...this.items.filter((i) => !same(i)), item];
    const mine = next.filter((i) => i.entry.host === host);
    if (mine.length > MAX_ITEMS) {
      const drop = new Set(mine.slice(0, mine.length - MAX_ITEMS));
      next = next.filter((i) => !drop.has(i));
    }
    const created = await mkdir(this.dir, { recursive: true, mode: 0o700 });
    if (created && process.platform !== "win32") await chmod(this.dir, 0o700);
    await writeAtomic(path.join(this.dir, FILE), JSON.stringify({ items: next }) + "\n", 0o600);
    this.items = next;
  }
}

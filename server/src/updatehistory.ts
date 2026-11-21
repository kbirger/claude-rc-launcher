import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "./hostregistry";
import { cutLine } from "./updatelog";
import type { LogLine } from "./updatelog";
import type { UpdateEntry } from "./updaterecord";

export interface HistoryItem {
  entry: UpdateEntry;
  lines: LogLine[];
}

const FILE = "update-history.json";
export const MAX_ITEMS = 20;
export const MAX_LINES = 200;
const MAX_FIELD = 500;

const isStr = (value: unknown): value is string => typeof value === "string";

function cleanEntry(response: any): UpdateEntry | undefined {
  if (
    !response ||
    typeof response !== "object" ||
    !isStr(response.host) ||
    !isStr(response.startedAt) ||
    !isStr(response.startedBy) ||
    !isStr(response.from) ||
    !isStr(response.status) ||
    response.status === "running"
  )
    return undefined;
  const cut = (value: unknown) => (isStr(value) ? value.slice(0, MAX_FIELD) : undefined);
  const out: UpdateEntry = {
    host: response.host.slice(0, MAX_FIELD),
    startedAt: response.startedAt.slice(0, 64),
    startedBy: response.startedBy.slice(0, MAX_FIELD),
    from: response.from.slice(0, 64),
    status: response.status,
  };
  if (isStr(response.finishedAt)) out.finishedAt = response.finishedAt.slice(0, 64);
  if (isStr(response.to)) out.to = response.to.slice(0, 64);
  const err = cut(response.error);
  if (err !== undefined) out.error = err;
  return out;
}

function cleanLines(value: unknown): LogLine[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && isStr(item.line) && isStr(item.at))
    .slice(-MAX_LINES)
    .map((item) => ({ line: cutLine(item.line), at: item.at.slice(0, 40) }));
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

  static async load(options: { stateDir: string }): Promise<UpdateHistory> {
    const file = path.join(options.stateDir, FILE);
    let items: HistoryItem[] = [];

    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));

      if (Array.isArray(parsed?.items)) {
        items = parsed.items.flatMap((raw: any) => {
          const updateEntry = cleanEntry(raw?.entry);
          return updateEntry ? [{ entry: updateEntry, lines: cleanLines(raw.lines) }] : [];
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError))
        throw new Error(`cannot read ${file}: ${(error as Error).message}`);
    }

    return new UpdateHistory(items, options.stateDir);
  }

  /** Newest first, for each host. */
  list(): Record<string, HistoryItem[]> {
    const out: Record<string, HistoryItem[]> = {};
    for (const item of [...this.items].reverse())
      (out[item.entry.host] ??= []).push({
        entry: { ...item.entry },
        lines: item.lines.map((logLine) => ({ ...logLine })),
      });
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
    const same = (historyItem: HistoryItem) =>
      historyItem.entry.host === host && historyItem.entry.startedAt === item.entry.startedAt;
    const old = this.items.find(same);
    // A later settle of the same update (for example a hub restart) keeps the lines that an earlier write held.
    if (old && item.lines.length === 0) item.lines = old.lines;
    let next = [...this.items.filter((historyItem) => !same(historyItem)), item];
    const mine = next.filter((historyItem) => historyItem.entry.host === host);

    if (mine.length > MAX_ITEMS) {
      const drop = new Set(mine.slice(0, mine.length - MAX_ITEMS));
      next = next.filter((historyItem) => !drop.has(historyItem));
    }

    const created = await mkdir(this.dir, { recursive: true, mode: 0o700 });
    if (created && process.platform !== "win32") await chmod(this.dir, 0o700);
    await writeAtomic(path.join(this.dir, FILE), JSON.stringify({ items: next }) + "\n", 0o600);
    this.items = next;
  }
}

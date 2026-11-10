const MAX_LINE = 500;
const MAX_AT = 40;

/** The cut that every stored or compared output line gets. */
export function cutLine(line: string): string {
  return line.length > MAX_LINE ? line.slice(0, MAX_LINE - 3) + "..." : line;
}

/** The time of a line: the node's `at` when it is a short, readable time, else `fallback`. */
export function cleanAt(at: unknown, fallback: string): string {
  return typeof at === "string" && at.length <= MAX_AT && !Number.isNaN(Date.parse(at)) ? at : fallback;
}

export type LogLine = { line: string; at: string };

/** The last lines of output of the node updates, for each host, in memory only. */
export class UpdateLog {
  private readonly maxLines: number;
  private readonly now: () => Date;
  private readonly lines = new Map<string, LogLine[]>();
  private readonly subs = new Set<(e: { host: string; line: string; at: string }) => void>();

  constructor(o: { maxLines?: number; now?: () => Date } = {}) {
    this.maxLines = o.maxLines ?? 200;
    this.now = o.now ?? (() => new Date());
  }

  add(host: string, line: string, at?: string): void {
    at = cleanAt(at, this.now().toISOString());
    line = cutLine(line);
    const list = this.lines.get(host) ?? [];
    list.push({ line, at });
    if (list.length > this.maxLines) list.splice(0, list.length - this.maxLines);
    this.lines.set(host, list);
    for (const fn of [...this.subs]) {
      try {
        fn({ host, line, at });
      } catch {
        // one bad listener must not stop the others
      }
    }
  }

  clear(host: string): void {
    this.lines.delete(host);
  }

  get(host: string): LogLine[] {
    return (this.lines.get(host) ?? []).map((l) => ({ ...l }));
  }

  all(): Record<string, LogLine[]> {
    return Object.fromEntries([...this.lines].map(([h, l]) => [h, l.map((x) => ({ ...x }))]));
  }

  onLine(fn: (e: { host: string; line: string; at: string }) => void): () => void {
    this.subs.add(fn);
    return () => void this.subs.delete(fn);
  }
}

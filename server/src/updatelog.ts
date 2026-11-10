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
    at ??= this.now().toISOString();
    line = line.length > 500 ? line.slice(0, 497) + "..." : line;
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

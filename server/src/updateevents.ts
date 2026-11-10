export type StepName = "downloading" | "verifying" | "installing-client" | "installing" | "restarting" | "failed" | "up-to-date";

export type NodeEvent =
  | { type: "step"; step: StepName; to?: string; client?: string; detail?: string }
  | { type: "log"; line: string; at: string };

export type UpdateHooks = {
  onStep?(e: { step: StepName; to?: string; client?: string; detail?: string }): void;
  onLog?(line: string): void;
};

type Line = { line: string; at: string };

// Holds the live state of a node update: the current step and the last lines of output.
export class NodeEvents {
  private readonly now: () => Date;
  private readonly maxLines: number;
  private readonly subs = new Set<(e: NodeEvent) => void>();
  private buffer: Line[] = [];
  private current: { step: StepName; to?: string; startedAt: string } | null = null;

  constructor(o: { now?: () => Date; maxLines?: number } = {}) {
    this.now = o.now ?? (() => new Date());
    this.maxLines = o.maxLines ?? 200;
  }

  hooks(): Required<UpdateHooks> {
    return {
      onStep: (e) => this.emit({ type: "step", ...e }),
      onLog: (line) => this.emit({ type: "log", line, at: this.now().toISOString() }),
    };
  }

  emit(e: NodeEvent): void {
    if (e.type === "log") {
      this.buffer.push({ line: e.line, at: e.at });
      if (this.buffer.length > this.maxLines) this.buffer.splice(0, this.buffer.length - this.maxLines);
    } else if (e.step === "downloading") {
      this.buffer = [];
      this.current = { step: e.step, to: e.to, startedAt: this.now().toISOString() };
    } else if (e.step === "up-to-date" || e.step === "failed") {
      this.current = null;
    } else if (this.current) {
      this.current = { ...this.current, step: e.step, to: e.to ?? this.current.to };
    }
    for (const fn of [...this.subs]) {
      try {
        fn(e);
      } catch {
        // one bad subscriber must not stop the others
      }
    }
  }

  subscribe(fn: (e: NodeEvent) => void): () => void {
    this.subs.add(fn);
    return () => void this.subs.delete(fn);
  }

  snapshotUpdate(): { step: StepName; to?: string; startedAt: string } | null {
    return this.current ? { ...this.current } : null;
  }

  lines(): { line: string; at: string }[] {
    return this.buffer.map((l) => ({ ...l }));
  }
}

export type StepName =
  "downloading" | "verifying" | "installing-client" | "installing" | "restarting" | "failed" | "up-to-date";

export type NodeEvent =
  | { type: "step"; step: StepName; to?: string; client?: string; detail?: string }
  | { type: "log"; line: string; at: string };

export interface UpdateHooks {
  onStep?(options: { step: StepName; to?: string; client?: string; detail?: string }): void;
  onLog?(line: string): void;
}

interface Line {
  line: string;
  at: string;
}

// Holds the live state of a node update: the current step and the last lines of output.
export class NodeEvents {
  private readonly now: () => Date;
  private readonly maxLines: number;
  private readonly subs = new Set<(value: NodeEvent) => void>();
  private buffer: Line[] = [];
  private current: { step: StepName; to?: string; startedAt: string } | null = null;

  constructor(options: { now?: () => Date; maxLines?: number } = {}) {
    this.now = options.now ?? (() => new Date());
    this.maxLines = options.maxLines ?? 200;
  }

  hooks(): Required<UpdateHooks> {
    return {
      onStep: (event) => {
        this.emit({ type: "step", ...event });
      },
      onLog: (line) => {
        this.emit({ type: "log", line, at: this.now().toISOString() });
      },
    };
  }

  emit(nodeEvent: NodeEvent): void {
    if (nodeEvent.type === "log") {
      this.buffer.push({ line: nodeEvent.line, at: nodeEvent.at });
      if (this.buffer.length > this.maxLines) this.buffer.splice(0, this.buffer.length - this.maxLines);
    } else if (nodeEvent.step === "downloading") {
      this.buffer = [];
      this.current = { step: nodeEvent.step, to: nodeEvent.to, startedAt: this.now().toISOString() };
    } else if (nodeEvent.step === "up-to-date" || nodeEvent.step === "failed") {
      this.current = null;
    } else if (this.current) {
      this.current = { ...this.current, step: nodeEvent.step, to: nodeEvent.to ?? this.current.to };
    }

    for (const fn of [...this.subs]) {
      try {
        fn(nodeEvent);
      } catch {
        // one bad subscriber must not stop the others
      }
    }
  }

  subscribe(fn: (value: NodeEvent) => void): () => void {
    this.subs.add(fn);
    return () => void this.subs.delete(fn);
  }

  snapshotUpdate(): { step: StepName; to?: string; startedAt: string } | null {
    return this.current ? { ...this.current } : null;
  }

  lines(): { line: string; at: string }[] {
    return this.buffer.map((line) => ({ ...line }));
  }
}

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isObject } from "../shared/requests";
import { NAME_RANK, tidy } from "./names";
import type { NameInfo, NameSource } from "./names";
import { SESSION_ID } from "./transcript";
import type { TranscriptFs } from "./transcriptfs";

// Name memory. A Remote Control session has no title record in its transcript, so after `/compact` the launcher can
// only name it from the first prompt that is left. This store keeps the best name the launcher ever learned for each
// session, so that the name survives. A better source is never replaced by a worse one (see NAME_RANK in names.ts).
// A first-prompt name is never replaced by a later first prompt: the first one is the real one.
// The store is a small JSON file in the node's state folder. A file that is missing, too big or not valid is empty.
// Cleanup: at most 1000 names, each cut to 200 characters, the oldest `seen` dropped first, `seen` refreshed when the
// session is listed, and a name whose transcript file is gone is deleted (at startup and at most once a day).
// There is no expiry by time alone: a session that is resumed after two months must keep its name.

const MAX_NAMES = 1000;
const MAX_NAME_LEN = 200;
const MAX_FILE_LEN = 1024;
const MAX_BYTES = 1024 * 1024;
const SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;
/** A `seen` that is newer than this is not written again, so that a list call does not write the file each time. */
const SEEN_GRANULARITY_MS = 60 * 60 * 1000;
const SWEEP_PARALLEL = 16;

interface Entry {
  name: string;
  source: NameSource;
  seen: number;
  file?: string;
}
type Data = Map<string, Entry>;

function missing(error: unknown): boolean {
  const errorLike = error as { code?: unknown; message?: unknown } | null;
  return (
    errorLike?.code === "ENOENT" || (typeof errorLike?.message === "string" && errorLike.message.includes("ENOENT"))
  );
}

export class NameMemory {
  private data: Data = new Map();
  private loaded?: Promise<void>;
  private sweeping?: Promise<void>;
  private lastSweep = 0;
  private writing: Promise<void> = Promise.resolve();

  /** Without `file` the store lives in memory only. `now` is for tests. */
  constructor(
    private readonly file?: string,
    private readonly now: () => number = Date.now,
  ) {}

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.file) return;

      try {
        const text = await readFile(this.file, "utf8");
        if (text.length > MAX_BYTES) return;
        const parsed: unknown = JSON.parse(text);
        if (!isObject(parsed)) return;

        for (const [id, entry] of Object.entries(parsed)) {
          if (!SESSION_ID.test(id) || !isObject(entry)) continue;
          const name = typeof entry.name === "string" ? tidy(entry.name)?.slice(0, MAX_NAME_LEN) : undefined;
          const source = entry.source as NameSource;
          if (
            !name ||
            !(source in NAME_RANK) ||
            NAME_RANK[source] === 0 ||
            typeof entry.seen !== "number" ||
            !Number.isFinite(entry.seen)
          )
            continue;
          const file = typeof entry.file === "string" && entry.file.length <= MAX_FILE_LEN ? entry.file : undefined;
          this.data.set(id, { name, source, seen: entry.seen, ...(file ? { file } : {}) });
        }
      } catch {
        // missing or not valid: start empty
      }
    })();
    return this.loaded;
  }

  /**
   * The name to show for the session `id`, whose chain (a `/clear` chain, `id` included) is `chain`. `candidate` is what
   * the launcher reads now. The best of the candidate and the remembered names is returned, and it is remembered for `id`.
   * `file` is the transcript of `id`: when it is gone, the name is deleted by the sweep.
   */
  async resolve(options: {
    id: string;
    chain: readonly string[];
    candidate?: NameInfo;
    file?: string;
  }): Promise<NameInfo | undefined> {
    await this.load();
    await this.sweepIfDue();
    const now = this.now();
    const ids = new Set([options.id, ...options.chain].filter((id) => SESSION_ID.test(id)));
    // The best remembered name of the chain. At equal trust the earlier member wins: the chain is named from its start.
    let best: Entry | undefined;

    for (const chainId of options.chain) {
      const entry = this.data.get(chainId);
      if (entry && (!best || NAME_RANK[entry.source] > NAME_RANK[best.source])) best = entry;
    }

    const candidateName = options.candidate ? tidy(options.candidate.name) : undefined;
    const cand =
      options.candidate && candidateName
        ? { name: candidateName.slice(0, MAX_NAME_LEN), source: options.candidate.source }
        : undefined;
    let chosen: NameInfo | undefined = best;

    if (cand) {
      const better =
        !best ||
        NAME_RANK[cand.source] > NAME_RANK[best.source] ||
        (NAME_RANK[cand.source] === NAME_RANK[best.source] && cand.source !== "prompt");
      if (better) chosen = cand;
    }

    let dirty = false;

    for (const id of ids) {
      const entry = this.data.get(id);

      if (entry && now - entry.seen >= SEEN_GRANULARITY_MS) {
        entry.seen = now;
        dirty = true;
      } else if (entry) {
        entry.seen = Math.max(entry.seen, now);
      }
    }

    if (chosen && NAME_RANK[chosen.source] > 0 && SESSION_ID.test(options.id)) {
      const old = this.data.get(options.id);
      const file = options.file && options.file.length <= MAX_FILE_LEN ? options.file : old?.file;

      if (old?.name !== chosen.name || old.source !== chosen.source || old.file !== file) {
        // Delete first, so that the entry becomes the newest in the object order.
        this.data.delete(options.id);
        this.data.set(options.id, { name: chosen.name, source: chosen.source, seen: now, ...(file ? { file } : {}) });
        dirty = true;
      }
    }

    if (dirty) await this.save();
    return chosen;
  }

  /** Delete the names whose transcript is gone, at most once a day. The first call after a start does it. */
  private sweepIfDue(): Promise<void> {
    if (this.sweeping) return this.sweeping;
    if (this.now() - this.lastSweep < SWEEP_EVERY_MS) return Promise.resolve();
    this.lastSweep = this.now();
    this.sweeping = this.exists
      ? this.sweep(this.exists).finally(() => (this.sweeping = undefined))
      : Promise.resolve();
    return this.sweeping;
  }

  private exists?: (file: string) => Promise<boolean>;

  /** Tell the store how to check that a transcript file is there. Without it nothing is swept. */
  useFs(fs: TranscriptFs): void {
    this.exists = async (file) => {
      try {
        await fs.stat(file);
        return true;
      } catch (error) {
        // Only a missing file counts. Any other error (no access, a full disk) keeps the name.
        return !missing(error);
      }
    };
  }

  private async sweep(exists: (file: string) => Promise<boolean>): Promise<void> {
    const todo = [...this.data.entries()].filter(
      (pair): pair is [string, Entry & { file: string }] => pair[1].file !== undefined,
    );
    const gone: string[] = [];
    let next = 0;

    const worker = async () => {
      while (next < todo.length) {
        const [id, entry] = todo[next++];
        if (!(await exists(entry.file))) gone.push(id);
      }
    };

    await Promise.all(Array.from({ length: Math.min(SWEEP_PARALLEL, todo.length) }, worker));
    if (gone.length === 0) return;
    for (const id of gone) this.data.delete(id);
    await this.save();
  }

  private save(): Promise<void> {
    const ids = [...this.data.keys()];

    if (ids.length > MAX_NAMES) {
      // The oldest `seen` go first.
      ids.sort((left, right) => (this.data.get(left)?.seen ?? 0) - (this.data.get(right)?.seen ?? 0));
      for (const id of ids.slice(0, ids.length - MAX_NAMES)) this.data.delete(id);
    }

    const file = this.file;
    if (!file) return Promise.resolve();
    const text = JSON.stringify(Object.fromEntries(this.data));
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        await writeFile(tmp, text, { mode: 0o600 });
        await rename(tmp, file);
      } catch {
        // The store still works in memory.
      }
    });
    return this.writing;
  }
}

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SESSION_ID } from "./transcript";

// Session chains. `/clear` starts a new transcript with a new session id, but the process keeps its Remote Control
// connection (`bridgeSessionId`). The transcripts do not name their predecessor, so this store remembers, for each
// bridge id, the session ids that a running-session file showed with it, oldest first. Sessions that share a bridge id
// are one chain. The match is exact: it only starts when the launcher first sees the pair, and it never guesses.
// The store is a small JSON file in the node's state folder. A file that is missing, too big or not valid is empty.

const MAX_BRIDGES = 1000;
const MAX_IDS = 100;
const MAX_BYTES = 1024 * 1024;
const MAX_BRIDGE_LEN = 256;

type Data = Map<string, string[]>;

export class SessionChains {
  private data: Data = new Map();
  private loaded?: Promise<void>;
  private writing: Promise<void> = Promise.resolve();

  /** Without `file` the store lives in memory only. */
  constructor(private readonly file?: string) {}

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.file) return;

      try {
        const text = await readFile(this.file, "utf8");
        if (text.length > MAX_BYTES) return;
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;

        for (const [bridge, ids] of Object.entries(parsed as Record<string, unknown>)) {
          if (bridge.length > MAX_BRIDGE_LEN || !Array.isArray(ids)) continue;
          const good = ids.filter((id): id is string => typeof id === "string" && SESSION_ID.test(id)).slice(-MAX_IDS);
          if (good.length) this.data.set(bridge, good);
        }
      } catch {
        // missing or not valid: start empty
      }
    })();
    return this.loaded;
  }

  /** Remember the pairs (bridge id, session id) of the running sessions. A known pair changes nothing. */
  async observe(pairs: Iterable<readonly [string, string]>): Promise<void> {
    await this.load();
    let changed = false;

    for (const [bridge, id] of pairs) {
      if (bridge.length === 0 || bridge.length > MAX_BRIDGE_LEN || !SESSION_ID.test(id)) continue;
      const ids = this.data.get(bridge);

      if (!ids) {
        this.data.set(bridge, [id]);
        changed = true;
      } else if (!ids.includes(id)) {
        ids.push(id);
        if (ids.length > MAX_IDS) ids.shift();
        changed = true;
      }
    }

    if (!changed) return;
    const keys = [...this.data.keys()];
    // Object keys keep insertion order, so the first keys are the oldest bridges.
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_BRIDGES))) this.data.delete(key);
    await this.save();
  }

  /** Remember that `successor` came from `predecessor` with no bridge id to show it (a match by time, or a process link). */
  async link(predecessor: string, successor: string): Promise<void> {
    if (predecessor === successor || !SESSION_ID.test(predecessor) || !SESSION_ID.test(successor)) return;
    await this.observe([
      [`link:${successor}`, predecessor],
      [`link:${successor}`, successor],
    ]);
  }

  /**
   * The session ids of the chain of `id`: every id that is joined to it, directly or through others, `id` included.
   * Just `[id]` when it is in no chain. The order is the order of the store (first sight): callers sort by time if they need to.
   */
  async chainOf(id: string): Promise<string[]> {
    await this.load();
    const chain = new Set([id]);

    for (let grew = true; grew;) {
      grew = false;

      for (const ids of this.data.values()) {
        if (!ids.some((item) => chain.has(item))) continue;
        for (const item of ids) if (!chain.has(item)) (chain.add(item), (grew = true));
      }
    }

    // In the order of the store, so that a chain from one bridge id keeps its order. `id` alone stays alone.
    const ordered = [...new Set([...this.data.values()].flat())].filter((item) => chain.has(item));
    return ordered.length ? ordered : [id];
  }

  private save(): Promise<void> {
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

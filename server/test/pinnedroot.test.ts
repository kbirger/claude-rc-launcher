import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { HttpError } from "../src/instances";
import * as pinnedroot from "../src/pinnedroot";
import { PinnedRoot, type PinnedFile } from "../src/pinnedroot";
import { Session, SessionCatalog, type SessionCatalogOptions } from "../src/sessioncatalog";
import type { TranscriptFs } from "../src/transcriptfs";

// The real-root cases use symlinks and POSIX folders, so they skip on Windows. The two type tests never run their bodies.
const win = process.platform === "win32";
const SID = "11111111-2222-3333-4444-555555555555";

let dir: string;
let root: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "pinned-")));
  root = join(dir, "work");
  await mkdir(root);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** A Session of the instance folder `root` whose transcript names `cwd` as its first cwd. */
function sessionAt(cwd: string, o: SessionCatalogOptions = {}): Session {
  const inst = new SessionCatalog(o).instance({ path: root, home: join(dir, "home") });
  return new Session(inst, { id: SID, file: join(dir, "t.jsonl"), mtimeMs: 1, root: cwd, worktree: false });
}

/** The error that `p` rejects with. */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

describe("PinnedRoot", () => {
  test("PinnedRoot has no public constructor", () => {
    // Never called: the line below only has to fail to compile while the constructor stays private.
    const never = (s: Session) => {
      // @ts-expect-error the constructor is private
      return new PinnedRoot(s, "/real");
    };
    expect(typeof never).toBe("function");
  });

  test("PinnedFile cannot be built outside pinnedroot.ts", () => {
    // Never called: pinnedroot.ts exports PinnedFile as a type only, so the module has no value here to build.
    const never = (c: SessionCatalog): PinnedFile => {
      // @ts-expect-error PinnedFile is a type only outside pinnedroot.ts
      return new pinnedroot.PinnedFile(c, "/dir", "name");
    };
    expect(typeof never).toBe("function");
  });

  test.skipIf(win)("open() refuses a session root outside the instance folder with 404", async () => {
    const out = join(dir, "outside");
    await mkdir(out);
    const e = await rejection(sessionAt(out).open());
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(404);
    expect((e as HttpError).message).toBe("session folder not found");
  });

  test.skipIf(win)("open() refuses a link root that leads out with 404", async () => {
    const out = join(dir, "outside");
    await mkdir(out);
    await symlink(out, join(root, "link"));
    const e = await rejection(sessionAt(join(root, "link")).open());
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(404);
    expect((e as HttpError).message).toBe("session folder not found");
  });
});

// The opener result goes to the route as it is: a wrapped download stream would break its abort and close handling.
describe("the opener result", () => {
  /** A fake opener that records its arguments and returns `sentinel`. */
  const opener = (sentinel: object) => {
    const calls: unknown[][] = [];
    const fn = (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve(sentinel);
    };
    return { fn: fn as never, calls };
  };

  /** A transcript with one confirmed Write of `abs`, so that `touchedFile(abs)` finds it. */
  const writeFs = (abs: string): TranscriptFs => {
    const lines = [
      JSON.stringify({ type: "assistant", timestamp: "2026-01-01T00:00:00Z", message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: abs } }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } }),
    ];
    return {
      readdir: async () => [],
      stat: async () => ({ mtimeMs: 1 }),
      lines: async function* () { yield* lines; },
    };
  };

  /** A PinnedFile for a touched file outside the session folder. */
  async function pinnedFile(o: SessionCatalogOptions) {
    const abs = join(dir, "out", "note.txt");
    const pinned = await sessionAt(root, { fs: writeFs(abs), ...o }).open();
    return { file: await pinned.touchedFile(abs), abs };
  }

  test("PinnedRoot.download returns the opener result unchanged", async () => {
    const sentinel = { stream: {} };
    const o = opener(sentinel);
    const pinned = await sessionAt(root, { openDownload: o.fn }).open();
    const out = await pinned.download("a/b.txt");
    expect(out).toBe(sentinel as never);
    expect(o.calls).toEqual([[await realpath(root), "a/b.txt", { exactRoot: true }]]);
  });

  test("PinnedRoot.preview returns the opener result unchanged", async () => {
    const sentinel = { kind: "text" };
    const o = opener(sentinel);
    const pinned = await sessionAt(root, { previewIn: o.fn }).open();
    const out = await pinned.preview("a/b.txt");
    expect(out).toBe(sentinel as never);
    expect(o.calls).toEqual([[await realpath(root), "a/b.txt", { exactRoot: true }]]);
  });

  test("PinnedFile.download returns the opener result unchanged", async () => {
    const sentinel = { stream: {} };
    const o = opener(sentinel);
    const { file, abs } = await pinnedFile({ openDownload: o.fn });
    const out = await file.download();
    expect(out).toBe(sentinel as never);
    expect(o.calls).toEqual([[dirname(abs), basename(abs), { exactRoot: true, exactPath: true }]]);
  });

  test("PinnedFile.preview returns the opener result unchanged", async () => {
    const sentinel = { kind: "text" };
    const o = opener(sentinel);
    const { file, abs } = await pinnedFile({ previewIn: o.fn });
    const out = await file.preview();
    expect(out).toBe(sentinel as never);
    expect(o.calls).toEqual([[dirname(abs), basename(abs), { exactRoot: true, exactPath: true }]]);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import * as pinnedroot from "../../src/sessions/PinnedRoot";
import { PinnedRoot } from "../../src/sessions/PinnedRoot";
import type { PinnedFile } from "../../src/sessions/PinnedRoot";
import { Session } from "../../src/sessions/Session";
import { SessionCatalog } from "../../src/sessions/SessionCatalog";
import type { SessionCatalogOptions } from "../../src/sessions/SessionCatalog";
import type { TranscriptFs } from "../../src/sessions/transcriptfs";
import { HttpError } from "../../src/shared/HttpError";

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
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A Session of the instance folder `root` whose transcript names `cwd` as its first cwd. */
function sessionAt(cwd: string, sessionCatalogOptions: SessionCatalogOptions = {}): Session {
  const inst = new SessionCatalog(sessionCatalogOptions).instance({ path: root, home: join(dir, "home") });
  return new Session(inst, { id: SID, file: join(dir, "t.jsonl"), mtimeMs: 1, root: cwd, worktree: false });
}

/** The error that `p` rejects with. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("expected a rejection");
}

describe("PinnedRoot", () => {
  test("PinnedRoot has no public constructor", () => {
    // Never called: the line below only has to fail to compile while the constructor stays private.
    const never = (session: Session) => {
      // @ts-expect-error the constructor is private
      return new PinnedRoot(session, "/real");
    };

    expect(typeof never).toBe("function");
  });

  test("PinnedFile cannot be built outside pinnedroot.ts", () => {
    // Never called: pinnedroot.ts exports PinnedFile as a type only, so the module has no value here to build.
    const never = (sessionCatalog: SessionCatalog): PinnedFile => {
      // @ts-expect-error PinnedFile is a type only outside pinnedroot.ts
      return new pinnedroot.PinnedFile(sessionCatalog, "/dir", "name");
    };

    expect(typeof never).toBe("function");
  });

  test.skipIf(win)("open() refuses a session root outside the instance folder with 404", async () => {
    const out = join(dir, "outside");
    await mkdir(out);
    const entry = await rejection(sessionAt(out).open());
    expect(entry).toBeInstanceOf(HttpError);
    expect((entry as HttpError).status).toBe(404);
    expect((entry as HttpError).message).toBe("session folder not found");
  });

  test.skipIf(win)("open() refuses a link root that leads out with 404", async () => {
    const out = join(dir, "outside");
    await mkdir(out);
    await symlink(out, join(root, "link"));
    const entry = await rejection(sessionAt(join(root, "link")).open());
    expect(entry).toBeInstanceOf(HttpError);
    expect((entry as HttpError).status).toBe(404);
    expect((entry as HttpError).message).toBe("session folder not found");
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
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-01-01T00:00:00Z",
        message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: abs } }] },
      }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } }),
    ];
    return {
      readdir: () => Promise.resolve([]),
      stat: () => Promise.resolve({ mtimeMs: 1 }),
      lines: async function* () {
        yield* lines;
      },
    };
  };

  /** A PinnedFile for a touched file outside the session folder. */
  async function pinnedFile(sessionCatalogOptions: SessionCatalogOptions) {
    const abs = join(dir, "out", "note.txt");
    const pinned = await sessionAt(root, { fs: writeFs(abs), ...sessionCatalogOptions }).open();
    return { file: await pinned.touchedFile(abs), abs };
  }

  test("PinnedRoot.download returns the opener result unchanged", async () => {
    const sentinel = { stream: {} };
    const harness = opener(sentinel);
    const pinned = await sessionAt(root, { openDownload: harness.fn }).open();
    const out = await pinned.download("a/b.txt");
    expect(out).toBe(sentinel as never);
    expect(harness.calls).toEqual([[await realpath(root), "a/b.txt", { exactRoot: true }]]);
  });

  test("PinnedRoot.preview returns the opener result unchanged", async () => {
    const sentinel = { kind: "text" };
    const harness = opener(sentinel);
    const pinned = await sessionAt(root, { previewIn: harness.fn }).open();
    const out = await pinned.preview("a/b.txt");
    expect(out).toBe(sentinel as never);
    expect(harness.calls).toEqual([[await realpath(root), "a/b.txt", { exactRoot: true }]]);
  });

  test("PinnedFile.download returns the opener result unchanged", async () => {
    const sentinel = { stream: {} };
    const harness = opener(sentinel);
    const { file, abs } = await pinnedFile({ openDownload: harness.fn });
    const out = await file.download();
    expect(out).toBe(sentinel as never);
    expect(harness.calls).toEqual([[dirname(abs), basename(abs), { exactRoot: true, exactPath: true }]]);
  });

  test("PinnedFile.preview returns the opener result unchanged", async () => {
    const sentinel = { kind: "text" };
    const harness = opener(sentinel);
    const { file, abs } = await pinnedFile({ previewIn: harness.fn });
    const out = await file.preview();
    expect(out).toBe(sentinel as never);
    expect(harness.calls).toEqual([[dirname(abs), basename(abs), { exactRoot: true, exactPath: true }]]);
  });
});

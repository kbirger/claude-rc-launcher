import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "../src/instances";
import * as pinnedroot from "../src/pinnedroot";
import { PinnedRoot, type PinnedFile } from "../src/pinnedroot";
import { Session, SessionCatalog } from "../src/sessioncatalog";

// The real-root cases use symlinks and POSIX folders, so they skip on Windows. The two type tests never run their bodies.
const win = process.platform === "win32";
const SID = "11111111-2222-3333-4444-555555555555";

let dir: string;
let root: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pinned-"));
  root = join(dir, "work");
  await mkdir(root);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** A Session of the instance folder `root` whose transcript names `cwd` as its first cwd. */
function sessionAt(cwd: string): Session {
  const inst = new SessionCatalog().instance({ path: root, home: join(dir, "home") });
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

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLiveSessions, type LiveFs } from "../src/livesessions";

const HOME = "/h";
const DIR = join(HOME, ".claude", "sessions");
const S1 = "11111111-1111-1111-1111-111111111111";
const S2 = "22222222-2222-2222-2222-222222222222";

const file = (pid: number, extra: object = {}) =>
  JSON.stringify({ pid, sessionId: S1, cwd: "/work", kind: "interactive", entrypoint: "sdk-cli", status: "busy", statusUpdatedAt: 1, name: "proj-1", nameSource: "derived", updatedAt: 1, ...extra });

/** A sessions folder in memory. `asked` records every path the reader opened. */
function fakeFs(files: Record<string, string>, asked: string[] = []): LiveFs {
  return {
    readdir: async (dir) => {
      if (dir !== DIR) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return Object.keys(files);
    },
    readHead: async (p, max) => {
      asked.push(p);
      const name = p.slice(DIR.length + 1);
      const text = files[name];
      if (text === undefined) throw new Error("ENOENT");
      return Buffer.from(text).subarray(0, max);
    },
  };
}

const alive = (pids: number[]) => (pid: number) => pids.includes(pid);

describe("readLiveSessions", () => {
  test("a file of a running process gives its status, Remote Control state and name", async () => {
    const files = { "100.json": file(100, { bridgeSessionId: "cse_abc" }), "200.json": file(200, { sessionId: S2, status: "idle", name: "other" }) };
    const m = await readLiveSessions({ home: HOME, fs: fakeFs(files), alive: alive([100, 200]) });
    expect([...m.entries()]).toEqual([
      [S1, { status: "busy", remoteControl: true, name: "proj-1" }],
      [S2, { status: "idle", remoteControl: false, name: "other" }],
    ]);
  });

  test("a file whose process is dead is ignored", async () => {
    const m = await readLiveSessions({ home: HOME, fs: fakeFs({ "100.json": file(100) }), alive: alive([]) });
    expect(m.size).toBe(0);
  });

  test("key files are never opened, and nothing but .json files is", async () => {
    const asked: string[] = [];
    const files = { "100.json": file(100), "100.abc123.key": "peerToken", "notes.txt": "x", "100.json.key": "t" };
    const m = await readLiveSessions({ home: HOME, fs: fakeFs(files, asked), alive: alive([100]) });
    expect(m.size).toBe(1);
    expect(asked).toEqual([join(DIR, "100.json")]);
  });

  test("a file over 64 KB and a file that is not valid JSON are skipped", async () => {
    const big = file(100, { pad: "x".repeat(70 * 1024) });
    const files = { "100.json": big, "200.json": "{not json", "300.json": "[1,2]", "400.json": file(400, { sessionId: S2 }) };
    const m = await readLiveSessions({ home: HOME, fs: fakeFs(files), alive: alive([100, 200, 300, 400]) });
    expect([...m.keys()]).toEqual([S2]);
  });

  test("only the whitelisted fields are returned", async () => {
    const files = { "100.json": file(100, { peerToken: "SECRET", messagingSocketPath: "/tmp/sock", bridgeSessionId: "cse_1" }) };
    const m = await readLiveSessions({ home: HOME, fs: fakeFs(files), alive: alive([100]) });
    const v = m.get(S1)!;
    expect(Object.keys(v).sort()).toEqual(["name", "remoteControl", "status"]);
    expect(JSON.stringify(v)).not.toContain("SECRET");
    expect(JSON.stringify(v)).not.toContain("sock");
    expect(JSON.stringify(v)).not.toContain("cse_1");
  });

  test("a bad pid, a pid that does not match the file name, a bad session id or a missing status is ignored", async () => {
    const checked: number[] = [];
    const files = {
      "0.json": file(0),
      "-1.json": file(-1),
      "100.json": file(101),
      "102.json": file(102, { sessionId: "../x" }),
      "103.json": file(103, { status: 5 }),
      "104.json": file(104, { pid: "104" }),
    };
    const m = await readLiveSessions({ home: HOME, fs: fakeFs(files), alive: (p) => (checked.push(p), true) });
    expect(m.size).toBe(0);
    expect(checked).not.toContain(0);
    expect(checked).not.toContain(-1);
  });

  test("a name that is not a string is left out", async () => {
    const m = await readLiveSessions({ home: HOME, fs: fakeFs({ "100.json": file(100, { name: 7 }) }), alive: alive([100]) });
    expect(m.get(S1)).toEqual({ status: "busy", remoteControl: false });
  });

  test("a missing sessions folder gives an empty map", async () => {
    const m = await readLiveSessions({ home: "/nowhere", fs: fakeFs({}), alive: alive([]) });
    expect(m.size).toBe(0);
  });

  test("at most 500 files are read", async () => {
    const asked: string[] = [];
    const files: Record<string, string> = {};
    for (let i = 1; i <= 600; i++) files[`${i}.json`] = file(i);
    await readLiveSessions({ home: HOME, fs: fakeFs(files, asked), alive: alive([]) });
    expect(asked.length).toBe(500);
  });

  test("with the real file system, the sessions folder under home is read and this process counts as alive", async () => {
    const home = await mkdtemp(join(tmpdir(), "live-"));
    try {
      await mkdir(join(home, ".claude", "sessions"), { recursive: true });
      await writeFile(join(home, ".claude", "sessions", `${process.pid}.json`), file(process.pid));
      // A pid far above any real pid limit: ESRCH, so the file is dead.
      await writeFile(join(home, ".claude", "sessions", "999999999.json"), file(999999999, { sessionId: S2 }));
      await writeFile(join(home, ".claude", "sessions", `${process.pid}.x.key`), "peerToken");
      const m = await readLiveSessions({ home });
      expect([...m.keys()]).toEqual([S1]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

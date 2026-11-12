import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLiveSessions, statStartTime, type LiveFs, type ProcReads } from "../src/livesessions";

const HOME = "/h";
const DIR = join(HOME, ".claude", "sessions");
const S1 = "11111111-1111-1111-1111-111111111111";
const S2 = "22222222-2222-2222-2222-222222222222";
const MACHINE = "9b8897d1776243e09c1d9e28b59898cc";

const file = (pid: number, extra: object = {}) =>
  JSON.stringify({ pid, sessionId: S1, cwd: "/work", kind: "interactive", entrypoint: "sdk-cli", status: "busy", statusUpdatedAt: 1, name: "proj-1", nameSource: "derived", updatedAt: 1, ...extra });

/** A sessions folder in memory. `asked` records every path the reader opened, `listed` counts the names it took. */
function fakeFs(files: Record<string, string>, asked: string[] = [], listed = { n: 0 }): LiveFs {
  return {
    entries: async function* (dir) {
      if (dir !== DIR) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      for (const name of Object.keys(files)) {
        listed.n++;
        yield name;
      }
    },
    readHead: async (p, max) => {
      asked.push(p);
      const name = p.slice(DIR.length + 1);
      const text = files[name];
      if (text === undefined) throw new Error("ENOENT");
      return Buffer.from(text).subarray(0, max);
    },
    realpath: async (p) => p,
  };
}

/** No /proc: liveness falls back to `alive`. */
const NO_PROC: ProcReads = { startTime: async () => undefined, machineId: async () => undefined, pidNamespace: async () => undefined };
const alive = (pids: number[]) => (pid: number) => pids.includes(pid);
const live = (files: Record<string, string>, pids: number[], extra: Partial<Parameters<typeof readLiveSessions>[0]> = {}) =>
  readLiveSessions({ home: HOME, fs: fakeFs(files), alive: alive(pids), proc: NO_PROC, ...extra });

describe("readLiveSessions", () => {
  test("a file of a running process gives its status, Remote Control state and name", async () => {
    const files = { "100.json": file(100, { bridgeSessionId: "cse_abc" }), "200.json": file(200, { sessionId: S2, status: "idle", name: "other" }) };
    const m = await live(files, [100, 200]);
    expect([...m.entries()]).toEqual([
      [S1, { status: "busy", remoteControl: true, name: "proj-1" }],
      [S2, { status: "idle", remoteControl: false, name: "other" }],
    ]);
  });

  test("a file whose process is dead is ignored", async () => {
    expect((await live({ "100.json": file(100) }, [])).size).toBe(0);
  });

  test("key files are never opened, and nothing but .json files is", async () => {
    const asked: string[] = [];
    const files = { "100.json": file(100), "100.abc123.key": "peerToken", "notes.txt": "x", "100.json.key": "t" };
    const m = await readLiveSessions({ home: HOME, fs: fakeFs(files, asked), alive: alive([100]), proc: NO_PROC });
    expect(m.size).toBe(1);
    expect(asked).toEqual([join(DIR, "100.json")]);
  });

  test("a file over 64 KB and a file that is not valid JSON are skipped", async () => {
    const big = file(100, { pad: "x".repeat(70 * 1024) });
    const files = { "100.json": big, "200.json": "{not json", "300.json": "[1,2]", "400.json": file(400, { sessionId: S2 }) };
    expect([...(await live(files, [100, 200, 300, 400])).keys()]).toEqual([S2]);
  });

  test("only the whitelisted fields are returned", async () => {
    const m = await live({ "100.json": file(100, { peerToken: "SECRET", messagingSocketPath: "/tmp/sock", bridgeSessionId: "cse_1" }) }, [100]);
    const v = m.get(S1)!;
    expect(Object.keys(v).sort()).toEqual(["name", "remoteControl", "status"]);
    expect(JSON.stringify(v)).not.toContain("SECRET");
    expect(JSON.stringify(v)).not.toContain("sock");
    expect(JSON.stringify(v)).not.toContain("cse_1");
  });

  test("a bad pid, a pid that does not match the file name, or a bad session id is ignored", async () => {
    const checked: number[] = [];
    const files = {
      "0.json": file(0),
      "-1.json": file(-1),
      "100.json": file(101),
      "102.json": file(102, { sessionId: "../x" }),
      "104.json": file(104, { pid: "104" }),
    };
    const m = await readLiveSessions({ home: HOME, fs: fakeFs(files), alive: (p) => (checked.push(p), true), proc: NO_PROC });
    expect(m.size).toBe(0);
    expect(checked).not.toContain(0);
    expect(checked).not.toContain(-1);
  });

  test("a status other than busy or idle keeps the session live, with no status", async () => {
    const files = { "100.json": file(100, { status: "waiting" }), "101.json": file(101, { status: "x".repeat(5000), sessionId: S2 }) };
    const m = await live(files, [100, 101]);
    expect([...m.entries()]).toEqual([
      [S1, { remoteControl: false, name: "proj-1" }],
      [S2, { remoteControl: false, name: "proj-1" }],
    ]);
    expect("status" in m.get(S1)!).toBe(false);
  });

  test("a name that is not a string is left out", async () => {
    expect((await live({ "100.json": file(100, { name: 7 }) }, [100])).get(S1)).toEqual({ status: "busy", remoteControl: false });
  });

  test("a missing sessions folder gives an empty map", async () => {
    const m = await readLiveSessions({ home: "/nowhere", fs: fakeFs({}), alive: alive([]), proc: NO_PROC });
    expect(m.size).toBe(0);
  });

  test("at most 500 .json files are opened, and the listing stops there", async () => {
    const asked: string[] = [];
    const listed = { n: 0 };
    const files: Record<string, string> = {};
    for (let i = 1; i <= 10000; i++) files[`${i}.json`] = file(i);
    await readLiveSessions({ home: HOME, fs: fakeFs(files, asked, listed), alive: alive([]), proc: NO_PROC });
    expect(asked.length).toBe(500);
    expect(listed.n).toBeLessThan(10000);
  });

  test("a folder of 10,000 other names is not fully listed", async () => {
    const listed = { n: 0 };
    const files: Record<string, string> = {};
    for (let i = 1; i <= 10000; i++) files[`${i}.x.key`] = "t";
    files["1.json"] = file(1);
    const asked: string[] = [];
    await readLiveSessions({ home: HOME, fs: fakeFs(files, asked, listed), alive: alive([1]), proc: NO_PROC });
    expect(listed.n).toBe(5000);
    expect(asked).toEqual([]);
  });
});

describe("pid reuse", () => {
  const proc = (o: Partial<ProcReads> = {}): ProcReads => ({ ...NO_PROC, ...o });
  const domain = (machine = MACHINE, ns = "4026532689") => `linux:${machine}:pid:[${ns}]`;

  test("a process whose start time matches procStart is live, without kill", async () => {
    const m = await live({ "100.json": file(100, { procStart: "273029972" }) }, [], { proc: proc({ startTime: async () => "273029972" }) });
    expect(m.size).toBe(1);
  });

  test("a process whose start time differs from procStart is a reused pid and not live", async () => {
    const m = await live({ "100.json": file(100, { procStart: "273029972" }) }, [100], { proc: proc({ startTime: async () => "999" }) });
    expect(m.size).toBe(0);
  });

  test("a pid that /proc does not have is not live, without kill", async () => {
    const m = await live({ "100.json": file(100, { procStart: "1" }) }, [100], { proc: proc({ startTime: async () => "gone" }) });
    expect(m.size).toBe(0);
  });

  test("when /proc cannot be read, kill(pid, 0) decides", async () => {
    const f = { "100.json": file(100, { procStart: "1" }) };
    expect((await live(f, [100])).size).toBe(1);
    expect((await live(f, [])).size).toBe(0);
  });

  test("a pidDomain of another machine or another pid namespace is not live", async () => {
    const here = proc({ startTime: async () => "1", machineId: async () => MACHINE, pidNamespace: async () => "4026532689" });
    expect((await live({ "100.json": file(100, { procStart: "1", pidDomain: domain() }) }, [], { proc: here })).size).toBe(1);
    expect((await live({ "100.json": file(100, { procStart: "1", pidDomain: domain("0".repeat(32)) }) }, [100], { proc: here })).size).toBe(0);
    expect((await live({ "100.json": file(100, { procStart: "1", pidDomain: domain(MACHINE, "1") }) }, [100], { proc: here })).size).toBe(0);
  });

  test("an unreadable machine id or namespace does not skip on that basis", async () => {
    const blind = proc({ startTime: async () => "1" });
    expect((await live({ "100.json": file(100, { procStart: "1", pidDomain: domain("0".repeat(32), "1") }) }, [], { proc: blind })).size).toBe(1);
  });
});

test("statStartTime takes field 22, counted after the last closing parenthesis", () => {
  const rest = "S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 273029972 20 21";
  expect(statStartTime(`1234 (claude) ${rest}`)).toBe("273029972");
  expect(statStartTime(`1234 (a) b (c)) ${rest}`)).toBe("273029972");
  expect(statStartTime("garbage")).toBeUndefined();
});

describe("the real file system", () => {
  async function withHome(fn: (home: string, outside: string) => Promise<void>) {
    const base = await realpath(await mkdtemp(join(tmpdir(), "live-")));
    try {
      const home = join(base, "home");
      const outside = join(base, "outside");
      await mkdir(home);
      await mkdir(outside);
      await writeFile(join(outside, `${process.pid}.json`), file(process.pid));
      await fn(home, outside);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }

  test("the sessions folder under home is read and this process counts as alive", async () => {
    await withHome(async (home) => {
      const dir = join(home, ".claude", "sessions");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${process.pid}.json`), file(process.pid));
      // A pid far above any real pid limit: the file is dead.
      await writeFile(join(dir, "999999999.json"), file(999999999, { sessionId: S2 }));
      await writeFile(join(dir, `${process.pid}.x.key`), "peerToken");
      expect([...(await readLiveSessions({ home })).keys()]).toEqual([S1]);
    });
  });

  test("a sessions folder that is a link out of home gives no live sessions", async () => {
    await withHome(async (home, outside) => {
      await mkdir(join(home, ".claude"));
      await symlink(outside, join(home, ".claude", "sessions"));
      expect((await readLiveSessions({ home })).size).toBe(0);
    });
  });

  test("a .claude folder that is a link out of home gives no live sessions", async () => {
    await withHome(async (home, outside) => {
      await mkdir(join(outside, "sessions"));
      await writeFile(join(outside, "sessions", `${process.pid}.json`), file(process.pid));
      await symlink(outside, join(home, ".claude"));
      expect((await readLiveSessions({ home })).size).toBe(0);
    });
  });
});

import { describe, expect, spyOn, test } from "bun:test";
import { createCloner } from "../src/cloner";
import type { Config } from "../src/config";
import { bunLoginSpawner, type LoginProc, type LoginSpawner } from "../src/ghlogin";
import { HttpError } from "../src/instances";
import type { RunOptions, RunResult } from "../src/runner";

const id = { home: "/home/u", path: "/usr/bin" };
const CODE = "! First copy your one-time code: ABCD-1234\n";
const URL_LINE = "Open this URL to continue in your web browser: https://github.com/login/device\n";

type Fake = { proc: LoginProc; emit(s: string): void; exit(code: number): void; killed: () => boolean; spawned: { cmd: string; args: string[]; env: Record<string, string>; stdin: string } };
function fakeSpawner() {
  const made: Fake[] = [];
  const spawn: LoginSpawner = (cmd, args, opts) => {
    let cb: (c: string) => void = () => {};
    let res!: (n: number) => void;
    let killed = false;
    const exited = new Promise<number>((r) => { res = r; });
    const proc: LoginProc = { onOutput: (f) => { cb = f; }, exited, kill: () => { killed = true; res(137); } };
    made.push({ proc, emit: (s) => cb(s), exit: res, killed: () => killed, spawned: { cmd, args, env: opts.env, stdin: opts.stdin } });
    return proc;
  };
  return { spawn, made };
}
function fakeClock() {
  const timers: { fn: () => void; at: number; id: number }[] = [];
  let now = 0, n = 0;
  return {
    clock: {
      setTimeout: (fn: () => void, ms: number) => { const t = { fn, at: now + ms, id: ++n }; timers.push(t); return t.id; },
      clearTimeout: (t: unknown) => { const i = timers.findIndex((x) => x.id === t); if (i >= 0) timers.splice(i, 1); },
    },
    advance(ms: number) {
      now += ms;
      for (const t of [...timers].sort((a, b) => a.at - b.at)) {
        if (t.at <= now && timers.includes(t)) { timers.splice(timers.indexOf(t), 1); t.fn(); }
      }
    },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(runResult: RunResult = { code: 0, stdout: "", stderr: "" }) {
  const f = fakeSpawner();
  const c = fakeClock();
  const calls: { cmd: string; args: string[]; opts?: RunOptions }[] = [];
  const cloner = createCloner({
    cfg: { roots: [] } as unknown as Config,
    run: async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return runResult; },
    identityFor: async () => id,
    spawnLogin: f.spawn,
    loginClock: c.clock,
  });
  return { cloner, calls, ...f, ...c };
}
async function fail(p: Promise<unknown>): Promise<HttpError> {
  try { await p; } catch (e) { if (e instanceof HttpError) return e; throw e; }
  throw new Error("did not throw");
}

describe("login", () => {
  test("starts gh auth login --web and returns id, code and url", async () => {
    const t = setup();
    const p = t.cloner.loginStart();
    await tick();
    expect(t.made[0].spawned.cmd).toBe("gh");
    expect(t.made[0].spawned.args).toEqual(["auth", "login", "--web", "--hostname", "github.com", "--git-protocol", "https"]);
    expect(t.made[0].spawned.stdin).toBe("\n");
    expect(t.made[0].spawned.env.HOME).toBe("/home/u");
    expect(t.made[0].spawned.env.GH_PROMPT_DISABLED).toBeUndefined();
    t.made[0].emit(CODE + URL_LINE);
    const out = await p;
    expect(out.id).toMatch(/^[0-9a-f]{32}$/);
    expect(out.code).toBe("ABCD-1234");
    expect(out.url).toBe("https://github.com/login/device");
    expect(await t.cloner.loginStatus(out.id)).toEqual({ state: "pending" });
  });

  test("parses lines split across chunks", async () => {
    const t = setup();
    const p = t.cloner.loginStart();
    await tick();
    const all = CODE + URL_LINE;
    for (let i = 0; i < all.length; i += 7) t.made[0].emit(all.slice(i, i + 7));
    expect((await p).code).toBe("ABCD-1234");
  });

  test("exit 0 runs gh auth setup-git as the same user, then done", async () => {
    const t = setup();
    const p = t.cloner.loginStart("bob");
    await tick();
    t.made[0].emit(CODE + URL_LINE);
    const { id: lid } = await p;
    t.made[0].exit(0);
    await tick(); await tick();
    expect(t.calls[0].cmd).toBe("gh");
    expect(t.calls[0].args).toEqual(["auth", "setup-git"]);
    expect(t.calls[0].opts?.env?.HOME).toBe("/home/u");
    expect(await t.cloner.loginStatus(lid)).toEqual({ state: "done" });
  });

  test("setup-git failure gives failed", async () => {
    const t = setup({ code: 1, stdout: "", stderr: "boom\n" });
    const p = t.cloner.loginStart();
    await tick();
    t.made[0].emit(CODE + URL_LINE);
    const { id: lid } = await p;
    t.made[0].exit(0);
    await tick(); await tick();
    const s = await t.cloner.loginStatus(lid);
    expect(s.state).toBe("failed");
    expect(s.error).toContain("setup-git");
  });

  test("non-zero exit gives failed with the first output line, never the code", async () => {
    const t = setup();
    const p = t.cloner.loginStart();
    await tick();
    t.made[0].emit(CODE + URL_LINE + "failed to authenticate ABCD-1234 expired\n");
    const { id: lid } = await p;
    t.made[0].exit(1);
    await tick();
    const s = await t.cloner.loginStatus(lid);
    expect(s.state).toBe("failed");
    expect(s.error).toContain("failed to authenticate");
    expect(s.error).not.toContain("ABCD-1234");
    expect(t.calls.length).toBe(0);
  });

  test("a second start for the same user returns the pending login, another user gets its own", async () => {
    const t = setup();
    const p1 = t.cloner.loginStart("bob");
    const p2 = t.cloner.loginStart("bob");
    await tick();
    t.made[0].emit(CODE + URL_LINE);
    const [a, b] = await Promise.all([p1, p2]);
    expect(b).toEqual(a);
    expect(await t.cloner.loginStart("bob")).toEqual(a);
    expect(t.made.length).toBe(1);
    const p3 = t.cloner.loginStart("amy");
    await tick();
    t.made[1].emit(CODE + URL_LINE);
    expect((await p3).id).not.toBe(a.id);
  });

  test("after a finished login the same user can start a new one", async () => {
    const t = setup();
    const p = t.cloner.loginStart();
    await tick();
    t.made[0].emit(CODE + URL_LINE);
    await p;
    t.made[0].exit(1);
    await tick();
    const p2 = t.cloner.loginStart();
    await tick();
    expect(t.made.length).toBe(2);
    t.made[1].emit(CODE + URL_LINE);
    await p2;
  });

  test("after 10 minutes the process is killed and the state is failed", async () => {
    const t = setup();
    const p = t.cloner.loginStart();
    await tick();
    t.made[0].emit(CODE + URL_LINE);
    const { id: lid } = await p;
    t.advance(10 * 60 * 1000);
    await tick();
    expect(t.made[0].killed()).toBe(true);
    const s = await t.cloner.loginStatus(lid);
    expect(s.state).toBe("failed");
    expect(s.error).toContain("timed out");
  });

  test("finished logins are forgotten after 10 minutes", async () => {
    const t = setup();
    const p = t.cloner.loginStart();
    await tick();
    t.made[0].emit(CODE + URL_LINE);
    const { id: lid } = await p;
    t.made[0].exit(1);
    await tick();
    expect((await t.cloner.loginStatus(lid)).state).toBe("failed");
    t.advance(10 * 60 * 1000);
    expect((await fail(t.cloner.loginStatus(lid))).status).toBe(404);
  });

  test("no code within 15 seconds gives 504 and kills the process", async () => {
    const t = setup();
    const p = fail(t.cloner.loginStart());
    await tick();
    t.advance(15_000);
    expect((await p).status).toBe(504);
    expect(t.made[0].killed()).toBe(true);
    const p2 = t.cloner.loginStart();
    await tick();
    expect(t.made.length).toBe(2);
    t.made[1].emit(CODE + URL_LINE);
    await p2;
  });

  test("exit 127 and a spawn failure give 500 gh is not installed", async () => {
    const t = setup();
    const p = fail(t.cloner.loginStart());
    await tick();
    t.made[0].exit(127);
    const e = await p;
    expect(e.status).toBe(500);
    expect(e.message).toBe("gh is not installed");
    const c = createCloner({
      cfg: { roots: [] } as unknown as Config,
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
      identityFor: async () => id,
      spawnLogin: () => { throw new Error("ENOENT"); },
    });
    const e2 = await fail(c.loginStart());
    expect(e2.status).toBe(500);
    expect(e2.message).toBe("gh is not installed");
  });

  test("unknown id gives 404", async () => {
    const t = setup();
    const e = await fail(t.cloner.loginStatus("0".repeat(32)));
    expect(e.status).toBe(404);
    expect(e.message).toBe("unknown login");
  });

  test("the code never reaches console output", async () => {
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((m) => spyOn(console, m).mockImplementation(() => {}));
    try {
      const t = setup();
      const p = t.cloner.loginStart();
      await tick();
      t.made[0].emit(CODE + URL_LINE);
      const { id: lid } = await p;
      t.made[0].exit(1);
      await tick();
      await t.cloner.loginStatus(lid);
      for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain("ABCD-1234");
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

describe("bunLoginSpawner", () => {
  test("streams stdout and stderr, feeds stdin and reports the exit code", async () => {
    const proc = bunLoginSpawner("sh", ["-c", "echo out1; echo err1 >&2; read x; echo got-$x; exit 0"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdin: "\n" });
    let text = "";
    proc.onOutput((c) => { text += c; });
    expect(await proc.exited).toBe(0);
    expect(text).toContain("out1");
    expect(text).toContain("err1");
    expect(text).toContain("got-");
  });

  test("kill ends a running process", async () => {
    const proc = bunLoginSpawner("sh", ["-c", "sleep 30"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdin: "" });
    proc.kill();
    expect(await proc.exited).not.toBe(0);
  });
});

import { describe, expect, spyOn, test } from "bun:test";
import { createCloner } from "../../src/instances/cloner";
import type { Config } from "../../src/config/parse";
import { bunLoginSpawner } from "../../src/instances/ghlogin";
import type { LoginProc, LoginSpawner } from "../../src/instances/ghlogin";
import { HttpError } from "../../src/instances/InstanceService";
import type { RunOptions, RunResult } from "../../src/shared/runner";

const id = { home: "/home/u", path: "/usr/bin" };
const CODE = "! First copy your one-time code: ABCD-1234\n";
const URL_LINE = "Open this URL to continue in your web browser: https://github.com/login/device\n";

interface Fake {
  proc: LoginProc;
  emit(value: string): void;
  exit(code: number): void;
  killed: () => boolean;
  spawned: { cmd: string; args: string[]; env: Record<string, string>; stdin: string };
}

function fakeSpawner() {
  const made: Fake[] = [];

  const spawn: LoginSpawner = (cmd, args, opts) => {
    let cb: (value: string) => void = () => {};

    let res!: (value: number) => void;
    let killed = false;
    const exited = new Promise<number>((resolve) => {
      res = resolve;
    });
    const proc: LoginProc = {
      onOutput: (item) => {
        cb = item;
      },
      exited,
      kill: () => {
        killed = true;
        res(137);
      },
    };
    made.push({
      proc,
      emit: (item) => {
        cb(item);
      },
      exit: res,
      killed: () => killed,
      spawned: { cmd, args, env: opts.env, stdin: opts.stdin },
    });
    return proc;
  };

  return { spawn, made };
}

function fakeClock() {
  const timers: { fn: () => void; at: number; id: number }[] = [];
  let now = 0,
    count = 0;
  return {
    clock: {
      setTimeout: (fn: () => void, ms: number) => {
        const item = { fn, at: now + ms, id: ++count };
        timers.push(item);
        return item.id;
      },
      clearTimeout: (item: unknown) => {
        const position = timers.findIndex((timer) => timer.id === item);
        if (position >= 0) timers.splice(position, 1);
      },
    },
    advance(ms: number) {
      now += ms;

      for (const item of [...timers].sort((left, right) => left.at - right.at)) {
        if (item.at <= now && timers.includes(item)) {
          timers.splice(timers.indexOf(item), 1);
          item.fn();
        }
      }
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(
  runResult: RunResult | (() => Promise<RunResult>) = { code: 0, stdout: "", stderr: "" },
  identityFor: (value?: string) => Promise<typeof id & { uid?: number; gid?: number }> = () => Promise.resolve(id),
  spawner?: LoginSpawner,
) {
  const harness = fakeSpawner();
  const clock = fakeClock();
  const calls: { cmd: string; args: string[]; opts?: RunOptions }[] = [];
  const cloner = createCloner({
    cfg: { roots: [] } as unknown as Config,
    run: async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return typeof runResult === "function" ? runResult() : runResult;
    },
    identityFor,
    spawnLogin: spawner ?? harness.spawn,
    loginClock: clock.clock,
  });
  return { cloner, calls, ...harness, ...clock };
}

async function fail(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }

  throw new Error("did not throw");
}

describe("login", () => {
  test("starts gh auth login --web and returns id, code and url", async () => {
    const harness = setup();
    const loginStart = harness.cloner.loginStart();
    await tick();
    expect(harness.made[0].spawned.cmd).toBe("gh");
    expect(harness.made[0].spawned.args).toEqual([
      "auth",
      "login",
      "--web",
      "--hostname",
      "github.com",
      "--git-protocol",
      "https",
    ]);
    expect(harness.made[0].spawned.stdin).toBe("\n");
    expect(harness.made[0].spawned.env.HOME).toBe("/home/u");
    expect(harness.made[0].spawned.env.GH_PROMPT_DISABLED).toBeUndefined();
    harness.made[0].emit(CODE + URL_LINE);
    const out = await loginStart;
    expect(out.id).toMatch(/^[0-9a-f]{32}$/);
    expect(out.code).toBe("ABCD-1234");
    expect(out.url).toBe("https://github.com/login/device");
    expect(await harness.cloner.loginStatus(out.id)).toEqual({ state: "pending" });
  });

  test("parses lines split across chunks", async () => {
    const harness = setup();
    const loginStart = harness.cloner.loginStart();
    await tick();
    const all = CODE + URL_LINE;
    for (let index = 0; index < all.length; index += 7) harness.made[0].emit(all.slice(index, index + 7));
    expect((await loginStart).code).toBe("ABCD-1234");
  });

  test("exit 0 runs gh auth setup-git as the same user, then done", async () => {
    const harness = setup();
    const loginStart = harness.cloner.loginStart("bob");
    await tick();
    harness.made[0].emit(CODE + URL_LINE);
    const { id: lid } = await loginStart;
    harness.made[0].exit(0);
    await tick();
    await tick();
    expect(harness.calls[0].cmd).toBe("gh");
    expect(harness.calls[0].args).toEqual(["auth", "setup-git"]);
    expect(harness.calls[0].opts?.env?.HOME).toBe("/home/u");
    expect(await harness.cloner.loginStatus(lid)).toEqual({ state: "done" });
  });

  test("setup-git failure gives failed", async () => {
    const harness = setup({ code: 1, stdout: "", stderr: "boom\n" });
    const loginStart = harness.cloner.loginStart();
    await tick();
    harness.made[0].emit(CODE + URL_LINE);
    const { id: lid } = await loginStart;
    harness.made[0].exit(0);
    await tick();
    await tick();
    const loginStatus = await harness.cloner.loginStatus(lid);
    expect(loginStatus.state).toBe("failed");
    expect(loginStatus.error).toContain("setup-git");
  });

  test("non-zero exit gives failed with the first output line, never the code", async () => {
    const harness = setup();
    const loginStart = harness.cloner.loginStart();
    await tick();
    harness.made[0].emit(CODE + URL_LINE + "failed to authenticate ABCD-1234 expired\n");
    const { id: lid } = await loginStart;
    harness.made[0].exit(1);
    await tick();
    const loginStatus = await harness.cloner.loginStatus(lid);
    expect(loginStatus.state).toBe("failed");
    expect(loginStatus.error).toContain("failed to authenticate");
    expect(loginStatus.error).not.toContain("ABCD-1234");
    expect(harness.calls.length).toBe(0);
  });

  test("a second start for the same user returns the pending login, another user gets its own", async () => {
    const harness = setup(undefined, (value) =>
      Promise.resolve(value === "amy" ? { home: "/home/amy", path: "/usr/bin" } : id),
    );
    const p1 = harness.cloner.loginStart("bob");
    const p2 = harness.cloner.loginStart("bob");
    await tick();
    harness.made[0].emit(CODE + URL_LINE);
    const [item, entry] = await Promise.all([p1, p2]);
    expect(entry).toEqual(item);
    expect(await harness.cloner.loginStart("bob")).toEqual(item);
    expect(harness.made.length).toBe(1);
    const p3 = harness.cloner.loginStart("amy");
    await tick();
    harness.made[1].emit(CODE + URL_LINE);
    expect((await p3).id).not.toBe(item.id);
  });

  test("after a finished login the same user can start a new one", async () => {
    const harness = setup();
    const loginStart = harness.cloner.loginStart();
    await tick();
    harness.made[0].emit(CODE + URL_LINE);
    await loginStart;
    harness.made[0].exit(1);
    await tick();
    const p2 = harness.cloner.loginStart();
    await tick();
    expect(harness.made.length).toBe(2);
    harness.made[1].emit(CODE + URL_LINE);
    await p2;
  });

  test("after 10 minutes the process is killed and the state is failed", async () => {
    const harness = setup();
    const loginStart = harness.cloner.loginStart();
    await tick();
    harness.made[0].emit(CODE + URL_LINE);
    const { id: lid } = await loginStart;
    harness.advance(10 * 60 * 1000);
    await tick();
    expect(harness.made[0].killed()).toBe(true);
    const loginStatus = await harness.cloner.loginStatus(lid);
    expect(loginStatus.state).toBe("failed");
    expect(loginStatus.error).toContain("timed out");
  });

  test("finished logins are forgotten after 10 minutes", async () => {
    const harness = setup();
    const loginStart = harness.cloner.loginStart();
    await tick();
    harness.made[0].emit(CODE + URL_LINE);
    const { id: lid } = await loginStart;
    harness.made[0].exit(1);
    await tick();
    expect((await harness.cloner.loginStatus(lid)).state).toBe("failed");
    harness.advance(10 * 60 * 1000);
    expect((await fail(harness.cloner.loginStatus(lid))).status).toBe(404);
  });

  test("no code within 15 seconds gives 504 and kills the process", async () => {
    const harness = setup();
    const promise = fail(harness.cloner.loginStart());
    await tick();
    harness.advance(15_000);
    expect((await promise).status).toBe(504);
    expect(harness.made[0].killed()).toBe(true);
    const p2 = harness.cloner.loginStart();
    await tick();
    expect(harness.made.length).toBe(2);
    harness.made[1].emit(CODE + URL_LINE);
    await p2;
  });

  test("exit 127 and a spawn failure give 500 gh is not installed", async () => {
    const harness = setup();
    const promise = fail(harness.cloner.loginStart());
    await tick();
    harness.made[0].exit(127);
    const httpError = await promise;
    expect(httpError.status).toBe(500);
    expect(httpError.message).toBe("gh is not installed");
    const cloner = createCloner({
      cfg: { roots: [] } as unknown as Config,
      run: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
      identityFor: () => Promise.resolve(id),
      spawnLogin: () => {
        throw new Error("ENOENT");
      },
    });
    const e2 = await fail(cloner.loginStart());
    expect(e2.status).toBe(500);
    expect(e2.message).toBe("gh is not installed");
  });

  test("unknown id gives 404", async () => {
    const harness = setup();
    const httpError = await fail(harness.cloner.loginStatus("0".repeat(32)));
    expect(httpError.status).toBe(404);
    expect(httpError.message).toBe("unknown login");
  });

  test("the code never reaches console output", async () => {
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((item) =>
      spyOn(console, item).mockImplementation(() => {}),
    );

    try {
      const harness = setup();
      const loginStart = harness.cloner.loginStart();
      await tick();
      harness.made[0].emit(CODE + URL_LINE);
      const { id: lid } = await loginStart;
      harness.made[0].exit(1);
      await tick();
      await harness.cloner.loginStatus(lid);
      for (const mock of spies) expect(JSON.stringify(mock.mock.calls)).not.toContain("ABCD-1234");
    } finally {
      for (const mock of spies) mock.mockRestore();
    }
  });
});

describe("login fixes", () => {
  const svc = { home: "/home/svc", path: "/usr/bin" };
  const bobId = { home: "/home/bob", path: "/usr/bin", uid: 1001, gid: 1001 };
  const amyId = { home: "/home/amy", path: "/usr/bin", uid: 1002, gid: 1002 };

  test("no user and the service user's name share one login per OS account", async () => {
    const harness = setup(undefined, () => Promise.resolve(svc));
    const p1 = harness.cloner.loginStart();
    const p2 = harness.cloner.loginStart("svcname");
    await tick();
    harness.made[0].emit(CODE + URL_LINE);
    const [item, entry] = await Promise.all([p1, p2]);
    expect(entry).toEqual(item);
    expect(await harness.cloner.loginStart("svcname")).toEqual(item);
    expect(harness.made.length).toBe(1);
  });

  test("different identities each get their own login", async () => {
    const harness = setup(undefined, (value) =>
      Promise.resolve(value === "bob" ? bobId : value === "amy" ? amyId : svc),
    );
    const pb = harness.cloner.loginStart("bob");
    const pa = harness.cloner.loginStart("amy");
    await tick();
    harness.made[0].emit(CODE + URL_LINE);
    harness.made[1].emit(CODE + URL_LINE);
    const [item, entry] = await Promise.all([pb, pa]);
    expect(item.id).not.toBe(entry.id);
    expect(harness.made.length).toBe(2);
  });

  test("exited rejecting before the code settles loginStart and frees the key", async () => {
    const made: number[] = [];

    const spawn: LoginSpawner = () => {
      made.push(1);
      return { onOutput: () => {}, exited: Promise.reject(new Error("pipe broke")), kill: () => {} };
    };

    const harness = setup(undefined, undefined, spawn);
    const httpError = await fail(harness.cloner.loginStart());
    expect(httpError.status).toBe(502);
    const e2 = await fail(harness.cloner.loginStart());
    expect(e2.status).toBe(502);
    expect(made.length).toBe(2);
  });

  test("the lifetime timer cannot fail a login while setup-git runs", async () => {
    let release!: (runResult: RunResult) => void;
    const harness = setup(
      () =>
        new Promise<RunResult>((resolve) => {
          release = resolve;
        }),
    );
    const loginStart = harness.cloner.loginStart();
    await tick();
    harness.made[0].emit(CODE + URL_LINE);
    const { id: lid } = await loginStart;
    harness.made[0].exit(0);
    await tick();
    harness.advance(11 * 60 * 1000 - 1);
    harness.advance(1);
    expect(harness.made[0].killed()).toBe(false);
    release({ code: 0, stdout: "", stderr: "" });
    await tick();
    expect(await harness.cloner.loginStatus(lid)).toEqual({ state: "done" });
  });

  test("a spawn that throws a setpriv error names the tool behind it", async () => {
    const spawn: LoginSpawner = () => {
      throw new Error("setpriv: failed to execute gh: No such file or directory");
    };

    const harness = setup(undefined, () => Promise.resolve(bobId), spawn);
    const httpError = await fail(harness.cloner.loginStart("bob"));
    expect(httpError.status).toBe(500);
    expect(httpError.message).toBe("gh is not installed");

    const spawn2: LoginSpawner = () => {
      throw new Error("spawn setpriv ENOENT");
    };

    const t2 = setup(undefined, () => Promise.resolve(bobId), spawn2);
    expect((await fail(t2.cloner.loginStart("bob"))).message).toBe("setpriv is not installed");
  });

  test("setup-git throwing gives failed, not an unhandled rejection", async () => {
    const harness = setup(() => {
      throw new Error("runner exploded ABCD-1234");
    });
    const loginStart = harness.cloner.loginStart();
    await tick();
    harness.made[0].emit(CODE + URL_LINE);
    const { id: lid } = await loginStart;
    harness.made[0].exit(0);
    await tick();
    await tick();
    const loginStatus = await harness.cloner.loginStatus(lid);
    expect(loginStatus.state).toBe("failed");
    expect(loginStatus.error).toContain("setup-git");
    expect(loginStatus.error).not.toContain("ABCD-1234");
  });

  test("exit before the code with a non-127 code gives 502", async () => {
    const harness = setup();
    const promise = fail(harness.cloner.loginStart());
    await tick();
    harness.made[0].emit("error connecting to github.com\n");
    harness.made[0].exit(1);
    const httpError = await promise;
    expect(httpError.status).toBe(502);
    expect(httpError.message).toContain("error connecting");
  });

  test("after a 504 the login id is unknown (404)", async () => {
    const harness = setup();
    const promise = fail(harness.cloner.loginStart());
    await tick();
    harness.advance(15_000);
    await promise;
    // The id was never returned to the caller, so nothing can look it up.
    expect(harness.made.length).toBe(1);
    const httpError = await fail(harness.cloner.loginStatus("f".repeat(32)));
    expect(httpError.status).toBe(404);
  });

  test("CRLF-terminated output still parses", async () => {
    const harness = setup();
    const loginStart = harness.cloner.loginStart();
    await tick();
    harness.made[0].emit(CODE.replace("\n", "\r\n") + URL_LINE.replace("\n", "\r\n"));
    const out = await loginStart;
    expect(out.code).toBe("ABCD-1234");
    expect(out.url).toBe("https://github.com/login/device");
  });
});

describe("bunLoginSpawner", () => {
  test("streams stdout and stderr, feeds stdin and reports the exit code", async () => {
    const proc = bunLoginSpawner("sh", ["-c", "echo out1; echo err1 >&2; read x; echo got-$x; exit 0"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdin: "\n",
    });
    let text = "";
    proc.onOutput((chunk) => {
      text += chunk;
    });
    expect(await proc.exited).toBe(0);
    expect(text).toContain("out1");
    expect(text).toContain("err1");
    expect(text).toContain("got-");
  });

  test("kill ends a running process", async () => {
    const proc = bunLoginSpawner("sh", ["-c", "sleep 30"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdin: "",
    });
    proc.kill();
    expect(await proc.exited).not.toBe(0);
  });
});

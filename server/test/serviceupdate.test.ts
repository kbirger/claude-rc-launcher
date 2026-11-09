import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256, type RunResult } from "../src/release";
import {
  createClientVersions,
  createServiceUpdater,
  findClients,
  UpdateRefused,
  watchdogScript,
  type UpdateEnv,
} from "../src/serviceupdate";

const BASE = "https://github.com/kbirger/claude-rc-launcher/releases";
const BIN = "/usr/local/bin/claude-rc-launcher";
const UNIT_PATH = "/etc/systemd/system/claude-rc-launcher.service";
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("findClients", () => {
  const fs = (files: string[], links: Record<string, string> = {}) => ({
    exists: (p: string) => files.includes(p) || p in links,
    realpath: (p: string) => links[p] ?? p,
  });

  test("finds the first copy on PATH, like which", () => {
    const o = fs(["/usr/bin/claude-rc", "/bin/claude-rc"]);
    expect(findClients({ ...o, pathEnv: "/usr/local/bin::/usr/bin:/bin", homes: [] })).toEqual(["/usr/bin/claude-rc"]);
  });

  test("finds a copy in ~/.local/bin of a home", () => {
    const o = fs(["/home/svc/.local/bin/claude-rc"]);
    expect(findClients({ ...o, pathEnv: "/usr/bin", homes: ["/home/svc", "/root"] })).toEqual(["/home/svc/.local/bin/claude-rc"]);
  });

  test("no copy is an empty list", () => {
    expect(findClients({ ...fs([]), pathEnv: "/usr/bin:/bin", homes: ["/home/svc", "/root"] })).toEqual([]);
  });

  test("two different copies are both returned", () => {
    const o = fs(["/usr/local/bin/claude-rc", "/root/.local/bin/claude-rc"]);
    expect(findClients({ ...o, pathEnv: "/usr/local/bin", homes: ["/home/svc", "/root"] })).toEqual([
      "/usr/local/bin/claude-rc",
      "/root/.local/bin/claude-rc",
    ]);
  });

  test("a symlink pair gives one entry, the real file", () => {
    const o = fs(["/usr/local/bin/claude-rc"], { "/usr/bin/claude-rc": "/usr/local/bin/claude-rc", "/root/.local/bin/claude-rc": "/usr/local/bin/claude-rc" });
    expect(findClients({ ...o, pathEnv: "/usr/bin", homes: ["/root"] })).toEqual(["/usr/local/bin/claude-rc"]);
  });

  test("a home on PATH is not counted twice", () => {
    const o = fs(["/home/svc/.local/bin/claude-rc"]);
    expect(findClients({ ...o, pathEnv: "/home/svc/.local/bin:/usr/bin", homes: ["/home/svc", "/root"] })).toEqual([
      "/home/svc/.local/bin/claude-rc",
    ]);
  });
});

/** A machine in memory. Binaries are text: "service <v>", "client <v>" or "broken". */
function fakeMachine(o: {
  service?: string;
  clients?: Record<string, string>;
  links?: Record<string, string>;
  release?: { service: string; client: string };
  overrides?: Partial<UpdateEnv>;
} = {}) {
  const files = new Map<string, Uint8Array>();
  files.set(BIN, enc(o.service ?? "service 1.0.0"));
  files.set(UNIT_PATH, enc("[Unit]"));
  for (const [p, c] of Object.entries(o.clients ?? {})) files.set(p, enc(c));
  const links = o.links ?? {};
  const rel = o.release ?? { service: "service 2.0.0", client: "client 2.0.0" };
  const assets: Record<string, Uint8Array> = {
    "claude-rc-launcher-linux-x64": enc(rel.service),
    "claude-rc-linux-x64": enc(rel.client),
  };
  const sums = Object.entries(assets)
    .map(([n, d]) => `${sha256(d)}  ${n}`)
    .join("\n");
  const requested: string[] = [];
  const calls: string[][] = [];
  const scripts: string[] = [];
  const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
  const fail = (stderr: string): RunResult => ({ code: 1, stdout: "", stderr });
  const env: UpdateEnv = {
    platform: "linux",
    arch: "x64",
    execPath: BIN,
    version: "1.0.0",
    scope: "system",
    pathEnv: "/usr/local/bin:/usr/bin:/bin",
    homes: ["/home/svc", "/root"],
    exists: (p) => files.has(p) || (p in links && files.has(links[p]!)),
    readFile: (p) => {
      const f = files.get(links[p] ?? p);
      if (!f) throw new Error(`ENOENT ${p}`);
      return f;
    },
    realpath: (p) => links[p] ?? p,
    fetch: (async (url: string | URL | Request) => {
      const u = String(url);
      requested.push(u);
      const name = u.split("/").pop()!;
      if (name === "SHA256SUMS") return new Response(sums);
      const a = assets[name];
      return a ? new Response(a as Uint8Array<ArrayBuffer>) : new Response("missing", { status: 404 });
    }) as unknown as typeof fetch,
    run(args) {
      calls.push(args);
      const [cmd, ...rest] = args;
      if (cmd === "install") {
        files.set(rest[3]!, files.get(rest[2]!)!);
        return ok();
      }
      if (cmd === "cp") {
        if (!files.has(rest[1]!)) return fail("no such file");
        files.set(rest[2]!, files.get(rest[1]!)!);
        return ok();
      }
      if (cmd === "mv") {
        if (!files.has(rest[1]!)) return fail("no such file");
        files.set(rest[2]!, files.get(rest[1]!)!);
        files.delete(rest[1]!);
        return ok();
      }
      if (cmd === "rm") {
        files.delete(rest[1]!);
        return ok();
      }
      if (rest[0] === "--version") {
        const c = files.get(cmd!);
        if (!c) return fail("not found");
        const [kind, v] = dec(c).split(" ");
        if (kind === "client") return ok(`claude-rc ${v}\n`);
        if (kind === "service") return ok(`claude-rc-launcher ${v}\n`);
        return { code: 139, stdout: "", stderr: "segfault" };
      }
      return fail(`unexpected ${args.join(" ")}`);
    },
    writeTemp(name, data) {
      const p = `/tmp/fake/${name}-${calls.length}`;
      files.set(p, data);
      return p;
    },
    removeTemp(p) {
      files.delete(p);
    },
    startWatchdog(script) {
      scripts.push(script);
    },
    ...o.overrides,
  };
  const text = (p: string) => (files.has(p) ? dec(files.get(p)!) : undefined);
  return { env, files, text, requested, calls, scripts };
}

async function refused(p: Promise<unknown>): Promise<UpdateRefused> {
  try {
    await p;
  } catch (e) {
    if (e instanceof UpdateRefused) return e;
    throw e;
  }
  throw new Error("expected UpdateRefused");
}

describe("createServiceUpdater refusals", () => {
  const cases: [string, Partial<UpdateEnv>][] = [
    ["execPath is not the installed binary", { execPath: "/home/me/src/server/src/index.ts" }],
    ["scope is user", { scope: "user" }],
    ["platform is not linux", { platform: "darwin" }],
  ];
  for (const [name, overrides] of cases) {
    test(`409 when ${name}, before any download`, async () => {
      const m = fakeMachine({ overrides });
      const e = await refused(createServiceUpdater(m.env).run());
      expect(e.status).toBe(409);
      expect(m.requested).toEqual([]);
      expect(m.text(BIN)).toBe("service 1.0.0");
    });
  }

  test("409 when the unit file is missing", async () => {
    const m = fakeMachine();
    m.files.delete(UNIT_PATH);
    const e = await refused(createServiceUpdater(m.env).run());
    expect(e.status).toBe(409);
    expect(e.message).toContain(UNIT_PATH);
    expect(m.requested).toEqual([]);
  });

  for (const bad of ["latest", "v1.0.0/../../x", "v1.2", "v1.2.3\n", ""]) {
    test(`400 for release ${JSON.stringify(bad)} before any download`, async () => {
      const m = fakeMachine();
      const e = await refused(createServiceUpdater(m.env).run(bad));
      expect(e.status).toBe(400);
      expect(m.requested).toEqual([]);
      expect(m.calls).toEqual([]);
    });
  }
});

describe("createServiceUpdater run", () => {
  test("a new service binary: clients first, then the service, then the watchdog", async () => {
    const m = fakeMachine({ clients: { "/usr/local/bin/claude-rc": "client 1.0.0" } });
    const r = await createServiceUpdater(m.env).run("v2.0.0");
    expect(r).toEqual({
      status: "restarting",
      from: "1.0.0",
      to: "2.0.0",
      clients: [{ path: "/usr/local/bin/claude-rc", status: "updated", from: "1.0.0", to: "2.0.0" }],
    });
    expect(m.requested.every((u) => u.startsWith(`${BASE}/download/v2.0.0/`))).toBe(true);
    expect(m.text(BIN)).toBe("service 2.0.0");
    expect(m.text(`${BIN}.prev`)).toBe("service 1.0.0");
    expect(m.text("/usr/local/bin/claude-rc")).toBe("client 2.0.0");
    expect(m.text("/usr/local/bin/claude-rc.prev")).toBe("client 1.0.0");
    // The client is replaced before the service.
    const mvs = m.calls.filter((c) => c[0] === "mv").map((c) => c[3]);
    expect(mvs).toEqual(["/usr/local/bin/claude-rc", BIN]);
    expect(m.scripts).toHaveLength(1);
    expect(m.scripts[0]).toBe(watchdogScript({ bin: BIN, unit: "claude-rc-launcher", waitSeconds: 30 }));
  });

  test("no release means the latest release", async () => {
    const m = fakeMachine();
    await createServiceUpdater(m.env).run();
    expect(m.requested.length).toBeGreaterThan(0);
    expect(m.requested.every((u) => u.startsWith(`${BASE}/latest/download/`))).toBe(true);
  });

  test("the service is current and a client is old: clients-only, no watchdog", async () => {
    const m = fakeMachine({
      service: "service 2.0.0",
      clients: { "/usr/local/bin/claude-rc": "client 1.0.0" },
      overrides: { version: "2.0.0" },
    });
    const r = await createServiceUpdater(m.env).run();
    expect(r.status).toBe("clients-only");
    expect(r.from).toBe("2.0.0");
    expect(r.clients).toEqual([{ path: "/usr/local/bin/claude-rc", status: "updated", from: "1.0.0", to: "2.0.0" }]);
    expect(m.scripts).toEqual([]);
    expect(m.files.has(`${BIN}.prev`)).toBe(false);
  });

  test("everything current: up-to-date, nothing replaced", async () => {
    const m = fakeMachine({
      service: "service 2.0.0",
      clients: { "/usr/local/bin/claude-rc": "client 2.0.0" },
      overrides: { version: "2.0.0" },
    });
    const r = await createServiceUpdater(m.env).run();
    expect(r).toEqual({ status: "up-to-date", from: "2.0.0", clients: [{ path: "/usr/local/bin/claude-rc", status: "up-to-date" }] });
    expect(m.scripts).toEqual([]);
    expect(m.calls.filter((c) => ["install", "cp", "mv"].includes(c[0]!))).toEqual([]);
  });

  test("no client copy: the report has an empty list and the client asset is not downloaded", async () => {
    const m = fakeMachine();
    const r = await createServiceUpdater(m.env).run();
    expect(r.status).toBe("restarting");
    expect(r.clients).toEqual([]);
    expect(m.requested.some((u) => u.endsWith("/claude-rc-linux-x64"))).toBe(false);
  });

  test("a symlink pair is updated once, through the real file", async () => {
    const m = fakeMachine({
      clients: { "/usr/local/bin/claude-rc": "client 1.0.0" },
      links: { "/usr/bin/claude-rc": "/usr/local/bin/claude-rc", "/root/.local/bin/claude-rc": "/usr/local/bin/claude-rc" },
      overrides: { pathEnv: "/usr/bin:/bin" },
    });
    const r = await createServiceUpdater(m.env).run();
    expect(r.clients.map((c) => c.path)).toEqual(["/usr/local/bin/claude-rc"]);
    expect(m.calls.filter((c) => c[0] === "install" && c[4] === "/usr/local/bin/claude-rc.new")).toHaveLength(1);
  });

  test("a client whose new file does not run is restored and failed, and the service is still updated", async () => {
    const m = fakeMachine({
      clients: { "/usr/local/bin/claude-rc": "client 1.0.0" },
      release: { service: "service 2.0.0", client: "broken" },
    });
    const r = await createServiceUpdater(m.env).run();
    expect(r.status).toBe("restarting");
    expect(r.clients).toHaveLength(1);
    expect(r.clients[0]!.status).toBe("failed");
    expect(r.clients[0]!.error).toContain("--version");
    expect(m.text("/usr/local/bin/claude-rc")).toBe("client 1.0.0");
    expect(m.text(BIN)).toBe("service 2.0.0");
    expect(m.scripts).toHaveLength(1);
  });

  test("the service is current and a client fails: failed, no watchdog", async () => {
    const m = fakeMachine({
      service: "service 2.0.0",
      clients: { "/usr/local/bin/claude-rc": "client 1.0.0" },
      release: { service: "service 2.0.0", client: "broken" },
      overrides: { version: "2.0.0" },
    });
    const r = await createServiceUpdater(m.env).run();
    expect(r.status).toBe("failed");
    expect(r.error).toContain("/usr/local/bin/claude-rc");
    expect(m.scripts).toEqual([]);
  });

  test("a checksum mismatch installs nothing and fails", async () => {
    const m = fakeMachine();
    const realFetch = m.env.fetch;
    m.env.fetch = (async (url: string | URL | Request) =>
      String(url).endsWith("SHA256SUMS") ? new Response(`${"0".repeat(64)}  claude-rc-launcher-linux-x64`) : realFetch(url)) as typeof fetch;
    const r = await createServiceUpdater(m.env).run();
    expect(r.status).toBe("failed");
    expect(r.error).toContain("checksum");
    expect(m.text(BIN)).toBe("service 1.0.0");
    expect(m.scripts).toEqual([]);
  });

  test("a new service binary that does not run is restored and nothing restarts", async () => {
    const m = fakeMachine({ release: { service: "broken", client: "client 2.0.0" } });
    const r = await createServiceUpdater(m.env).run();
    expect(r.status).toBe("failed");
    expect(m.text(BIN)).toBe("service 1.0.0");
    expect(m.scripts).toEqual([]);
  });

  test("a watchdog that cannot start restores the service binary", async () => {
    const m = fakeMachine({
      overrides: {
        startWatchdog: () => {
          throw new Error("systemd-run failed");
        },
      },
    });
    const r = await createServiceUpdater(m.env).run();
    expect(r.status).toBe("failed");
    expect(r.error).toContain("systemd-run failed");
    expect(m.text(BIN)).toBe("service 1.0.0");
  });
});

describe("createServiceUpdater lock", () => {
  test("a second run during the first gets 409", async () => {
    const m = fakeMachine();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const realFetch = m.env.fetch;
    m.env.fetch = (async (url: string | URL | Request) => {
      await gate;
      return realFetch(url);
    }) as typeof fetch;
    const u = createServiceUpdater(m.env);
    const first = u.run();
    const e = await refused(u.run());
    expect(e.status).toBe(409);
    release();
    expect((await first).status).toBe("restarting");
  });

  test("a run after a failed run works", async () => {
    const m = fakeMachine();
    const realFetch = m.env.fetch;
    let down = true;
    m.env.fetch = (async (url: string | URL | Request) => (down ? new Response("x", { status: 503 }) : realFetch(url))) as typeof fetch;
    const u = createServiceUpdater(m.env);
    expect((await u.run()).status).toBe("failed");
    down = false;
    expect((await u.run()).status).toBe("restarting");
  });

  test("a run after a refused run works", async () => {
    const m = fakeMachine();
    const u = createServiceUpdater(m.env);
    expect((await refused(u.run("latest"))).status).toBe(400);
    expect((await u.run()).status).toBe("restarting");
  });

  test("after restarting, the lock stays held until the service restarts", async () => {
    const m = fakeMachine();
    const u = createServiceUpdater(m.env);
    expect((await u.run()).status).toBe("restarting");
    expect((await refused(u.run())).status).toBe(409);
  });
});

describe("watchdogScript in a real shell", () => {
  function sandbox(mode: "never-active" | "active" | "restart-fails") {
    const dir = mkdtempSync(path.join(tmpdir(), "crl-watchdog-"));
    const bin = path.join(dir, "claude-rc-launcher");
    writeFileSync(bin, "new");
    writeFileSync(`${bin}.prev`, "old");
    const log = path.join(dir, "systemctl.log");
    const fake = path.join(dir, "fakebin");
    mkdirSync(fake);
    writeFileSync(
      path.join(fake, "systemctl"),
      `#!/bin/sh\necho "$*" >> '${log}'\ncase "$1" in is-active) ${mode === "active" ? "exit 0" : "exit 3"} ;; restart) ${mode === "restart-fails" ? "exit 1" : "exit 0"} ;; esac\nexit 0\n`,
    );
    chmodSync(path.join(fake, "systemctl"), 0o755);
    const run = () =>
      Bun.spawnSync(["sh", "-c", watchdogScript({ bin, unit: "claude-rc-launcher", waitSeconds: 2 })], {
        env: { PATH: `${fake}:${process.env.PATH}` },
      });
    const restarts = () => readFileSync(log, "utf8").split("\n").filter((l) => l === "restart claude-rc-launcher").length;
    return { dir, bin, run, restarts, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  test(
    "a service that never stays active gets the .prev binary back and a second restart",
    () => {
      const s = sandbox("never-active");
      try {
        const r = s.run();
        expect(r.exitCode).not.toBe(0);
        expect(readFileSync(s.bin, "utf8")).toBe("old");
        expect(existsSync(`${s.bin}.prev`)).toBe(false);
        expect(s.restarts()).toBe(2);
      } finally {
        s.cleanup();
      }
    },
    30_000,
  );

  test(
    "a first restart that fails puts the .prev binary back at once",
    () => {
      const s = sandbox("restart-fails");
      try {
        const r = s.run();
        expect(r.exitCode).not.toBe(0);
        expect(readFileSync(s.bin, "utf8")).toBe("old");
        expect(existsSync(`${s.bin}.prev`)).toBe(false);
      } finally {
        s.cleanup();
      }
    },
    30_000,
  );

  test(
    "a service that stays active keeps the new binary",
    () => {
      const s = sandbox("active");
      try {
        const r = s.run();
        expect(r.exitCode).toBe(0);
        expect(readFileSync(s.bin, "utf8")).toBe("new");
        expect(readFileSync(`${s.bin}.prev`, "utf8")).toBe("old");
        expect(s.restarts()).toBe(1);
      } finally {
        s.cleanup();
      }
    },
    30_000,
  );

  test("values are quoted for the shell", () => {
    const s = watchdogScript({ bin: "/tmp/a b'c", unit: "u", waitSeconds: 30 });
    expect(s).toContain(`'/tmp/a b'\\''c'`);
  });
});

describe("createClientVersions", () => {
  const make = (answers: Record<string, string | null>) => {
    const calls: string[][] = [];
    const env = {
      pathEnv: "/usr/local/bin",
      homes: ["/root"],
      exists: (p: string) => p in answers,
      realpath: (p: string) => p,
      run: (args: string[]) => {
        calls.push(args);
        const a = answers[args[0]!];
        return a === null || a === undefined ? { code: 1, stdout: "", stderr: "boom" } : { code: 0, stdout: a, stderr: "" };
      },
    } as unknown as UpdateEnv;
    return { env, calls };
  };
  const A = "/usr/local/bin/claude-rc";
  const B = "/root/.local/bin/claude-rc";

  test("one copy gives its version", async () => {
    expect(await createClientVersions(make({ [A]: "claude-rc 0.8.2\n" }).env)()).toEqual([{ path: A, version: "0.8.2" }]);
  });
  test("a copy that exits 1 has no version", async () => {
    expect(await createClientVersions(make({ [A]: null }).env)()).toEqual([{ path: A }]);
  });
  test("two copies give two entries", async () => {
    expect(await createClientVersions(make({ [A]: "claude-rc 0.8.2\n", [B]: "claude-rc 0.8.0\n" }).env)()).toEqual([
      { path: A, version: "0.8.2" },
      { path: B, version: "0.8.0" },
    ]);
  });
  test("no copy gives an empty list", async () => {
    expect(await createClientVersions(make({}).env)()).toEqual([]);
  });
  test("a second call within the ttl runs no command, and one after it does", async () => {
    const { env, calls } = make({ [A]: "claude-rc 0.8.2\n" });
    let t = 1_000;
    const get = createClientVersions(env, { now: () => t });
    await get();
    expect(calls.length).toBe(1);
    t += 59_000;
    await get();
    expect(calls.length).toBe(1);
    t += 2_000;
    await get();
    expect(calls.length).toBe(2);
  });
  test("runAsync is used when present, with a short timeout, and concurrent callers share one lookup", async () => {
    const seen: { args: string[]; timeoutMs?: number }[] = [];
    let release!: (r: { code: number; stdout: string; stderr: string }) => void;
    const env = {
      pathEnv: "/usr/local/bin",
      homes: [],
      exists: (p: string) => p === A,
      realpath: (p: string) => p,
      run: () => {
        throw new Error("sync run must not be used");
      },
      runAsync: (args: string[], opts?: { timeoutMs?: number }) => {
        seen.push({ args, ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
        return new Promise((res) => (release = res));
      },
    } as unknown as UpdateEnv;
    const get = createClientVersions(env);
    const p1 = get();
    const p2 = get();
    await Bun.sleep(0);
    release({ code: 0, stdout: "claude-rc 1.0.0\n", stderr: "" });
    expect(await p1).toEqual([{ path: A, version: "1.0.0" }]);
    expect(await p2).toEqual([{ path: A, version: "1.0.0" }]);
    expect(seen).toEqual([{ args: [A, "--version"], timeoutMs: 2_000 }]);
  });
  test("reset makes the next call ask again", async () => {
    const { env, calls } = make({ [A]: "claude-rc 0.8.2\n" });
    const get = createClientVersions(env, { now: () => 1_000 });
    await get();
    get.reset();
    await get();
    expect(calls.length).toBe(2);
  });
  test("a lookup in flight during reset does not store its old answer", async () => {
    let answer = "claude-rc 0.8.2\n";
    let release!: (r: { code: number; stdout: string; stderr: string }) => void;
    let calls = 0;
    const env = {
      pathEnv: "/usr/local/bin",
      homes: [],
      exists: (p: string) => p === A,
      realpath: (p: string) => p,
      run: () => ({ code: 0, stdout: answer, stderr: "" }),
      runAsync: () => {
        calls++;
        return calls === 1 ? new Promise((res) => (release = res)) : Promise.resolve({ code: 0, stdout: answer, stderr: "" });
      },
    } as unknown as UpdateEnv;
    const get = createClientVersions(env, { now: () => 1_000 });
    const old = get();
    await Bun.sleep(0);
    get.reset();
    answer = "claude-rc 0.8.3\n";
    release({ code: 0, stdout: "claude-rc 0.8.2\n", stderr: "" });
    expect(await old).toEqual([{ path: A, version: "0.8.2" }]);
    expect(await get()).toEqual([{ path: A, version: "0.8.3" }]);
    expect(calls).toBe(2);
  });
  test("a lookup that throws rejects once and does not stick", async () => {
    let n = 0;
    const env = {
      pathEnv: "/usr/local/bin",
      homes: [],
      exists: (p: string) => {
        if (n++ === 0) throw new Error("fs broke");
        return p === A;
      },
      realpath: (p: string) => p,
      run: () => ({ code: 0, stdout: "claude-rc 1.0.0\n", stderr: "" }),
    } as unknown as UpdateEnv;
    const get = createClientVersions(env);
    await expect(get()).rejects.toThrow("fs broke");
    expect(await get()).toEqual([{ path: A, version: "1.0.0" }]);
  });
});

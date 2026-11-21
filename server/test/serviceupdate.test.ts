import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256 } from "../src/release";
import type { RunResult } from "../src/release";
import {
  createClientVersions,
  createServiceUpdater,
  findClients,
  UpdateRefused,
  watchdogScript,
} from "../src/serviceupdate";
import type { UpdateEnv } from "../src/serviceupdate";
import { rejection, defined } from "./support";

const BASE = "https://github.com/kbirger/claude-rc-launcher/releases";
const BIN = "/usr/local/bin/claude-rc-launcher";
const UNIT_PATH = "/etc/systemd/system/claude-rc-launcher.service";
const enc = (item: string) => new TextEncoder().encode(item);
const dec = (uint8Array: Uint8Array) => new TextDecoder().decode(uint8Array);

describe("findClients", () => {
  const fs = (files: string[], links: Record<string, string> = {}) => ({
    exists: (file: string) => files.includes(file) || file in links,
    realpath: (file: string) => links[file] ?? file,
  });

  test("a registered symlink gives the real path, once", () => {
    const sys = fs(["/usr/bin/claude-rc"], { "/opt/link/claude-rc": "/usr/bin/claude-rc" });
    expect(findClients({ ...sys, pathEnv: "/usr/bin", homes: [], registered: ["/opt/link/claude-rc"] })).toEqual([
      "/usr/bin/claude-rc",
    ]);
  });
  test("an entry that trustedClient refuses is dropped, but the scan still finds the same file", () => {
    const sys = fs(["/opt/a/claude-rc", "/usr/bin/claude-rc"]);
    const seen: string[] = [];

    const trustedClient = (entry: string) => {
      seen.push(entry);
      return false;
    };

    expect(
      findClients({
        ...sys,
        pathEnv: "/usr/bin",
        homes: [],
        registered: ["/opt/a/claude-rc", "/usr/bin/claude-rc"],
        trustedClient,
      }),
    ).toEqual(["/usr/bin/claude-rc"]);
    expect(seen).toEqual(["/opt/a/claude-rc", "/usr/bin/claude-rc"]);
  });
  test("an empty registry falls back to the scan", () => {
    const sys = fs(["/usr/bin/claude-rc"]);
    expect(findClients({ ...sys, pathEnv: "/usr/bin", homes: [], registered: [] })).toEqual(["/usr/bin/claude-rc"]);
  });
  test("Windows: a quoted PATH segment is unquoted", () => {
    const item = "C:\\Program Files\\x\\claude-rc.exe";
    expect(
      findClients({ ...fs([item]), platform: "win32", pathEnv: 'C:\\Windows; "C:\\Program Files\\x" ', homes: [] }),
    ).toEqual([item]);
  });
  test("registered paths come first, then scanned ones, each real file once", () => {
    const sys = fs(["/opt/a/claude-rc", "/usr/bin/claude-rc", "/root/.local/bin/claude-rc"]);
    expect(
      findClients({
        ...sys,
        pathEnv: "/usr/bin",
        homes: ["/root"],
        registered: ["/opt/a/claude-rc", "/usr/bin/claude-rc", "/gone/claude-rc"],
      }),
    ).toEqual(["/opt/a/claude-rc", "/usr/bin/claude-rc", "/root/.local/bin/claude-rc"]);
  });
  test("Windows: PATH is split on ; and claude-rc.exe is looked up in each directory", () => {
    const sys = fs(["C:\\tools\\claude-rc.exe"]);
    expect(findClients({ ...sys, platform: "win32", pathEnv: "C:\\Windows;C:\\tools", homes: ["/root"] })).toEqual([
      "C:\\tools\\claude-rc.exe",
    ]);
  });
  test("Windows: Program Files is searched without a PATH entry", () => {
    const item = "C:\\Program Files\\claude-rc\\claude-rc.exe";
    expect(
      findClients({ ...fs([item]), platform: "win32", pathEnv: "", homes: [], programFiles: "C:\\Program Files" }),
    ).toEqual([item]);
  });
  test("Windows: both Program Files defaults are found without a PATH entry, each real file once", () => {
    const item = "C:\\Program Files\\claude-rc\\bin\\claude-rc.exe";
    const entry = "C:\\Program Files\\claude-rc\\claude-rc.exe";
    const base = { platform: "win32", pathEnv: "", homes: [], programFiles: "C:\\Program Files" };
    expect(findClients({ ...fs([item]), ...base })).toEqual([item]);
    expect(findClients({ ...fs([entry]), ...base })).toEqual([entry]);
    expect(findClients({ ...fs([item, entry]), ...base })).toEqual([item, entry]);
    expect(findClients({ ...fs([item, entry]), ...base, registered: [item] })).toEqual([item, entry]);
  });
  test("Windows: registered paths are deduplicated without regard to case", () => {
    const item = "C:\\Program Files\\claude-rc\\claude-rc.exe";
    const entry = {
      exists: (file: string) => file.toLowerCase() === item.toLowerCase(),
      realpath: (file: string) => file,
    };
    expect(
      findClients({
        ...entry,
        platform: "win32",
        pathEnv: "",
        homes: [],
        programFiles: "C:\\Program Files",
        registered: ["c:\\program files\\claude-rc\\CLAUDE-RC.exe"],
      }),
    ).toEqual(["c:\\program files\\claude-rc\\CLAUDE-RC.exe"]);
  });
  test("finds the first copy on PATH, like which", () => {
    const sys = fs(["/usr/bin/claude-rc", "/bin/claude-rc"]);
    expect(findClients({ ...sys, pathEnv: "/usr/local/bin::/usr/bin:/bin", homes: [] })).toEqual([
      "/usr/bin/claude-rc",
    ]);
  });

  test("finds a copy in ~/.local/bin of a home", () => {
    const sys = fs(["/home/svc/.local/bin/claude-rc"]);
    expect(findClients({ ...sys, pathEnv: "/usr/bin", homes: ["/home/svc", "/root"] })).toEqual([
      "/home/svc/.local/bin/claude-rc",
    ]);
  });

  test("no copy is an empty list", () => {
    expect(findClients({ ...fs([]), pathEnv: "/usr/bin:/bin", homes: ["/home/svc", "/root"] })).toEqual([]);
  });

  test("two different copies are both returned", () => {
    const sys = fs(["/usr/local/bin/claude-rc", "/root/.local/bin/claude-rc"]);
    expect(findClients({ ...sys, pathEnv: "/usr/local/bin", homes: ["/home/svc", "/root"] })).toEqual([
      "/usr/local/bin/claude-rc",
      "/root/.local/bin/claude-rc",
    ]);
  });

  test("a symlink pair gives one entry, the real file", () => {
    const sys = fs(["/usr/local/bin/claude-rc"], {
      "/usr/bin/claude-rc": "/usr/local/bin/claude-rc",
      "/root/.local/bin/claude-rc": "/usr/local/bin/claude-rc",
    });
    expect(findClients({ ...sys, pathEnv: "/usr/bin", homes: ["/root"] })).toEqual(["/usr/local/bin/claude-rc"]);
  });

  test("a home on PATH is not counted twice", () => {
    const sys = fs(["/home/svc/.local/bin/claude-rc"]);
    expect(findClients({ ...sys, pathEnv: "/home/svc/.local/bin:/usr/bin", homes: ["/home/svc", "/root"] })).toEqual([
      "/home/svc/.local/bin/claude-rc",
    ]);
  });
});

/** A machine in memory. Binaries are text: "service <v>", "client <v>" or "broken". */
function fakeMachine(
  options: {
    service?: string;
    clients?: Record<string, string>;
    links?: Record<string, string>;
    release?: { service: string; client: string };
    overrides?: Partial<UpdateEnv>;
  } = {},
) {
  const files = new Map<string, Uint8Array>();
  files.set(BIN, enc(options.service ?? "service 1.0.0"));
  files.set(UNIT_PATH, enc("[Unit]"));
  for (const [entry, value] of Object.entries(options.clients ?? {})) files.set(entry, enc(value));
  const links = options.links ?? {};
  const rel = options.release ?? { service: "service 2.0.0", client: "client 2.0.0" };
  const assets: Record<string, Uint8Array> = {
    "claude-rc-launcher-linux-x64": enc(rel.service),
    "claude-rc-linux-x64": enc(rel.client),
  };
  const sums = Object.entries(assets)
    .map(([count, uint8Array]) => `${sha256(uint8Array)}  ${count}`)
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
    exists: (file) => files.has(file) || (file in links && files.has(links[file])),
    readFile: (file) => {
      const response = files.get(links[file] ?? file);
      if (!response) throw new Error(`ENOENT ${file}`);
      return response;
    },
    realpath: (file) => links[file] ?? file,
    fetch: ((url: string | URL | Request) => {
      const entry = String(url);
      requested.push(entry);
      const name = defined(entry.split("/").pop());
      if (name === "SHA256SUMS") return Promise.resolve(new Response(sums));
      const uint8Array = assets[name];
      return Promise.resolve(
        uint8Array ? new Response(uint8Array as Uint8Array<ArrayBuffer>) : new Response("missing", { status: 404 }),
      );
    }) as unknown as typeof fetch,
    run(args) {
      calls.push(args);
      const [cmd, ...rest] = args;

      if (cmd === "install") {
        files.set(rest[3], defined(files.get(rest[2])));
        return ok();
      }

      if (cmd === "cp") {
        if (!files.has(rest[1])) return fail("no such file");
        files.set(rest[2], defined(files.get(rest[1])));
        return ok();
      }

      if (cmd === "mv") {
        if (!files.has(rest[1])) return fail("no such file");
        files.set(rest[2], defined(files.get(rest[1])));
        files.delete(rest[1]);
        return ok();
      }

      if (cmd === "rm") {
        files.delete(rest[1]);
        return ok();
      }

      if (rest[0] === "--version") {
        const response = files.get(cmd);
        if (!response) return fail("not found");
        const [kind, value] = dec(response).split(" ");
        if (kind === "client") return ok(`claude-rc ${value}\n`);
        if (kind === "service") return ok(`claude-rc-launcher ${value}\n`);
        return { code: 139, stdout: "", stderr: "segfault" };
      }

      return fail(`unexpected ${args.join(" ")}`);
    },
    writeTemp(name, data) {
      const entry = `/tmp/fake/${name}-${calls.length}`;
      files.set(entry, data);
      return entry;
    },
    removeTemp(file) {
      files.delete(file);
    },
    startWatchdog(script) {
      scripts.push(script);
    },
    ...options.overrides,
  };
  const text = (entry: string) => (files.has(entry) ? dec(defined(files.get(entry))) : undefined);
  return { env, files, text, requested, calls, scripts };
}

async function refused(promise: Promise<unknown>): Promise<UpdateRefused> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UpdateRefused) return error;
    throw error;
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
      const machine = fakeMachine({ overrides });
      const updateRefused = await refused(createServiceUpdater(machine.env).run());
      expect(updateRefused.status).toBe(409);
      expect(machine.requested).toEqual([]);
      expect(machine.text(BIN)).toBe("service 1.0.0");
    });
  }

  test("409 when the unit file is missing", async () => {
    const machine = fakeMachine();
    machine.files.delete(UNIT_PATH);
    const updateRefused = await refused(createServiceUpdater(machine.env).run());
    expect(updateRefused.status).toBe(409);
    expect(updateRefused.message).toContain(UNIT_PATH);
    expect(machine.requested).toEqual([]);
  });

  for (const bad of ["latest", "v1.0.0/../../x", "v1.2", "v1.2.3\n", ""]) {
    test(`400 for release ${JSON.stringify(bad)} before any download`, async () => {
      const machine = fakeMachine();
      const updateRefused = await refused(createServiceUpdater(machine.env).run(bad));
      expect(updateRefused.status).toBe(400);
      expect(machine.requested).toEqual([]);
      expect(machine.calls).toEqual([]);
    });
  }
});

describe("createServiceUpdater run", () => {
  test("a new service binary: clients first, then the service, then the watchdog", async () => {
    const machine = fakeMachine({ clients: { "/usr/local/bin/claude-rc": "client 1.0.0" } });
    const updateReport = await createServiceUpdater(machine.env).run("v2.0.0");
    expect(updateReport).toEqual({
      status: "restarting",
      from: "1.0.0",
      to: "2.0.0",
      clients: [{ path: "/usr/local/bin/claude-rc", status: "updated", from: "1.0.0", to: "2.0.0" }],
    });
    expect(machine.requested.every((item) => item.startsWith(`${BASE}/download/v2.0.0/`))).toBe(true);
    expect(machine.text(BIN)).toBe("service 2.0.0");
    expect(machine.text(`${BIN}.prev`)).toBe("service 1.0.0");
    expect(machine.text("/usr/local/bin/claude-rc")).toBe("client 2.0.0");
    expect(machine.text("/usr/local/bin/claude-rc.prev")).toBe("client 1.0.0");
    // The client is replaced before the service.
    const mvs = machine.calls.filter((call) => call[0] === "mv").map((call) => call[3]);
    expect(mvs).toEqual(["/usr/local/bin/claude-rc", BIN]);
    expect(machine.scripts).toHaveLength(1);
    expect(machine.scripts[0]).toBe(watchdogScript({ bin: BIN, unit: "claude-rc-launcher", waitSeconds: 30 }));
  });

  test("no release means the latest release", async () => {
    const machine = fakeMachine();
    await createServiceUpdater(machine.env).run();
    expect(machine.requested.length).toBeGreaterThan(0);
    expect(machine.requested.every((item) => item.startsWith(`${BASE}/latest/download/`))).toBe(true);
  });

  test("the service is current and a client is old: clients-only, no watchdog", async () => {
    const machine = fakeMachine({
      service: "service 2.0.0",
      clients: { "/usr/local/bin/claude-rc": "client 1.0.0" },
      overrides: { version: "2.0.0" },
    });
    const updateReport = await createServiceUpdater(machine.env).run();
    expect(updateReport.status).toBe("clients-only");
    expect(updateReport.from).toBe("2.0.0");
    expect(updateReport.clients).toEqual([
      { path: "/usr/local/bin/claude-rc", status: "updated", from: "1.0.0", to: "2.0.0" },
    ]);
    expect(machine.scripts).toEqual([]);
    expect(machine.files.has(`${BIN}.prev`)).toBe(false);
  });

  test("everything current: up-to-date, nothing replaced", async () => {
    const machine = fakeMachine({
      service: "service 2.0.0",
      clients: { "/usr/local/bin/claude-rc": "client 2.0.0" },
      overrides: { version: "2.0.0" },
    });
    const updateReport = await createServiceUpdater(machine.env).run();
    expect(updateReport).toEqual({
      status: "up-to-date",
      from: "2.0.0",
      clients: [{ path: "/usr/local/bin/claude-rc", status: "up-to-date" }],
    });
    expect(machine.scripts).toEqual([]);
    expect(machine.calls.filter((call) => ["install", "cp", "mv"].includes(call[0]))).toEqual([]);
  });

  test("no client copy: the report has an empty list and the client asset is not downloaded", async () => {
    const machine = fakeMachine();
    const updateReport = await createServiceUpdater(machine.env).run();
    expect(updateReport.status).toBe("restarting");
    expect(updateReport.clients).toEqual([]);
    expect(machine.requested.some((item) => item.endsWith("/claude-rc-linux-x64"))).toBe(false);
  });

  test("a symlink pair is updated once, through the real file", async () => {
    const machine = fakeMachine({
      clients: { "/usr/local/bin/claude-rc": "client 1.0.0" },
      links: {
        "/usr/bin/claude-rc": "/usr/local/bin/claude-rc",
        "/root/.local/bin/claude-rc": "/usr/local/bin/claude-rc",
      },
      overrides: { pathEnv: "/usr/bin:/bin" },
    });
    const updateReport = await createServiceUpdater(machine.env).run();
    expect(updateReport.clients.map((clientResult) => clientResult.path)).toEqual(["/usr/local/bin/claude-rc"]);
    expect(
      machine.calls.filter((call) => call[0] === "install" && call[4] === "/usr/local/bin/claude-rc.new"),
    ).toHaveLength(1);
  });

  test("a client whose new file does not run is restored and failed, and the service is still updated", async () => {
    const machine = fakeMachine({
      clients: { "/usr/local/bin/claude-rc": "client 1.0.0" },
      release: { service: "service 2.0.0", client: "broken" },
    });
    const updateReport = await createServiceUpdater(machine.env).run();
    expect(updateReport.status).toBe("restarting");
    expect(updateReport.clients).toHaveLength(1);
    expect(updateReport.clients[0].status).toBe("failed");
    expect(updateReport.clients[0].error).toContain("--version");
    expect(machine.text("/usr/local/bin/claude-rc")).toBe("client 1.0.0");
    expect(machine.text(BIN)).toBe("service 2.0.0");
    expect(machine.scripts).toHaveLength(1);
  });

  test("the service is current and a client fails: failed, no watchdog", async () => {
    const machine = fakeMachine({
      service: "service 2.0.0",
      clients: { "/usr/local/bin/claude-rc": "client 1.0.0" },
      release: { service: "service 2.0.0", client: "broken" },
      overrides: { version: "2.0.0" },
    });
    const updateReport = await createServiceUpdater(machine.env).run();
    expect(updateReport.status).toBe("failed");
    expect(updateReport.error).toContain("/usr/local/bin/claude-rc");
    expect(machine.scripts).toEqual([]);
  });

  test("a checksum mismatch installs nothing and fails", async () => {
    const machine = fakeMachine();
    const realFetch = machine.env.fetch;
    machine.env.fetch = (async (url: string | URL | Request) =>
      String(url).endsWith("SHA256SUMS")
        ? new Response(`${"0".repeat(64)}  claude-rc-launcher-linux-x64`)
        : realFetch(url)) as typeof fetch;
    const updateReport = await createServiceUpdater(machine.env).run();
    expect(updateReport.status).toBe("failed");
    expect(updateReport.error).toContain("checksum");
    expect(machine.text(BIN)).toBe("service 1.0.0");
    expect(machine.scripts).toEqual([]);
  });

  test("a new service binary that does not run is restored and nothing restarts", async () => {
    const machine = fakeMachine({ release: { service: "broken", client: "client 2.0.0" } });
    const updateReport = await createServiceUpdater(machine.env).run();
    expect(updateReport.status).toBe("failed");
    expect(machine.text(BIN)).toBe("service 1.0.0");
    expect(machine.scripts).toEqual([]);
  });

  test("a watchdog that cannot start restores the service binary", async () => {
    const machine = fakeMachine({
      overrides: {
        startWatchdog: () => {
          throw new Error("systemd-run failed");
        },
      },
    });
    const updateReport = await createServiceUpdater(machine.env).run();
    expect(updateReport.status).toBe("failed");
    expect(updateReport.error).toContain("systemd-run failed");
    expect(machine.text(BIN)).toBe("service 1.0.0");
  });
});

describe("createServiceUpdater lock", () => {
  test("a second run during the first gets 409", async () => {
    const machine = fakeMachine();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const realFetch = machine.env.fetch;
    machine.env.fetch = (async (url: string | URL | Request) => {
      await gate;
      return realFetch(url);
    }) as typeof fetch;
    const serviceUpdater = createServiceUpdater(machine.env);
    const first = serviceUpdater.run();
    const updateRefused = await refused(serviceUpdater.run());
    expect(updateRefused.status).toBe(409);
    release();
    expect((await first).status).toBe("restarting");
  });

  test("a run after a failed run works", async () => {
    const machine = fakeMachine();
    const realFetch = machine.env.fetch;
    let down = true;
    machine.env.fetch = (async (url: string | URL | Request) =>
      down ? new Response("x", { status: 503 }) : realFetch(url)) as typeof fetch;
    const serviceUpdater = createServiceUpdater(machine.env);
    expect((await serviceUpdater.run()).status).toBe("failed");
    down = false;
    expect((await serviceUpdater.run()).status).toBe("restarting");
  });

  test("a run after a refused run works", async () => {
    const machine = fakeMachine();
    const serviceUpdater = createServiceUpdater(machine.env);
    expect((await refused(serviceUpdater.run("latest"))).status).toBe(400);
    expect((await serviceUpdater.run()).status).toBe("restarting");
  });

  test("after restarting, the lock stays held until the service restarts", async () => {
    const machine = fakeMachine();
    const serviceUpdater = createServiceUpdater(machine.env);
    expect((await serviceUpdater.run()).status).toBe("restarting");
    expect((await refused(serviceUpdater.run())).status).toBe(409);
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
    const restarts = () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((part) => part === "restart claude-rc-launcher").length;
    return {
      dir,
      bin,
      run,
      restarts,
      cleanup: () => {
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  test("a service that never stays active gets the .prev binary back and a second restart", () => {
    const harness = sandbox("never-active");

    try {
      const syncSubprocess = harness.run();
      expect(syncSubprocess.exitCode).not.toBe(0);
      expect(readFileSync(harness.bin, "utf8")).toBe("old");
      expect(existsSync(`${harness.bin}.prev`)).toBe(false);
      expect(harness.restarts()).toBe(2);
    } finally {
      harness.cleanup();
    }
  }, 30_000);

  test("a first restart that fails puts the .prev binary back at once", () => {
    const harness = sandbox("restart-fails");

    try {
      const syncSubprocess = harness.run();
      expect(syncSubprocess.exitCode).not.toBe(0);
      expect(readFileSync(harness.bin, "utf8")).toBe("old");
      expect(existsSync(`${harness.bin}.prev`)).toBe(false);
    } finally {
      harness.cleanup();
    }
  }, 30_000);

  test("a service that stays active keeps the new binary", () => {
    const harness = sandbox("active");

    try {
      const syncSubprocess = harness.run();
      expect(syncSubprocess.exitCode).toBe(0);
      expect(readFileSync(harness.bin, "utf8")).toBe("new");
      expect(readFileSync(`${harness.bin}.prev`, "utf8")).toBe("old");
      expect(harness.restarts()).toBe(1);
    } finally {
      harness.cleanup();
    }
  }, 30_000);

  test("values are quoted for the shell", () => {
    const item = watchdogScript({ bin: "/tmp/a b'c", unit: "u", waitSeconds: 30 });
    expect(item).toContain(`'/tmp/a b'\\''c'`);
  });
});

describe("createClientVersions", () => {
  const make = (answers: Record<string, string | null>) => {
    const calls: string[][] = [];
    const env = {
      pathEnv: "/usr/local/bin",
      homes: ["/root"],
      exists: (file: string) => file in answers,
      realpath: (file: string) => file,
      run: (args: string[]) => {
        calls.push(args);
        const answer = answers[args[0]];
        return answer === null || answer === undefined
          ? { code: 1, stdout: "", stderr: "boom" }
          : { code: 0, stdout: answer, stderr: "" };
      },
    } as unknown as UpdateEnv;
    return { env, calls };
  };

  const item = "/usr/local/bin/claude-rc";
  const entry = "/root/.local/bin/claude-rc";

  test("a registered path with spaces is passed to the run as one argument", async () => {
    const value = "C:\\Program Files\\claude-rc\\claude-rc.exe";
    const calls: string[][] = [];
    const env = {
      platform: "win32",
      pathEnv: "",
      homes: [],
      exists: (file: string) => file === value,
      realpath: (file: string) => file,
      registeredClients: () => [value],
      run: () => ({ code: 1, stdout: "", stderr: "" }),
      runAsync: (args: string[]) => {
        calls.push(args);
        return Promise.resolve({ code: 0, stdout: "claude-rc 0.9.1\n", stderr: "" });
      },
    } as unknown as UpdateEnv;
    expect(await createClientVersions(env)()).toEqual([{ path: value, version: "0.9.1" }]);
    expect(calls).toEqual([[value, "--version"]]);
  });
  test("one copy gives its version", async () => {
    expect(await createClientVersions(make({ [item]: "claude-rc 0.8.2\n" }).env)()).toEqual([
      { path: item, version: "0.8.2" },
    ]);
  });
  test("a copy that exits 1 has no version", async () => {
    expect(await createClientVersions(make({ [item]: null }).env)()).toEqual([{ path: item }]);
  });
  test("two copies give two entries", async () => {
    expect(
      await createClientVersions(make({ [item]: "claude-rc 0.8.2\n", [entry]: "claude-rc 0.8.0\n" }).env)(),
    ).toEqual([
      { path: item, version: "0.8.2" },
      { path: entry, version: "0.8.0" },
    ]);
  });
  test("no copy gives an empty list", async () => {
    expect(await createClientVersions(make({}).env)()).toEqual([]);
  });
  test("a second call within the ttl runs no command, and one after it does", async () => {
    const { env, calls } = make({ [item]: "claude-rc 0.8.2\n" });
    let value = 1_000;
    const get = createClientVersions(env, { now: () => value });
    await get();
    expect(calls.length).toBe(1);
    value += 59_000;
    await get();
    expect(calls.length).toBe(1);
    value += 2_000;
    await get();
    expect(calls.length).toBe(2);
  });
  test("runAsync is used when present, with a short timeout, and concurrent callers share one lookup", async () => {
    const seen: { args: string[]; timeoutMs?: number }[] = [];
    let release!: (event: { code: number; stdout: string; stderr: string }) => void;
    const env = {
      pathEnv: "/usr/local/bin",
      homes: [],
      exists: (file: string) => file === item,
      realpath: (file: string) => file,
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
    expect(await p1).toEqual([{ path: item, version: "1.0.0" }]);
    expect(await p2).toEqual([{ path: item, version: "1.0.0" }]);
    expect(seen).toEqual([{ args: [item, "--version"], timeoutMs: 2_000 }]);
  });
  test("reset makes the next call ask again", async () => {
    const { env, calls } = make({ [item]: "claude-rc 0.8.2\n" });
    const get = createClientVersions(env, { now: () => 1_000 });
    await get();
    get.reset();
    await get();
    expect(calls.length).toBe(2);
  });
  test("a lookup in flight during reset does not store its old answer", async () => {
    let answer = "claude-rc 0.8.2\n";
    let release!: (event: { code: number; stdout: string; stderr: string }) => void;
    let calls = 0;
    const env = {
      pathEnv: "/usr/local/bin",
      homes: [],
      exists: (file: string) => file === item,
      realpath: (file: string) => file,
      run: () => ({ code: 0, stdout: answer, stderr: "" }),
      runAsync: () => {
        calls++;
        return calls === 1
          ? new Promise((res) => (release = res))
          : Promise.resolve({ code: 0, stdout: answer, stderr: "" });
      },
    } as unknown as UpdateEnv;
    const get = createClientVersions(env, { now: () => 1_000 });
    const old = get();
    await Bun.sleep(0);
    get.reset();
    answer = "claude-rc 0.8.3\n";
    release({ code: 0, stdout: "claude-rc 0.8.2\n", stderr: "" });
    expect(await old).toEqual([{ path: item, version: "0.8.2" }]);
    expect(await get()).toEqual([{ path: item, version: "0.8.3" }]);
    expect(calls).toBe(2);
  });
  test("a lookup that throws rejects once and does not stick", async () => {
    let count = 0;
    const env = {
      pathEnv: "/usr/local/bin",
      homes: [],
      exists: (file: string) => {
        if (count++ === 0) throw new Error("fs broke");
        return file === item;
      },
      realpath: (file: string) => file,
      run: () => ({ code: 0, stdout: "claude-rc 1.0.0\n", stderr: "" }),
    } as unknown as UpdateEnv;
    const get = createClientVersions(env);
    expect((await rejection(get())).message).toContain("fs broke");
    expect(await get()).toEqual([{ path: item, version: "1.0.0" }]);
  });
});

describe("createServiceUpdater hooks", () => {
  interface Step {
    step: string;
    to?: string;
    client?: string;
    detail?: string;
  }

  const rec = () => {
    const steps: Step[] = [];
    const lines: string[] = [];
    return {
      steps,
      lines,
      hooks: { onStep: (step: Step) => void steps.push(step), onLog: (item: string) => void lines.push(item) },
    };
  };

  const CL = "/usr/local/bin/claude-rc";

  test("a full update reports its steps in order, with the lines", async () => {
    const machine = fakeMachine({ clients: { [CL]: "client 1.0.0" } });
    const recorder = rec();
    await createServiceUpdater(machine.env, recorder.hooks).run();
    expect(recorder.steps).toEqual([
      { step: "downloading" },
      { step: "verifying" },
      { step: "installing-client", client: CL },
      { step: "installing" },
      { step: "restarting", to: "2.0.0" },
    ]);
    expect(recorder.lines).toContain("downloading claude-rc-launcher-linux-x64");
    expect(recorder.lines).toContain("sha256 matches SHA256SUMS");
    expect(recorder.lines).toContain("renamed the old binary to claude-rc-launcher.prev");
    expect(recorder.lines).toContain("new binary answers 2.0.0");
    expect(recorder.lines.at(-1)).toBe("starting the watchdog");
  });

  test("up-to-date ends with the step up-to-date, after downloading", async () => {
    const machine = fakeMachine({ service: "service 2.0.0", overrides: { version: "2.0.0" } });
    const recorder = rec();
    await createServiceUpdater(machine.env, recorder.hooks).run();
    expect(recorder.steps).toEqual([{ step: "downloading" }, { step: "verifying" }, { step: "up-to-date" }]);
  });

  test("a failed download is the step failed and a line with the same text", async () => {
    const machine = fakeMachine();
    machine.env.fetch = (() => Promise.resolve(new Response("no", { status: 404 }))) as unknown as typeof fetch;
    const recorder = rec();
    const updateReport = await createServiceUpdater(machine.env, recorder.hooks).run();
    expect(recorder.steps).toEqual([{ step: "downloading" }, { step: "failed", detail: updateReport.error }]);
    expect(recorder.lines.at(-1)).toBe(updateReport.error);
  });

  test("a failed --version check is the step failed", async () => {
    const machine = fakeMachine({ release: { service: "broken", client: "client 2.0.0" } });
    const recorder = rec();
    const updateReport = await createServiceUpdater(machine.env, recorder.hooks).run();
    expect(recorder.steps.map((step) => step.step)).toEqual(["downloading", "verifying", "installing", "failed"]);
    expect(recorder.steps.at(-1)).toEqual({ step: "failed", detail: updateReport.error });
    expect(recorder.lines.at(-1)).toBe(updateReport.error);
  });

  test("a failed rename is the step failed", async () => {
    const machine = fakeMachine();
    const run = machine.env.run.bind(machine.env);
    machine.env.run = (args, opts) =>
      args[0] === "mv" && args[1] === "-f" && args[2] === `${BIN}.new`
        ? { code: 1, stdout: "", stderr: "busy" }
        : run(args, opts);
    const recorder = rec();
    const updateReport = await createServiceUpdater(machine.env, recorder.hooks).run();
    expect(updateReport.status).toBe("failed");
    expect(recorder.steps.map((step) => step.step)).toEqual(["downloading", "verifying", "installing", "failed"]);
    expect(recorder.steps.at(-1)).toEqual({ step: "failed", detail: updateReport.error });
    expect(recorder.lines.at(-1)).toBe(updateReport.error);
  });

  test("a failed client does not stop the later steps", async () => {
    const machine = fakeMachine({
      clients: { [CL]: "client 1.0.0" },
      release: { service: "service 2.0.0", client: "broken" },
    });
    const recorder = rec();
    const updateReport = await createServiceUpdater(machine.env, recorder.hooks).run();
    expect(updateReport.status).toBe("restarting");
    expect(recorder.steps.map((step) => step.step)).toEqual([
      "downloading",
      "verifying",
      "installing-client",
      "installing",
      "restarting",
    ]);
    expect(recorder.lines.some((line) => line.includes(CL) && line.includes("--version"))).toBe(true);
  });
});

describe("createServiceUpdater hook safety and edge steps", () => {
  interface Step {
    step: string;
    to?: string;
    client?: string;
    detail?: string;
  }

  const rec = () => {
    const steps: Step[] = [];
    const lines: string[] = [];
    return {
      steps,
      lines,
      hooks: { onStep: (step: Step) => void steps.push(step), onLog: (item: string) => void lines.push(item) },
    };
  };

  const CL = "/usr/local/bin/claude-rc";
  const bad = {
    onStep() {
      throw new Error("step hook");
    },
    onLog() {
      throw new Error("log hook");
    },
  };

  test("hooks that throw change nothing: restarting, failed, and the lock is released", async () => {
    const machine = fakeMachine({ clients: { [CL]: "client 1.0.0" } });
    const updateReport = await createServiceUpdater(machine.env, bad).run();
    expect(updateReport.status).toBe("restarting");
    expect(machine.scripts).toHaveLength(1);
    expect(updateReport.clients[0].status).toBe("updated");

    const harness = fakeMachine({ release: { service: "broken", client: "client 2.0.0" } });
    const serviceUpdater = createServiceUpdater(harness.env, bad);
    expect((await serviceUpdater.run()).status).toBe("failed");
    expect((await serviceUpdater.run()).status).toBe("failed"); // not refused as busy
  });

  test("a non-refusal exception emits failed and is rethrown", async () => {
    const machine = fakeMachine();
    const recorder = rec();
    const rf = machine.env.readFile;

    machine.env.readFile = (value) => {
      if (value === BIN) throw new Error("disk gone");
      return rf(value);
    };

    expect((await rejection(createServiceUpdater(machine.env, recorder.hooks).run())).message).toContain("disk gone");
    expect(recorder.steps.at(-1)).toEqual({ step: "failed", detail: "disk gone" });
    expect(recorder.lines.at(-1)).toBe("disk gone");
  });

  test("a refusal and a busy run emit nothing", async () => {
    const recorder = rec();
    const machine = fakeMachine({ overrides: { platform: "darwin" } });
    await refused(createServiceUpdater(machine.env, recorder.hooks).run());
    const ok = fakeMachine();
    const serviceUpdater = createServiceUpdater(ok.env, recorder.hooks);
    await serviceUpdater.run();
    const count = recorder.steps.length;
    await refused(serviceUpdater.run()); // busy: the first run restarts and keeps the lock
    expect(recorder.steps.length).toBe(count);
    const h2 = rec();
    await refused(createServiceUpdater(fakeMachine().env, h2.hooks).run("bad"));
    expect(h2.steps).toEqual([]);
    expect(h2.lines).toEqual([]);
  });

  test("clients-only ends with the step up-to-date", async () => {
    const machine = fakeMachine({
      service: "service 2.0.0",
      clients: { [CL]: "client 1.0.0" },
      overrides: { version: "2.0.0" },
    });
    const recorder = rec();
    const updateReport = await createServiceUpdater(machine.env, recorder.hooks).run();
    expect(updateReport.status).toBe("clients-only");
    expect(recorder.steps.map((step) => step.step)).toEqual([
      "downloading",
      "verifying",
      "installing-client",
      "up-to-date",
    ]);
    expect(recorder.lines).toContain(`renamed the old client ${CL} to claude-rc.prev`);
    expect(recorder.lines).toContain(`new client ${CL} answers 2.0.0`);
  });

  test("the service is current and a client fails: the run ends failed", async () => {
    const machine = fakeMachine({
      service: "service 2.0.0",
      clients: { [CL]: "client 1.0.0" },
      release: { service: "service 2.0.0", client: "broken" },
      overrides: { version: "2.0.0" },
    });
    const recorder = rec();
    const updateReport = await createServiceUpdater(machine.env, recorder.hooks).run();
    expect(recorder.steps.map((step) => step.step)).toEqual([
      "downloading",
      "verifying",
      "installing-client",
      "failed",
    ]);
    expect(defined(recorder.steps.at(-1)).detail).toBe(updateReport.error);
  });

  test("a refused client write is logged and the run goes on", async () => {
    const machine = fakeMachine({ clients: { [CL]: "client 1.0.0" } });
    const run = machine.env.run.bind(machine.env);
    machine.env.run = (args, opts) =>
      args[0] === "install" && args[4] === `${CL}.new` ? { code: 1, stdout: "", stderr: "EACCES" } : run(args, opts);
    const recorder = rec();
    const updateReport = await createServiceUpdater(machine.env, recorder.hooks).run();
    expect(updateReport.status).toBe("restarting");
    expect(updateReport.clients[0].status).toBe("failed");
    expect(recorder.steps.map((step) => step.step)).toEqual([
      "downloading",
      "verifying",
      "installing-client",
      "installing",
      "restarting",
    ]);
    expect(recorder.lines.some((line) => line.includes(CL) && line.includes("EACCES"))).toBe(true);
  });

  test("a line is cut at 500 characters", async () => {
    const long = "a".repeat(600);
    const recorder = rec();
    const mm = fakeMachine({ overrides: { arch: "x64" } });
    mm.env.fetch = (() => {
      return Promise.reject(new Error(long));
    }) as unknown as typeof fetch;
    await createServiceUpdater(mm.env, recorder.hooks).run();
    const last = defined(recorder.lines.at(-1));
    expect(last.length).toBe(500);
    expect(last.endsWith("...")).toBe(true);
  });
});

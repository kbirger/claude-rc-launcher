import { beforeEach, describe, expect, test } from "bun:test";
import { sha256 } from "../src/updates/release";
import { UpdateRefused } from "../src/updates/serviceupdate";
import {
  PENDING_FILE,
  STAY_ACTIVE_SECONDS,
  WIN_ASSET,
  WIN_CLIENT_ASSET,
  confirmPendingUpdate,
  createWindowsUpdater,
  pendingPath,
} from "../src/win/update";
import type { WinUpdateEnv } from "../src/win/update";
import { rejection, defined } from "./support";

const DIR = "C:\\Program Files\\claude-rc-launcher";
const EXE = `${DIR}\\claude-rc-launcher.exe`;
const WRAPPER = `${DIR}\\claude-rc-launcher-svc.exe`;
const DATA = "C:\\ProgramData\\claude-rc-launcher";
const enc = (item: string) => new TextEncoder().encode(item);
const dec = (item: Uint8Array | undefined) => (item ? new TextDecoder().decode(item) : undefined);

let files: Map<string, Uint8Array>;
let log: string[];
let exits: number;
let released: Uint8Array; // what the release server serves for the asset
let sums: string | null; // the SHA256SUMS text; null = HTTP 404
let assetStatus: number;
let versionAnswers: Map<string, string | undefined>; // by file content: what `--version` reports
let failRename: ((from: string, to: string) => boolean) | null;
let failWrite: ((value: string) => boolean) | null;
let clientRelease: Uint8Array; // what the release server serves for the client asset
let clientSums: string | null;
let clientPaths: string[]; // what the client registry lookup returns

function env(over: Partial<WinUpdateEnv> = {}): WinUpdateEnv {
  return {
    fetch: ((url: string) => {
      if (String(url).endsWith(`/${WIN_ASSET}`))
        return Promise.resolve(
          assetStatus === 200
            ? new Response(released as unknown as BodyInit)
            : new Response("nope", { status: assetStatus }),
        );
      if (String(url).endsWith(`/${WIN_CLIENT_ASSET}`))
        return Promise.resolve(new Response(clientRelease as unknown as BodyInit));
      if (String(url).endsWith("/SHA256SUMS"))
        return Promise.resolve(
          sums === null ? new Response("nope", { status: 404 }) : new Response(`${sums}${clientSums ?? ""}`),
        );
      return Promise.resolve(new Response("?", { status: 500 }));
    }) as unknown as typeof fetch,
    platform: "win32",
    arch: "x64",
    execPath: EXE,
    version: "0.5.0",
    dataDir: DATA,
    clients: () => clientPaths,
    exists: (path) => files.has(path),
    readFile: (path) => {
      const response = files.get(path);
      if (!response) throw new Error(`ENOENT ${path}`);
      return response;
    },
    writeFile: (path, data) => {
      if (failWrite?.(path)) throw new Error(`EACCES writing ${path}`);
      files.set(path, data);
    },
    rename: (from, to) => {
      if (failRename?.(from, to)) throw new Error(`EPERM renaming ${from}`);
      const response = files.get(from);
      if (!response) throw new Error(`ENOENT ${from}`);
      files.set(to, response);
      files.delete(from);
    },
    remove: (path) => void files.delete(path),
    versionOf: (exe) => versionAnswers.get(dec(files.get(exe)) ?? ""),
    now: () => new Date("2026-11-08T12:00:00Z"),
    scheduleExit: () => {
      exits++;
    },
    ...over,
  };
}

/** `version` is what the binary reports with --version; null means it does not answer. */
function publish(content: string, version: string | null = "0.5.1") {
  released = enc(content);
  sums = `${sha256(released)}  ${WIN_ASSET}\n`;
  versionAnswers.set(content, version ?? undefined);
}

function publishClient(content: string, version: string | null = "0.5.1") {
  clientRelease = enc(content);
  clientSums = `${sha256(clientRelease)}  ${WIN_CLIENT_ASSET}\n`;
  versionAnswers.set(content, version ?? undefined);
}

beforeEach(() => {
  files = new Map([
    [EXE, enc("OLD")],
    [WRAPPER, enc("WINSW")],
  ]);
  log = [];
  exits = 0;
  assetStatus = 200;
  failRename = null;
  failWrite = null;
  versionAnswers = new Map([["OLD", "0.5.0"]]);
  publish("NEW");
  publishClient("NEWCLIENT");
  clientPaths = [];
});

const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof UpdateRefused) return error.status;
    throw error;
  }
};

describe("createWindowsUpdater", () => {
  test("swaps the binary, keeps the old one as .prev, writes the marker and schedules the exit", async () => {
    const updateReport = await createWindowsUpdater(env()).run();
    expect(updateReport).toEqual({ status: "restarting", from: "0.5.0", to: "0.5.1", clients: [] });
    expect(dec(files.get(EXE))).toBe("NEW");
    expect(dec(files.get(`${EXE}.prev`))).toBe("OLD");
    expect(files.has(`${EXE}.new`)).toBe(false);
    expect(JSON.parse(defined(dec(files.get(pendingPath(DATA)))))).toEqual({
      from: "0.5.0",
      to: "0.5.1",
      at: "2026-11-08T12:00:00.000Z",
      starts: 0,
    });
    expect(pendingPath(DATA)).toBe(`${DATA}\\${PENDING_FILE}`);
    expect(exits).toBe(1);
  });

  test("the same binary is up to date and changes nothing", async () => {
    publish("OLD");
    const updateReport = await createWindowsUpdater(env()).run();
    expect(updateReport).toEqual({ status: "up-to-date", from: "0.5.0", clients: [] });
    expect(files.has(`${EXE}.prev`)).toBe(false);
    expect(files.has(pendingPath(DATA))).toBe(false);
    expect(exits).toBe(0);
  });

  test("a bad release tag is 400", async () => {
    expect(await status(createWindowsUpdater(env()).run("latest"))).toBe(400);
    expect(await status(createWindowsUpdater(env()).run("v1.2.3"))).toBe("ok");
  });

  test("it refuses when this is not an installed Windows service", async () => {
    expect(await status(createWindowsUpdater(env({ platform: "linux" })).run())).toBe(409);
    expect(await status(createWindowsUpdater(env({ arch: "arm64" })).run())).toBe(409);
    expect(await status(createWindowsUpdater(env({ execPath: "C:\\Users\\kir\\.bun\\bin\\bun.exe" })).run())).toBe(409);
    files.delete(WRAPPER); // started by hand, not by WinSW
    expect(await status(createWindowsUpdater(env()).run())).toBe(409);
    expect(exits).toBe(0);
  });

  test("a second run after a successful one is refused until the agent restarts", async () => {
    const windowsUpdater = createWindowsUpdater(env());
    await windowsUpdater.run();
    expect(await status(windowsUpdater.run())).toBe(409);
    expect(dec(files.get(`${EXE}.prev`))).toBe("OLD"); // not overwritten with the new binary
  });

  test("a failed update does not keep the lock", async () => {
    sums = null;
    const windowsUpdater = createWindowsUpdater(env());
    expect((await windowsUpdater.run()).status).toBe("failed");
    publish("NEW");
    expect((await windowsUpdater.run()).status).toBe("restarting");
  });

  test("two runs at the same time: the second is 409", async () => {
    const windowsUpdater = createWindowsUpdater(env());
    const [item, entry] = await Promise.all([status(windowsUpdater.run()), status(windowsUpdater.run())]);
    expect([item, entry].sort()).toEqual([409, "ok"]);
  });

  test("a failed download or a wrong checksum installs nothing", async () => {
    assetStatus = 404;
    let updateReport = await createWindowsUpdater(env()).run();
    expect(updateReport.status).toBe("failed");
    assetStatus = 200;
    sums = `${"0".repeat(64)}  ${WIN_ASSET}\n`;
    updateReport = await createWindowsUpdater(env()).run();
    expect(updateReport.status).toBe("failed");
    expect(updateReport.error).toContain("does not match SHA256SUMS");
    expect(dec(files.get(EXE))).toBe("OLD");
    expect([...files.keys()].sort()).toEqual([EXE, WRAPPER].sort());
    expect(exits).toBe(0);
  });

  test("a new binary that does not answer --version is never installed", async () => {
    publish("BROKEN", null);
    const updateReport = await createWindowsUpdater(env()).run();
    expect(updateReport.status).toBe("failed");
    expect(updateReport.error).toContain("did not answer --version");
    expect(dec(files.get(EXE))).toBe("OLD");
    expect(files.has(`${EXE}.new`)).toBe(false);
    expect(files.has(`${EXE}.prev`)).toBe(false);
    expect(exits).toBe(0);
  });

  test("when the first rename fails, nothing changed", async () => {
    failRename = (from) => from === EXE;
    const updateReport = await createWindowsUpdater(env()).run();
    expect(updateReport.status).toBe("failed");
    expect(dec(files.get(EXE))).toBe("OLD");
    expect(files.has(`${EXE}.new`)).toBe(false);
    expect(files.has(pendingPath(DATA))).toBe(false);
  });

  test("when the second rename fails, the old binary is put back", async () => {
    failRename = (from) => from === `${EXE}.new`;
    const updateReport = await createWindowsUpdater(env()).run();
    expect(updateReport.status).toBe("failed");
    expect(updateReport.error).toContain("The previous binary is in place");
    expect(dec(files.get(EXE))).toBe("OLD");
    expect(files.has(`${EXE}.new`)).toBe(false);
    expect(exits).toBe(0);
  });

  test("when the second rename fails and the old binary cannot be put back, the report says so", async () => {
    failRename = (from) => from === `${EXE}.new` || from === `${EXE}.prev`;
    const updateReport = await createWindowsUpdater(env()).run();
    expect(updateReport.status).toBe("failed");
    expect(updateReport.error).toContain(`${EXE}.prev could not be put back`);
  });

  test("when the marker cannot be written, the old binary is restored and the agent does not exit", async () => {
    failWrite = (item) => item === pendingPath(DATA);
    const updateReport = await createWindowsUpdater(env()).run();
    expect(updateReport.status).toBe("failed");
    expect(updateReport.error).toContain("The previous binary was restored");
    expect(dec(files.get(EXE))).toBe("OLD");
    expect(exits).toBe(0);
  });

  test("when the new file cannot be written, nothing changed", async () => {
    failWrite = (item) => item === `${EXE}.new`;
    const updateReport = await createWindowsUpdater(env()).run();
    expect(updateReport.status).toBe("failed");
    expect(dec(files.get(EXE))).toBe("OLD");
    expect(exits).toBe(0);
  });
});

describe("confirmPendingUpdate", () => {
  let timers: { ms: number; fn: () => void }[];
  beforeEach(() => {
    timers = [];
  });

  const confirm = (version: string) => {
    confirmPendingUpdate({
      dataDir: DATA,
      version,
      exists: (path) => files.has(path),
      readFile: (path) => defined(files.get(path)),
      remove: (path) => void files.delete(path),
      after: (ms, fn) => void timers.push({ ms, fn }),
      log: (line) => void log.push(line),
    });
  };

  const pend = (to: string) => files.set(pendingPath(DATA), enc(JSON.stringify({ from: "0.5.0", to, starts: 1 })));

  test("the new version deletes the marker after 30 seconds, not before", () => {
    pend("0.5.1");
    confirm("0.5.1");
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(STAY_ACTIVE_SECONDS * 1000);
    expect(files.has(pendingPath(DATA))).toBe(true);
    timers[0].fn();
    expect(files.has(pendingPath(DATA))).toBe(false);
    expect(log.join("\n")).toContain("is kept");
  });

  test("a process that is not the new version leaves the marker alone", () => {
    pend("0.5.1");
    confirm("0.5.0");
    expect(timers).toHaveLength(0);
    expect(files.has(pendingPath(DATA))).toBe(true);
  });

  test("no marker, or a broken one, does nothing", () => {
    confirm("0.5.1");
    files.set(pendingPath(DATA), enc("{ nope"));
    confirm("0.5.1");
    expect(timers).toHaveLength(0);
  });

  test("a marker that cannot be deleted is logged", () => {
    pend("0.5.1");
    confirmPendingUpdate({
      dataDir: DATA,
      version: "0.5.1",
      exists: (path) => files.has(path),
      readFile: (path) => defined(files.get(path)),
      remove: () => {
        throw new Error("EBUSY");
      },
      after: (ms, fn) => void timers.push({ ms, fn }),
      log: (line) => void log.push(line),
    });
    timers[0].fn();
    expect(log.join("\n")).toContain("EBUSY");
  });
});

describe("client update", () => {
  const CLIENT = "C:\\Program Files\\claude-rc\\bin\\claude-rc.exe";
  beforeEach(() => {
    files.set(CLIENT, enc("OLDCLIENT"));
    versionAnswers.set("OLDCLIENT", "0.5.0");
    clientPaths = [CLIENT];
  });
  const leftovers = () => [...files.keys()].filter((key) => key.endsWith(".new"));

  test("the client is updated, then the service is replaced", async () => {
    const updateReport = await createWindowsUpdater(env()).run();
    expect(updateReport).toEqual({
      status: "restarting",
      from: "0.5.0",
      to: "0.5.1",
      clients: [{ path: CLIENT, status: "updated", from: "0.5.0", to: "0.5.1" }],
    });
    expect(dec(files.get(CLIENT))).toBe("NEWCLIENT");
    expect(dec(files.get(`${CLIENT}.prev`))).toBe("OLDCLIENT");
    expect(dec(files.get(EXE))).toBe("NEW");
    expect(leftovers()).toEqual([]);
  });

  test("an old .prev from an earlier update is removed before the rename", async () => {
    files.set(`${CLIENT}.prev`, enc("ANCIENT"));
    const realRename = env().rename;
    const updateReport = await createWindowsUpdater(
      env({
        rename: (from, to) => {
          if (to === `${CLIENT}.prev` && files.has(to)) throw new Error("EEXIST");
          realRename(from, to);
        },
      }),
    ).run();
    expect(updateReport.clients[0].status).toBe("updated");
    expect(dec(files.get(`${CLIENT}.prev`))).toBe("OLDCLIENT");
  });

  test("a refused write is a failed client with the by-hand message, and the service still updates", async () => {
    failWrite = (item) => item === `${CLIENT}.new`;
    const updateReport = await createWindowsUpdater(env()).run();
    expect(updateReport.status).toBe("restarting");
    expect(updateReport.clients).toHaveLength(1);
    expect(updateReport.clients[0].status).toBe("failed");
    expect(updateReport.clients[0].error).toContain("EACCES");
    expect(updateReport.clients[0].error).toContain("install.ps1 -ClientOnly");
    expect(dec(files.get(CLIENT))).toBe("OLDCLIENT");
    expect(dec(files.get(EXE))).toBe("NEW");
    expect(leftovers()).toEqual([]);
  });

  test("a refused first rename leaves the client alone and removes .new", async () => {
    failRename = (from) => from === CLIENT;
    const updateReport = await createWindowsUpdater(env()).run();
    expect(updateReport.clients[0].status).toBe("failed");
    expect(updateReport.clients[0].error).toContain("install.ps1 -ClientOnly");
    expect(dec(files.get(CLIENT))).toBe("OLDCLIENT");
    expect(leftovers()).toEqual([]);
    expect(updateReport.status).toBe("restarting");
  });

  test("when the second rename fails, .prev is put back and .new is removed", async () => {
    failRename = (from) => from === `${CLIENT}.new`;
    const updateReport = await createWindowsUpdater(env()).run();
    expect(updateReport.clients[0].status).toBe("failed");
    expect(dec(files.get(CLIENT))).toBe("OLDCLIENT");
    expect(files.has(`${CLIENT}.prev`)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  test("when .prev cannot be put back either, the error says so", async () => {
    failRename = (from) => from === `${CLIENT}.new` || from === `${CLIENT}.prev`;
    const updateReport = await createWindowsUpdater(env()).run();
    expect(updateReport.clients[0].error).toContain(`${CLIENT}.prev could not be put back`);
    expect(leftovers()).toEqual([]);
  });

  test("a new client that does not answer --version is not installed and .new is removed", async () => {
    publishClient("BROKENCLIENT", null);
    const updateReport = await createWindowsUpdater(env()).run();
    expect(updateReport.clients[0].status).toBe("failed");
    expect(updateReport.clients[0].error).toContain("did not answer --version");
    expect(dec(files.get(CLIENT))).toBe("OLDCLIENT");
    expect(leftovers()).toEqual([]);
  });

  test("a failed client download fails every client and the service still updates", async () => {
    clientSums = `${"0".repeat(64)}  ${WIN_CLIENT_ASSET}\n`;
    const updateReport = await createWindowsUpdater(env()).run();
    expect(updateReport.status).toBe("restarting");
    expect(updateReport.clients[0].status).toBe("failed");
    expect(updateReport.clients[0].error).toContain("does not match SHA256SUMS");
    expect(dec(files.get(CLIENT))).toBe("OLDCLIENT");
  });

  test("a client that already matches is up-to-date", async () => {
    publishClient("OLDCLIENT", "0.5.0");
    const updateReport = await createWindowsUpdater(env()).run();
    expect(updateReport.clients).toEqual([{ path: CLIENT, status: "up-to-date" }]);
    expect(files.has(`${CLIENT}.prev`)).toBe(false);
  });

  test("clients-only when the service is current and only a client changed", async () => {
    publish("OLD");
    const updateReport = await createWindowsUpdater(env()).run();
    expect(updateReport.status).toBe("clients-only");
    expect(updateReport.clients[0].status).toBe("updated");
    expect(dec(files.get(CLIENT))).toBe("NEWCLIENT");
    expect(exits).toBe(0);
  });

  test("up-to-date when nothing changed", async () => {
    publish("OLD");
    publishClient("OLDCLIENT", "0.5.0");
    const updateReport = await createWindowsUpdater(env()).run();
    expect(updateReport).toEqual({
      status: "up-to-date",
      from: "0.5.0",
      clients: [{ path: CLIENT, status: "up-to-date" }],
    });
  });

  test("failed (as on Linux) when the service is current and a client failed", async () => {
    publish("OLD");
    failWrite = (item) => item === `${CLIENT}.new`;
    const updateReport = await createWindowsUpdater(env()).run();
    expect(updateReport.status).toBe("failed");
    expect(updateReport.error).toContain("the client update failed");
    expect(updateReport.error).toContain(CLIENT);
    expect(updateReport.clients[0].status).toBe("failed");
    expect(leftovers()).toEqual([]);
  });

  test("no clients means no client download", async () => {
    clientPaths = [];
    clientSums = `${"0".repeat(64)}  ${WIN_CLIENT_ASSET}\n`; // would fail if it were checked
    const updateReport = await createWindowsUpdater(env()).run();
    expect(updateReport).toEqual({ status: "restarting", from: "0.5.0", to: "0.5.1", clients: [] });
  });

  test("an old .prev that cannot be removed (EBUSY) does not fail the client", async () => {
    files.set(`${CLIENT}.prev`, enc("ANCIENT"));
    const updateReport = await createWindowsUpdater(
      env({
        remove: (path) => {
          if (path === `${CLIENT}.prev`) throw new Error("EBUSY");
          files.delete(path);
        },
      }),
    ).run();
    expect(updateReport.clients[0].status).toBe("updated");
    expect(dec(files.get(CLIENT))).toBe("NEWCLIENT");
    expect(dec(files.get(`${CLIENT}.prev`))).toBe("OLDCLIENT");
  });

  test("a client path that is not named claude-rc.exe is refused and untouched", async () => {
    const odd = "C:\\Windows\\System32\\cmd.exe";
    files.set(odd, enc("CMD"));
    clientPaths = [odd, CLIENT.toUpperCase().replace("CLAUDE-RC.EXE", "Claude-RC.EXE")];
    files.set(clientPaths[1], enc("OLDCLIENT"));
    const updateReport = await createWindowsUpdater(env()).run();
    expect(updateReport.clients[0].status).toBe("failed");
    expect(updateReport.clients[0].error).toContain("is not named claude-rc.exe");
    expect(dec(files.get(odd))).toBe("CMD");
    expect(leftovers()).toEqual([]);
    expect(updateReport.clients[1].status).toBe("updated");
  });
});

describe("windows updater hooks", () => {
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

  const CL = "C:\\Tools\\claude-rc.exe";

  test("a full update reports its steps in order, with the lines", async () => {
    files.set(CL, enc("OLDCLIENT"));
    clientPaths = [CL];
    const recorder = rec();
    await createWindowsUpdater(env(), recorder.hooks).run();
    expect(recorder.steps).toEqual([
      { step: "downloading" },
      { step: "verifying" },
      { step: "installing-client", client: CL },
      { step: "installing" },
      { step: "restarting", to: "0.5.1" },
    ]);
    expect(recorder.lines).toContain(`downloading ${WIN_ASSET}`);
    expect(recorder.lines).toContain("sha256 matches SHA256SUMS");
    expect(recorder.lines).toContain("new binary answers 0.5.1");
    expect(recorder.lines).toContain("renamed the old binary to claude-rc-launcher.exe.prev");
    expect(recorder.lines.at(-1)).toBe("restarting in 2 seconds");
  });

  test("up-to-date ends with the step up-to-date, after downloading", async () => {
    publish("OLD");
    const recorder = rec();
    await createWindowsUpdater(env(), recorder.hooks).run();
    expect(recorder.steps).toEqual([{ step: "downloading" }, { step: "verifying" }, { step: "up-to-date" }]);
  });

  test("a failed download is the step failed and a line with the same text", async () => {
    assetStatus = 404;
    const recorder = rec();
    const updateReport = await createWindowsUpdater(env(), recorder.hooks).run();
    expect(recorder.steps).toEqual([{ step: "downloading" }, { step: "failed", detail: updateReport.error }]);
    expect(recorder.lines.at(-1)).toBe(updateReport.error);
  });

  test("a failed --version check is the step failed", async () => {
    publish("NEW", null);
    const recorder = rec();
    const updateReport = await createWindowsUpdater(env(), recorder.hooks).run();
    expect(recorder.steps.map((step) => step.step)).toEqual(["downloading", "verifying", "installing", "failed"]);
    expect(recorder.steps.at(-1)).toEqual({ step: "failed", detail: updateReport.error });
    expect(recorder.lines.at(-1)).toBe(updateReport.error);
  });

  test("a failed rename is the step failed", async () => {
    failRename = (from) => from === `${EXE}.new`;
    const recorder = rec();
    const updateReport = await createWindowsUpdater(env(), recorder.hooks).run();
    expect(updateReport.status).toBe("failed");
    expect(recorder.steps.map((step) => step.step)).toEqual(["downloading", "verifying", "installing", "failed"]);
    expect(recorder.steps.at(-1)).toEqual({ step: "failed", detail: updateReport.error });
    expect(recorder.lines.at(-1)).toBe(updateReport.error);
  });

  test("a refused client write does not stop the later steps", async () => {
    files.set(CL, enc("OLDCLIENT"));
    clientPaths = [CL];
    failWrite = (entry) => entry === `${CL}.new`;
    const recorder = rec();
    const updateReport = await createWindowsUpdater(env(), recorder.hooks).run();
    expect(updateReport.status).toBe("restarting");
    expect(recorder.steps.map((step) => step.step)).toEqual([
      "downloading",
      "verifying",
      "installing-client",
      "installing",
      "restarting",
    ]);
    expect(recorder.lines.some((line) => line.includes(CL) && line.includes("EACCES"))).toBe(true);
  });
});

describe("windows updater hook safety and edge steps", () => {
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

  const CL = "C:\\Tools\\claude-rc.exe";
  const bad = {
    onStep() {
      throw new Error("step hook");
    },
    onLog() {
      throw new Error("log hook");
    },
  };

  test("hooks that throw change nothing: restarting, failed, and the lock is released", async () => {
    files.set(CL, enc("OLDCLIENT"));
    clientPaths = [CL];
    const updateReport = await createWindowsUpdater(env(), bad).run();
    expect(updateReport.status).toBe("restarting");
    expect(updateReport.clients[0].status).toBe("updated");
    expect(exits).toBe(1);

    files = new Map([
      [EXE, enc("OLD")],
      [WRAPPER, enc("WINSW")],
    ]);
    clientPaths = [];
    publish("NEW", null);
    const windowsUpdater = createWindowsUpdater(env(), bad);
    expect((await windowsUpdater.run()).status).toBe("failed");
    expect((await windowsUpdater.run()).status).toBe("failed"); // not refused as busy
  });

  test("a non-refusal exception emits failed and is rethrown", async () => {
    const recorder = rec();
    expect(
      (
        await rejection(
          createWindowsUpdater(
            env({
              readFile: () => {
                throw new Error("disk gone");
              },
            }),
            recorder.hooks,
          ).run(),
        )
      ).message,
    ).toContain("disk gone");
    expect(recorder.steps.at(-1)).toEqual({ step: "failed", detail: "disk gone" });
    expect(recorder.lines.at(-1)).toBe("disk gone");
  });

  test("a refusal and a busy run emit nothing", async () => {
    const recorder = rec();
    expect(await rejection(createWindowsUpdater(env({ platform: "linux" }), recorder.hooks).run())).toBeInstanceOf(
      UpdateRefused,
    );
    expect(await rejection(createWindowsUpdater(env(), recorder.hooks).run("latest"))).toBeInstanceOf(UpdateRefused);
    expect(recorder.steps).toEqual([]);
    expect(recorder.lines).toEqual([]);
    const windowsUpdater = createWindowsUpdater(env(), recorder.hooks);
    await windowsUpdater.run();
    const count = recorder.steps.length;
    expect(await rejection(windowsUpdater.run())).toBeInstanceOf(UpdateRefused);
    expect(recorder.steps.length).toBe(count);
  });

  test("clients-only ends with the step up-to-date, with the client lines", async () => {
    publish("OLD");
    files.set(CL, enc("OLDCLIENT"));
    clientPaths = [CL];
    const recorder = rec();
    const updateReport = await createWindowsUpdater(env(), recorder.hooks).run();
    expect(updateReport.status).toBe("clients-only");
    expect(recorder.steps.map((step) => step.step)).toEqual([
      "downloading",
      "verifying",
      "installing-client",
      "up-to-date",
    ]);
    expect(recorder.lines).toContain(`new client ${CL} answers 0.5.1`);
    expect(recorder.lines).toContain(`renamed the old client ${CL} to claude-rc.exe.prev`);
  });

  test("the service is current and a client fails: the run ends failed", async () => {
    publish("OLD");
    files.set(CL, enc("OLDCLIENT"));
    clientPaths = [CL];
    failWrite = (entry) => entry === `${CL}.new`;
    const recorder = rec();
    const updateReport = await createWindowsUpdater(env(), recorder.hooks).run();
    expect(updateReport.status).toBe("failed");
    expect(recorder.steps.map((step) => step.step)).toEqual([
      "downloading",
      "verifying",
      "installing-client",
      "failed",
    ]);
    expect(defined(recorder.steps.at(-1)).detail).toBe(updateReport.error);
  });

  test("a line is cut at 500 characters", async () => {
    const recorder = rec();
    const long = "a".repeat(600);
    await createWindowsUpdater(
      env({
        fetch: (() => {
          return Promise.reject(new Error(long));
        }) as unknown as typeof fetch,
      }),
      recorder.hooks,
    ).run();
    const last = defined(recorder.lines.at(-1));
    expect(last.length).toBe(500);
    expect(last.endsWith("...")).toBe(true);
  });
});

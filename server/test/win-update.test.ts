import { beforeEach, describe, expect, test } from "bun:test";
import { sha256 } from "../src/release";
import { UpdateRefused } from "../src/serviceupdate";
import {
  PENDING_FILE, STAY_ACTIVE_SECONDS, WIN_ASSET, WIN_CLIENT_ASSET, confirmPendingUpdate, createWindowsUpdater, pendingPath, type WinUpdateEnv,
} from "../src/win/update";

const DIR = "C:\\Program Files\\claude-rc-launcher";
const EXE = `${DIR}\\claude-rc-launcher.exe`;
const WRAPPER = `${DIR}\\claude-rc-launcher-svc.exe`;
const DATA = "C:\\ProgramData\\claude-rc-launcher";
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined);

let files: Map<string, Uint8Array>;
let log: string[];
let exits: number;
let released: Uint8Array; // what the release server serves for the asset
let sums: string | null; // the SHA256SUMS text; null = HTTP 404
let assetStatus: number;
let versionAnswers: Map<string, string | undefined>; // by file content: what `--version` reports
let failRename: ((from: string, to: string) => boolean) | null;
let failWrite: ((p: string) => boolean) | null;
let clientRelease: Uint8Array; // what the release server serves for the client asset
let clientSums: string | null;
let clientPaths: string[]; // what the client registry lookup returns

function env(over: Partial<WinUpdateEnv> = {}): WinUpdateEnv {
  return {
    fetch: (async (url: string) => {
      if (String(url).endsWith(`/${WIN_ASSET}`)) return assetStatus === 200 ? new Response(released as unknown as BodyInit) : new Response("nope", { status: assetStatus });
      if (String(url).endsWith(`/${WIN_CLIENT_ASSET}`)) return new Response(clientRelease as unknown as BodyInit);
      if (String(url).endsWith("/SHA256SUMS")) return sums === null ? new Response("nope", { status: 404 }) : new Response(`${sums}${clientSums ?? ""}`);
      return new Response("?", { status: 500 });
    }) as unknown as typeof fetch,
    platform: "win32",
    arch: "x64",
    execPath: EXE,
    version: "0.5.0",
    dataDir: DATA,
    clients: () => clientPaths,
    exists: (p) => files.has(p),
    readFile: (p) => {
      const f = files.get(p);
      if (!f) throw new Error(`ENOENT ${p}`);
      return f;
    },
    writeFile: (p, data) => {
      if (failWrite?.(p)) throw new Error(`EACCES writing ${p}`);
      files.set(p, data);
    },
    rename: (from, to) => {
      if (failRename?.(from, to)) throw new Error(`EPERM renaming ${from}`);
      const f = files.get(from);
      if (!f) throw new Error(`ENOENT ${from}`);
      files.set(to, f);
      files.delete(from);
    },
    remove: (p) => void files.delete(p),
    versionOf: (p) => versionAnswers.get(dec(files.get(p)) ?? ""),
    now: () => new Date("2026-11-08T12:00:00Z"),
    scheduleExit: () => { exits++; },
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
  files = new Map([[EXE, enc("OLD")], [WRAPPER, enc("WINSW")]]);
  log = []; exits = 0; assetStatus = 200; failRename = null; failWrite = null;
  versionAnswers = new Map([["OLD", "0.5.0"]]);
  publish("NEW");
  publishClient("NEWCLIENT");
  clientPaths = [];
});

const status = async (p: Promise<unknown>) => {
  try { await p; return "ok"; } catch (e) {
    if (e instanceof UpdateRefused) return e.status;
    throw e;
  }
};

describe("createWindowsUpdater", () => {
  test("swaps the binary, keeps the old one as .prev, writes the marker and schedules the exit", async () => {
    const r = await createWindowsUpdater(env()).run();
    expect(r).toEqual({ status: "restarting", from: "0.5.0", to: "0.5.1", clients: [] });
    expect(dec(files.get(EXE))).toBe("NEW");
    expect(dec(files.get(`${EXE}.prev`))).toBe("OLD");
    expect(files.has(`${EXE}.new`)).toBe(false);
    expect(JSON.parse(dec(files.get(pendingPath(DATA)))!)).toEqual({ from: "0.5.0", to: "0.5.1", at: "2026-11-08T12:00:00.000Z", starts: 0 });
    expect(pendingPath(DATA)).toBe(`${DATA}\\${PENDING_FILE}`);
    expect(exits).toBe(1);
  });

  test("the same binary is up to date and changes nothing", async () => {
    publish("OLD");
    const r = await createWindowsUpdater(env()).run();
    expect(r).toEqual({ status: "up-to-date", from: "0.5.0", clients: [] });
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
    const u = createWindowsUpdater(env());
    await u.run();
    expect(await status(u.run())).toBe(409);
    expect(dec(files.get(`${EXE}.prev`))).toBe("OLD"); // not overwritten with the new binary
  });

  test("a failed update does not keep the lock", async () => {
    sums = null;
    const u = createWindowsUpdater(env());
    expect((await u.run()).status).toBe("failed");
    publish("NEW");
    expect((await u.run()).status).toBe("restarting");
  });

  test("two runs at the same time: the second is 409", async () => {
    const u = createWindowsUpdater(env());
    const [a, b] = await Promise.all([status(u.run()), status(u.run())]);
    expect([a, b].sort()).toEqual([409, "ok"]);
  });

  test("a failed download or a wrong checksum installs nothing", async () => {
    assetStatus = 404;
    let r = await createWindowsUpdater(env()).run();
    expect(r.status).toBe("failed");
    assetStatus = 200;
    sums = `${"0".repeat(64)}  ${WIN_ASSET}\n`;
    r = await createWindowsUpdater(env()).run();
    expect(r.status).toBe("failed");
    expect(r.error).toContain("does not match SHA256SUMS");
    expect(dec(files.get(EXE))).toBe("OLD");
    expect([...files.keys()].sort()).toEqual([EXE, WRAPPER].sort());
    expect(exits).toBe(0);
  });

  test("a new binary that does not answer --version is never installed", async () => {
    publish("BROKEN", null);
    const r = await createWindowsUpdater(env()).run();
    expect(r.status).toBe("failed");
    expect(r.error).toContain("did not answer --version");
    expect(dec(files.get(EXE))).toBe("OLD");
    expect(files.has(`${EXE}.new`)).toBe(false);
    expect(files.has(`${EXE}.prev`)).toBe(false);
    expect(exits).toBe(0);
  });

  test("when the first rename fails, nothing changed", async () => {
    failRename = (from) => from === EXE;
    const r = await createWindowsUpdater(env()).run();
    expect(r.status).toBe("failed");
    expect(dec(files.get(EXE))).toBe("OLD");
    expect(files.has(`${EXE}.new`)).toBe(false);
    expect(files.has(pendingPath(DATA))).toBe(false);
  });

  test("when the second rename fails, the old binary is put back", async () => {
    failRename = (from) => from === `${EXE}.new`;
    const r = await createWindowsUpdater(env()).run();
    expect(r.status).toBe("failed");
    expect(r.error).toContain("The previous binary is in place");
    expect(dec(files.get(EXE))).toBe("OLD");
    expect(files.has(`${EXE}.new`)).toBe(false);
    expect(exits).toBe(0);
  });

  test("when the second rename fails and the old binary cannot be put back, the report says so", async () => {
    failRename = (from) => from === `${EXE}.new` || from === `${EXE}.prev`;
    const r = await createWindowsUpdater(env()).run();
    expect(r.status).toBe("failed");
    expect(r.error).toContain(`${EXE}.prev could not be put back`);
  });

  test("when the marker cannot be written, the old binary is restored and the agent does not exit", async () => {
    failWrite = (p) => p === pendingPath(DATA);
    const r = await createWindowsUpdater(env()).run();
    expect(r.status).toBe("failed");
    expect(r.error).toContain("The previous binary was restored");
    expect(dec(files.get(EXE))).toBe("OLD");
    expect(exits).toBe(0);
  });

  test("when the new file cannot be written, nothing changed", async () => {
    failWrite = (p) => p === `${EXE}.new`;
    const r = await createWindowsUpdater(env()).run();
    expect(r.status).toBe("failed");
    expect(dec(files.get(EXE))).toBe("OLD");
    expect(exits).toBe(0);
  });
});

describe("confirmPendingUpdate", () => {
  let timers: { ms: number; fn: () => void }[];
  beforeEach(() => { timers = []; });
  const confirm = (version: string) =>
    confirmPendingUpdate({
      dataDir: DATA, version,
      exists: (p) => files.has(p), readFile: (p) => files.get(p)!, remove: (p) => void files.delete(p),
      after: (ms, fn) => void timers.push({ ms, fn }), log: (l) => void log.push(l),
    });
  const pend = (to: string) => files.set(pendingPath(DATA), enc(JSON.stringify({ from: "0.5.0", to, starts: 1 })));

  test("the new version deletes the marker after 30 seconds, not before", () => {
    pend("0.5.1");
    confirm("0.5.1");
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(STAY_ACTIVE_SECONDS * 1000);
    expect(files.has(pendingPath(DATA))).toBe(true);
    timers[0]!.fn();
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
      dataDir: DATA, version: "0.5.1", exists: (p) => files.has(p), readFile: (p) => files.get(p)!,
      remove: () => { throw new Error("EBUSY"); }, after: (ms, fn) => void timers.push({ ms, fn }), log: (l) => void log.push(l),
    });
    timers[0]!.fn();
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
  const leftovers = () => [...files.keys()].filter((k) => k.endsWith(".new"));

  test("the client is updated, then the service is replaced", async () => {
    const r = await createWindowsUpdater(env()).run();
    expect(r).toEqual({ status: "restarting", from: "0.5.0", to: "0.5.1", clients: [{ path: CLIENT, status: "updated", from: "0.5.0", to: "0.5.1" }] });
    expect(dec(files.get(CLIENT))).toBe("NEWCLIENT");
    expect(dec(files.get(`${CLIENT}.prev`))).toBe("OLDCLIENT");
    expect(dec(files.get(EXE))).toBe("NEW");
    expect(leftovers()).toEqual([]);
  });

  test("an old .prev from an earlier update is removed before the rename", async () => {
    files.set(`${CLIENT}.prev`, enc("ANCIENT"));
    const realRename = env().rename;
    const r = await createWindowsUpdater(env({
      rename: (from, to) => {
        if (to === `${CLIENT}.prev` && files.has(to)) throw new Error("EEXIST");
        realRename(from, to);
      },
    })).run();
    expect(r.clients[0]!.status).toBe("updated");
    expect(dec(files.get(`${CLIENT}.prev`))).toBe("OLDCLIENT");
  });

  test("a refused write is a failed client with the by-hand message, and the service still updates", async () => {
    failWrite = (p) => p === `${CLIENT}.new`;
    const r = await createWindowsUpdater(env()).run();
    expect(r.status).toBe("restarting");
    expect(r.clients).toHaveLength(1);
    expect(r.clients[0]!.status).toBe("failed");
    expect(r.clients[0]!.error).toContain("EACCES");
    expect(r.clients[0]!.error).toContain("install.ps1 -ClientOnly");
    expect(dec(files.get(CLIENT))).toBe("OLDCLIENT");
    expect(dec(files.get(EXE))).toBe("NEW");
    expect(leftovers()).toEqual([]);
  });

  test("a refused first rename leaves the client alone and removes .new", async () => {
    failRename = (from) => from === CLIENT;
    const r = await createWindowsUpdater(env()).run();
    expect(r.clients[0]!.status).toBe("failed");
    expect(r.clients[0]!.error).toContain("install.ps1 -ClientOnly");
    expect(dec(files.get(CLIENT))).toBe("OLDCLIENT");
    expect(leftovers()).toEqual([]);
    expect(r.status).toBe("restarting");
  });

  test("when the second rename fails, .prev is put back and .new is removed", async () => {
    failRename = (from) => from === `${CLIENT}.new`;
    const r = await createWindowsUpdater(env()).run();
    expect(r.clients[0]!.status).toBe("failed");
    expect(dec(files.get(CLIENT))).toBe("OLDCLIENT");
    expect(files.has(`${CLIENT}.prev`)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  test("when .prev cannot be put back either, the error says so", async () => {
    failRename = (from) => from === `${CLIENT}.new` || from === `${CLIENT}.prev`;
    const r = await createWindowsUpdater(env()).run();
    expect(r.clients[0]!.error).toContain(`${CLIENT}.prev could not be put back`);
    expect(leftovers()).toEqual([]);
  });

  test("a new client that does not answer --version is not installed and .new is removed", async () => {
    publishClient("BROKENCLIENT", null);
    const r = await createWindowsUpdater(env()).run();
    expect(r.clients[0]!.status).toBe("failed");
    expect(r.clients[0]!.error).toContain("did not answer --version");
    expect(dec(files.get(CLIENT))).toBe("OLDCLIENT");
    expect(leftovers()).toEqual([]);
  });

  test("a failed client download fails every client and the service still updates", async () => {
    clientSums = `${"0".repeat(64)}  ${WIN_CLIENT_ASSET}\n`;
    const r = await createWindowsUpdater(env()).run();
    expect(r.status).toBe("restarting");
    expect(r.clients[0]!.status).toBe("failed");
    expect(r.clients[0]!.error).toContain("does not match SHA256SUMS");
    expect(dec(files.get(CLIENT))).toBe("OLDCLIENT");
  });

  test("a client that already matches is up-to-date", async () => {
    publishClient("OLDCLIENT", "0.5.0");
    const r = await createWindowsUpdater(env()).run();
    expect(r.clients).toEqual([{ path: CLIENT, status: "up-to-date" }]);
    expect(files.has(`${CLIENT}.prev`)).toBe(false);
  });

  test("clients-only when the service is current and only a client changed", async () => {
    publish("OLD");
    const r = await createWindowsUpdater(env()).run();
    expect(r.status).toBe("clients-only");
    expect(r.clients[0]!.status).toBe("updated");
    expect(dec(files.get(CLIENT))).toBe("NEWCLIENT");
    expect(exits).toBe(0);
  });

  test("up-to-date when nothing changed", async () => {
    publish("OLD");
    publishClient("OLDCLIENT", "0.5.0");
    const r = await createWindowsUpdater(env()).run();
    expect(r).toEqual({ status: "up-to-date", from: "0.5.0", clients: [{ path: CLIENT, status: "up-to-date" }] });
  });

  test("failed (as on Linux) when the service is current and a client failed", async () => {
    publish("OLD");
    failWrite = (p) => p === `${CLIENT}.new`;
    const r = await createWindowsUpdater(env()).run();
    expect(r.status).toBe("failed");
    expect(r.error).toContain("the client update failed");
    expect(r.error).toContain(CLIENT);
    expect(r.clients[0]!.status).toBe("failed");
    expect(leftovers()).toEqual([]);
  });

  test("no clients means no client download", async () => {
    clientPaths = [];
    clientSums = `${"0".repeat(64)}  ${WIN_CLIENT_ASSET}\n`; // would fail if it were checked
    const r = await createWindowsUpdater(env()).run();
    expect(r).toEqual({ status: "restarting", from: "0.5.0", to: "0.5.1", clients: [] });
  });

  test("an old .prev that cannot be removed (EBUSY) does not fail the client", async () => {
    files.set(`${CLIENT}.prev`, enc("ANCIENT"));
    const r = await createWindowsUpdater(env({
      remove: (p) => {
        if (p === `${CLIENT}.prev`) throw new Error("EBUSY");
        files.delete(p);
      },
    })).run();
    expect(r.clients[0]!.status).toBe("updated");
    expect(dec(files.get(CLIENT))).toBe("NEWCLIENT");
    expect(dec(files.get(`${CLIENT}.prev`))).toBe("OLDCLIENT");
  });

  test("a client path that is not named claude-rc.exe is refused and untouched", async () => {
    const odd = "C:\\Windows\\System32\\cmd.exe";
    files.set(odd, enc("CMD"));
    clientPaths = [odd, CLIENT.toUpperCase().replace("CLAUDE-RC.EXE", "Claude-RC.EXE")];
    files.set(clientPaths[1]!, enc("OLDCLIENT"));
    const r = await createWindowsUpdater(env()).run();
    expect(r.clients[0]!.status).toBe("failed");
    expect(r.clients[0]!.error).toContain("is not named claude-rc.exe");
    expect(dec(files.get(odd))).toBe("CMD");
    expect(leftovers()).toEqual([]);
    expect(r.clients[1]!.status).toBe("updated");
  });
});

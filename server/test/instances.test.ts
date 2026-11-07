import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError, InstanceService, type Runner } from "../src/instances";
import { PathError } from "../src/paths";
import { instanceId, renderUnit, unitName } from "../src/unit";
import type { Config } from "../src/config";

let dir: string;
let calls: { cmd: string; args: string[] }[];
let failEnable: boolean;
let failDisable: boolean;
let gate: Promise<void> | null;
let events: string[];

const SHOW = "ActiveState=active\nSubState=running\nActiveEnterTimestamp=@1730887200\n";
let showOverride: string | null = null;
let journalFail = false;
const fake: Runner = async (cmd, args) => {
  calls.push({ cmd, args });
  events.push(args.filter((a) => !a.startsWith("--user")).join(" ") + ((await readdir(dir).catch(() => [])).length ? " [file]" : " [nofile]"));
  if (args.includes("enable") && gate) await gate;
  if (args.includes("disable") && failDisable) return { code: 1, stdout: "", stderr: "nope" };
  if (args.includes("enable") && failEnable) return { code: 1, stdout: "", stderr: "boom" };
  if (args.includes("show")) return { code: 0, stdout: showOverride ?? SHOW, stderr: "" };
  if (cmd === "journalctl" && journalFail) return { code: 1, stdout: "", stderr: "journal boom" };
  if (cmd === "journalctl") return { code: 0, stdout: "log line\n", stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
};

function cfg(over: Partial<Config> = {}): Config {
  return {
    mode: "hub", name: "t", port: 1, host: "h", publicUrl: "http://x", roots: ["/srv"], scope: "system", unitDir: dir,
    serviceUser: "root", serviceHome: "/root", servicePath: "/usr/bin", claudeBin: "/root/.local/bin/claude",
    claudeRcArgs: ["--spawn", "same-dir"], namePrefix: "",
    userAuth: { mode: "oidc", oidc: { issuer: "", clientId: "", clientSecret: "", allowInsecure: false }, sessionSecret: "x".repeat(32) }, ...over,
  };
}
// Windows-safe: any path under /srv resolves to itself; otherwise mimic PathError.
const fakeResolve = async (p: string, roots: string[]) => {
  if (!roots.some((r) => p === r || p.startsWith(r + "/"))) throw new PathError(403, "path outside allowed roots");
  return p;
};
const svc = (over: Partial<Config> = {}) => new InstanceService(cfg(over), fake, fakeResolve);
const sc = (...a: string[]) => ({ cmd: "systemctl", args: a });

async function status(p: Promise<unknown>): Promise<number | string> {
  try { await p; return "ok"; } catch (e) {
    if (e instanceof HttpError || e instanceof PathError) return e.status;
    throw e;
  }
}

beforeEach(async () => {
  showOverride = null;
  journalFail = false;
  dir = await mkdtemp(join(tmpdir(), "inst-"));
  calls = [];
  failEnable = false;
  failDisable = false;
  gate = null;
  events = [];
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("start", () => {
  test("writes unit then daemon-reload then enable --now", async () => {
    const inst = await svc().start({ path: "/srv/proj", name: "my" });
    const id = instanceId("/srv/proj");
    expect(inst).toMatchObject({ id, path: "/srv/proj", name: "my", state: "active" });
    const content = await readFile(join(dir, unitName(id)), "utf8");
    expect(content.startsWith("# managed-by: claude-rc-launcher path=/srv/proj")).toBe(true);
    expect(calls.slice(0, 2)).toEqual([sc("daemon-reload"), sc("enable", "--now", unitName(id))]);
  });
  test("creates missing unitDir", async () => {
    const d = join(dir, "a", "b");
    await svc({ unitDir: d }).start({ path: "/srv/p" });
    expect((await readdir(d)).length).toBe(1);
  });
  test("second start is 409 with existing instance, no second enable", async () => {
    const s = svc();
    await s.start({ path: "/srv/proj" });
    const before = calls.filter((c) => c.args.includes("enable")).length;
    try { await s.start({ path: "/srv/proj" }); throw new Error("no"); } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(409);
      expect(((e as HttpError).extra as { instance: { id: string } }).instance.id).toBe(instanceId("/srv/proj"));
    }
    expect(calls.filter((c) => c.args.includes("enable")).length).toBe(before);
  });
  test("concurrent double start: one success, one 409", async () => {
    const s = svc();
    const r = await Promise.allSettled([s.start({ path: "/srv/proj" }), s.start({ path: "/srv/proj" })]);
    expect(r.filter((x) => x.status === "fulfilled").length).toBe(1);
    const rej = r.filter((x) => x.status === "rejected") as PromiseRejectedResult[];
    expect(rej.length).toBe(1);
    expect(rej[0]!.reason.status).toBe(409);
    expect(calls.filter((c) => c.args.includes("enable")).length).toBe(1);
  });
  test("outside roots 403, bad name 400", async () => {
    expect(await status(svc().start({ path: "/etc" }))).toBe(403);
    expect(await status(svc().start({ path: "/srv/p", name: "bad name" }))).toBe(400);
  });
  test("enable failure removes unit file, reloads, and is 500", async () => {
    failEnable = true;
    try { await svc().start({ path: "/srv/proj" }); throw new Error("no"); } catch (e) {
      expect((e as HttpError).status).toBe(500);
      expect((e as HttpError).message).toContain("boom");
    }
    expect(await readdir(dir)).toEqual([]);
    expect(calls[calls.length - 1]).toEqual(sc("daemon-reload"));
    const id = instanceId("/srv/proj");
    expect(events.slice(-3)).toEqual([
      `enable --now ${unitName(id)} [file]`,
      `disable ${unitName(id)} [file]`,
      "daemon-reload [nofile]",
    ]);
  });
  test("user scope prefixes --user", async () => {
    await svc({ scope: "user" }).start({ path: "/srv/proj" });
    expect(calls.every((c) => c.args[0] === "--user")).toBe(true);
  });
  test.skipIf(process.platform === "win32")("real resolver works with temp dir", async () => {
    const real = new InstanceService(cfg({ roots: [dir] }), fake);
    const proj = join(dir, "proj");
    await mkdir(proj);
    expect((await real.start({ path: proj })).name).toBe("proj");
  });
});

async function seed(path: string, name = "n"): Promise<string> {
  const id = instanceId(path);
  await writeFile(join(dir, unitName(id)), renderUnit(cfg(), path, name));
  return id;
}

describe("list", () => {
  test("only managed claude-rc-*.service files, with state mapping", async () => {
    const id = await seed("/srv/a", "alpha");
    await writeFile(join(dir, "other.service"), renderUnit(cfg(), "/srv/b", "x"));
    await writeFile(join(dir, "claude-rc-abcdef012345.service"), "[Unit]\n");
    await writeFile(join(dir, `claude-rc-${id}.txt`), renderUnit(cfg(), "/srv/c", "x"));
    const l = await svc().list();
    expect(l).toEqual([{ id, path: "/srv/a", name: "alpha", state: "active", startedAt: "2024-11-06T10:00:00.000Z" }]);
    expect(calls).toEqual([sc("show", "--timestamp=unix", "-p", "ActiveState,SubState,ActiveEnterTimestamp", unitName(id))]);
  });
  test("garbage or empty timestamp -> null", async () => {
    const id = await seed("/srv/a", "alpha");
    for (const v of ["Thu 2026-11-06 10:00:00 UTC", "", "@abc", "@"]) {
      showOverride = `ActiveState=inactive\nActiveEnterTimestamp=${v}\n`;
      expect((await svc().list())[0]!.startedAt).toBeNull();
    }
    showOverride = "ActiveState=active\nActiveEnterTimestamp=@0\n";
    expect((await svc().list())[0]!.startedAt).toBeNull();
  });
  test("missing unitDir is empty", async () => {
    expect(await svc({ unitDir: join(dir, "nope") }).list()).toEqual([]);
  });
});

describe("stop", () => {
  test("disable --now, delete file, daemon-reload", async () => {
    const id = await seed("/srv/a");
    await svc().stop(id);
    expect(calls).toEqual([sc("disable", "--now", unitName(id)), sc("daemon-reload")]);
    expect(await readdir(dir)).toEqual([]);
  });
  test("failed disable is 500, keeps the unit file, no reload", async () => {
    const id = await seed("/srv/a");
    failDisable = true;
    try { await svc().stop(id); throw new Error("no"); } catch (e) {
      expect((e as HttpError).status).toBe(500);
      expect((e as HttpError).message).toContain("nope");
    }
    expect(await readdir(dir)).toEqual([unitName(id)]);
    expect(calls).toEqual([sc("disable", "--now", unitName(id))]);
  });
  test("stop during in-flight start is 409 and never disables", async () => {
    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    const s = svc();
    const id = instanceId("/srv/proj");
    const started = s.start({ path: "/srv/proj" });
    while (!calls.some((c) => c.args.includes("enable"))) await new Promise((r) => setTimeout(r, 1));
    expect(await status(s.stop(id))).toBe(409);
    expect(calls.some((c) => c.args.includes("disable"))).toBe(false);
    release();
    await started;
    expect(await readdir(dir)).toEqual([unitName(id)]);
  });
  test("unmanaged ids are 404 with runner untouched", async () => {
    const bare = "abcdef012345";
    await writeFile(join(dir, unitName(bare)), "[Unit]\nDescription=not ours\n");
    expect(await status(svc().stop("../../etc/passwd"))).toBe(404);
    expect(await status(svc().stop("0123456789ab"))).toBe(404);
    expect(await status(svc().stop(bare))).toBe(404);
    expect(await status(svc().logs(bare, 10))).toBe(404);
    expect(await status(svc().logs("0123456789ab", 10))).toBe(404);
    expect(calls).toEqual([]);
    expect(await readdir(dir)).toEqual([unitName(bare)]);
  });
});

describe("logs", () => {
  test("journalctl failure -> 500 with stderr", async () => {
    const id = await seed("/srv/a");
    journalFail = true;
    try {
      await svc().logs(id, 10);
      throw new Error("no throw");
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(500);
      expect((e as HttpError).message).toContain("journal boom");
    }
  });
  test("journalctl args, clamped lines, user scope", async () => {
    const id = await seed("/srv/a");
    expect(await svc({ scope: "user" }).logs(id, 9999)).toBe("log line\n");
    await svc().logs(id, 0);
    expect(calls[0]).toEqual({ cmd: "journalctl", args: ["--user", "-u", unitName(id), "-n", "500", "--no-pager", "-o", "cat"] });
    expect(calls[1]!.args).toEqual(["-u", unitName(id), "-n", "1", "--no-pager", "-o", "cat"]);
  });
});

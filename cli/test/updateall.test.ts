import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExitError, LOGIN_MESSAGE } from "../src/creds";
import { HubError, type HubClient } from "../src/hub";
import { sanitizeLine } from "../src/format";
import { main } from "../src/index";
import type { Sys } from "../src/nodesetup";
import { updateAll } from "../src/updateall";
import { VERSION } from "../../server/src/version";

const EXE = "/usr/local/bin/claude-rc";
const ASSET = "claude-rc-linux-x64";
const RELEASE = "https://github.com/kbirger/claude-rc-launcher/releases";
const BIN = new TextEncoder().encode("#!client");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const TOO_OLD = "cannot update remotely (node too old: run claude-rc node update on it once)";

type Report = { status: "restarting" | "up-to-date" | "clients-only" | "failed"; from: string; to?: string; clients: { path: string; status: string; from?: string; to?: string; error?: string }[]; error?: string };
type Host = { id: string; name: string; status: "ok" | "offline" | "error"; error?: string; version?: string };
/** What one machine does: its update answer (or an error to throw) and the versions its GET /node answers in turn. */
type Node = { update?: Report | Error; versions?: (string | Error)[] };

/** A fake Sys with a clock: `sleep` advances `now`. The local client is already current unless `clientNew` is set. */
function fakeSys(o: { clientNew?: boolean } = {}) {
  let t = 0;
  const calls: string[] = [];
  const current = o.clientNew ? new TextEncoder().encode("#!old") : BIN;
  const sys: Sys = {
    platform: "linux",
    arch: "x64",
    execPath: EXE,
    isRoot: () => false,
    hasCommand: () => true,
    localAddresses: () => [],
    exists: () => true,
    writable: () => true,
    run(args) {
      calls.push(`run ${args.join(" ")}`);
      if (args[0] === EXE && args[1] === "--version") return { code: 0, stdout: "claude-rc 9.9.9\n" };
      return { code: 0, stdout: "" };
    },
    sudo: (args) => (calls.push(`sudo ${args.join(" ")}`), { code: 0, stdout: "", stderr: "" }),
    readFile: (p) => (p === EXE ? current : new Uint8Array()),
    writeTemp: (name) => `/tmp/fake/${name}`,
    removeTemp: () => {},
    fetch: (async (url: string | URL) => {
      const u = String(url);
      calls.push(`fetch ${u}`);
      if (u.endsWith("/SHA256SUMS")) return new Response(`${sha(BIN)}  ${ASSET}\n`);
      if (u.endsWith(`/${ASSET}`)) return new Response(BIN);
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch,
    sleep: async (ms) => void (t += ms),
    now: () => t,
  };
  return { sys, calls, now: () => t };
}

type Call = { method: string; path: string; body?: unknown; timeoutMs?: number };

function fakeHub(hosts: Host[], nodes: Record<string, Node>) {
  const calls: Call[] = [];
  const polls: Record<string, number> = {};
  const hub = {
    async request(method: string, p: string, body?: unknown, opts?: { timeoutMs?: number }) {
      calls.push({ method, path: p, ...(body !== undefined ? { body } : {}), ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
      if (method === "GET" && p === "/cli/api/hosts") return hosts;
      const m = /^\/cli\/api\/hosts\/([^/]+)\/(node|update)$/.exec(p);
      if (!m) throw new HubError(`no route ${p}`, 404, undefined);
      const id = decodeURIComponent(m[1]!);
      const node = nodes[id] ?? {};
      if (m[2] === "update") {
        if (node.update instanceof Error) throw node.update;
        return node.update;
      }
      const list = node.versions ?? [];
      const i = polls[id] ?? 0;
      polls[id] = i + 1;
      const v = list[Math.min(i, list.length - 1)];
      if (v === undefined) throw new ExitError("cannot reach hub: connection refused", 1);
      if (v instanceof Error) throw v;
      return { ok: true, name: id, version: v };
    },
  };
  return { hub: hub as unknown as HubClient, calls };
}

const restarting = (from: string, to: string, clients: Report["clients"] = []): Report => ({ status: "restarting", from, to, clients });
const upToDate = (v: string): Report => ({ status: "up-to-date", from: v, clients: [{ path: "/usr/local/bin/claude-rc", status: "up-to-date" }] });
const host = (id: string, version = "1.0.0", status: Host["status"] = "ok"): Host => ({ id, name: id, status, version });

async function run(hosts: Host[], nodes: Record<string, Node>, flags: Record<string, unknown> = {}, sysOpts: { clientNew?: boolean } = {}) {
  const h = fakeHub(hosts, nodes);
  const s = fakeSys(sysOpts);
  const out: string[] = [];
  let error: ExitError | undefined;
  try {
    await updateAll({ flags: { "all-nodes": true, ...flags } as any, hub: h.hub, out: (x) => out.push(x), sys: s.sys });
  } catch (e) {
    if (!(e instanceof ExitError)) throw e;
    error = e;
  }
  const text = out.join("\n");
  const row = (name: string) => text.split("\n").find((l) => l.startsWith(`${name} `)) ?? "";
  return { ...h, sys: s, out, text, error, row };
}

const ALL = [host("local"), host("a"), host("b")];
const GOOD = { a: { update: restarting("1.0.0", "2.0.0"), versions: ["2.0.0"] }, b: { update: restarting("1.0.0", "2.0.0"), versions: ["2.0.0"] }, local: { update: restarting("1.0.0", "2.0.0"), versions: ["2.0.0"] } };

describe("updateAll", () => {
  test("all machines updated: remote hosts in list order, then local, then the local client", async () => {
    const r = await run(ALL, GOOD);
    expect(r.error).toBeUndefined();
    const posts = r.calls.filter((c) => c.method === "POST").map((c) => c.path);
    expect(posts).toEqual(["/cli/api/hosts/a/update", "/cli/api/hosts/b/update", "/cli/api/hosts/local/update"]);
    // The client runs after the last hub call.
    expect(r.sys.calls.some((c) => c.startsWith("fetch"))).toBe(true);
    for (const id of ["a", "b", "local"]) {
      expect(r.row(id)).toContain("1.0.0");
      expect(r.row(id)).toContain("2.0.0");
      expect(r.row(id)).toMatch(/updated$/);
    }
    expect(r.text).toContain(EXE);
  });

  test("the update call waits at least 190 seconds; the polls are short", async () => {
    const r = await run(ALL, GOOD);
    for (const c of r.calls.filter((c) => c.method === "POST")) expect(c.timeoutMs!).toBeGreaterThanOrEqual(190_000);
    for (const c of r.calls.filter((c) => c.path.endsWith("/node"))) expect(c.timeoutMs!).toBeLessThanOrEqual(10_000);
  });

  test("an offline host is skipped and the others still run", async () => {
    const r = await run([host("local"), host("a", "1.0.0", "offline"), host("b")], GOOD);
    expect(r.calls.some((c) => c.path.startsWith("/cli/api/hosts/a/"))).toBe(false);
    expect(r.row("a")).toContain("skipped (offline)");
    expect(r.row("b")).toMatch(/updated$/);
    expect(r.row("local")).toMatch(/updated$/);
    expect(r.error?.code).toBe(1);
  });

  test("a 404 from POST update says the node cannot be updated remotely and names node update", async () => {
    const r = await run(ALL, { ...GOOD, a: { update: new HubError("not found", 404, { error: "not found" }) } });
    expect(r.row("a")).toContain(TOO_OLD);
    expect(r.row("a")).toContain("claude-rc node update");
    expect(r.row("b")).toMatch(/updated$/);
    expect(r.error?.code).toBe(1);
  });

  test("another error from POST update is failed (<message>) and the others still run", async () => {
    const r = await run(ALL, { ...GOOD, a: { update: new HubError("another update is running on this machine", 409, {}) } });
    expect(r.row("a")).toContain("failed (another update is running on this machine)");
    expect(r.row("b")).toMatch(/updated$/);
    expect(r.row("local")).toMatch(/updated$/);
    expect(r.error?.code).toBe(1);
  });

  test("a failed report is failed (<error>)", async () => {
    const r = await run(ALL, { ...GOOD, a: { update: { status: "failed", from: "1.0.0", clients: [], error: "checksum mismatch" } } });
    expect(r.row("a")).toContain("failed (checksum mismatch)");
  });

  test("a machine that never answers within 90 seconds is no answer", async () => {
    const r = await run(ALL, { ...GOOD, a: { update: restarting("1.0.0", "2.0.0"), versions: [] } });
    expect(r.row("a")).toContain("no answer");
    const polls = r.calls.filter((c) => c.path === "/cli/api/hosts/a/node").length;
    expect(polls).toBeGreaterThanOrEqual(44);
    expect(polls).toBeLessThanOrEqual(47);
    expect(r.row("b")).toMatch(/updated$/);
    expect(r.text).toContain("journalctl -u claude-rc-launcher");
  });

  test("connection errors during the restart are not failures", async () => {
    const down = new ExitError("cannot reach hub: connection refused", 1);
    const r = await run(ALL, { ...GOOD, local: { update: restarting("1.0.0", "2.0.0"), versions: ["1.0.0", down, down, new HubError("bad gateway", 502, {}), "2.0.0"] } });
    expect(r.row("local")).toMatch(/updated$/);
    expect(r.error).toBeUndefined();
  });

  test("a version that is unchanged after a restart report is rolled back", async () => {
    const r = await run(ALL, { ...GOOD, a: { update: restarting("1.0.0", "2.0.0"), versions: ["1.0.0", new ExitError("cannot reach hub: down", 1), "1.0.0"] } });
    expect(r.row("a")).toContain("rolled back");
    expect(r.row("a")).not.toContain("2.0.0");
    expect(r.error?.code).toBe(1);
  });

  test("up-to-date does not poll", async () => {
    const r = await run(ALL, { ...GOOD, a: { update: upToDate("1.0.0") } });
    expect(r.calls.some((c) => c.path === "/cli/api/hosts/a/node")).toBe(false);
    expect(r.row("a")).toMatch(/up-to-date$/);
  });

  test("clients-only does not poll and is updated with the client paths", async () => {
    const r = await run(ALL, { ...GOOD, a: { update: { status: "clients-only", from: "1.0.0", clients: [{ path: "/opt/bin/claude-rc", status: "updated", from: "0.9.0", to: "1.0.0" }] } } });
    expect(r.calls.some((c) => c.path === "/cli/api/hosts/a/node")).toBe(false);
    expect(r.row("a")).toContain("/opt/bin/claude-rc");
    expect(r.row("a")).toMatch(/updated$/);
  });

  test("a failed client makes the row failed even when the service updated", async () => {
    const clients = [{ path: "/opt/bin/claude-rc", status: "failed", error: "permission denied" }];
    const r = await run(ALL, {
      ...GOOD,
      a: { update: restarting("1.0.0", "2.0.0", clients), versions: ["2.0.0"] },
      b: { update: { status: "clients-only", from: "1.0.0", clients: [...clients, { path: "/usr/bin/claude-rc", status: "updated" }] } },
    });
    expect(r.row("a")).toContain("failed (/opt/bin/claude-rc: permission denied)");
    expect(r.row("b")).toContain("failed (/opt/bin/claude-rc: permission denied)");
    expect(r.error?.code).toBe(1);
    expect(r.error?.message).toBe("2 of 4 machines were not updated");
  });

  test("the hub (local) is updated after every remote host, even when it is listed first", async () => {
    const r = await run([host("local"), host("z"), host("a")], { ...GOOD, z: GOOD.a });
    const posts = r.calls.filter((c) => c.method === "POST").map((c) => c.path);
    expect(posts.at(-1)).toBe("/cli/api/hosts/local/update");
    expect(posts).toEqual(["/cli/api/hosts/z/update", "/cli/api/hosts/a/update", "/cli/api/hosts/local/update"]);
    const lastLocal = r.calls.findLastIndex((c) => c.path.startsWith("/cli/api/hosts/local/"));
    const lastRemote = r.calls.findLastIndex((c) => /\/hosts\/(a|z)\//.test(c.path));
    expect(lastLocal).toBeGreaterThan(lastRemote);
  });

  test("all good rows give no error; any failed row gives ExitError 1", async () => {
    expect((await run(ALL, GOOD)).error).toBeUndefined();
    const bad = await run(ALL, { ...GOOD, b: { update: new HubError("boom", 500, {}) } });
    expect(bad.error).toBeInstanceOf(ExitError);
    expect(bad.error?.code).toBe(1);
    expect(bad.error?.message).toBe("1 of 4 machines were not updated");
    // The table is printed before the error.
    expect(bad.row("b")).toContain("failed (boom)");
  });

  test("a failed local client update is a failed row", async () => {
    const h = fakeHub(ALL, GOOD);
    const s = fakeSys();
    s.sys.execPath = "/home/me/src/bun";
    const out: string[] = [];
    const e = await updateAll({ flags: { "all-nodes": true } as any, hub: h.hub, out: (x) => out.push(x), sys: s.sys }).then(() => undefined, (e) => e);
    expect(e?.code).toBe(1);
    expect(out.join("\n")).toContain("failed (claude-rc update works on the installed binary only");
  });

  test("--binary with --all-nodes is an error before any request", async () => {
    const r = await run(ALL, GOOD, { binary: "/tmp/x" });
    expect(r.calls).toEqual([]);
    expect(r.error?.code).toBe(1);
    expect(r.error?.message).toContain("--binary");
  });

  test("--release is passed to every machine and to the local client", async () => {
    const r = await run(ALL, GOOD, { release: "v1.2.3" });
    for (const c of r.calls.filter((c) => c.method === "POST")) expect(c.body).toEqual({ release: "v1.2.3" });
    expect(r.sys.calls).toContain(`fetch ${RELEASE}/download/v1.2.3/${ASSET}`);
  });

  test.each([[""], ["latest"], ["1.2"]])("a bad --release %p is an error before any request", async (rel) => {
    const r = await run(ALL, GOOD, { release: rel });
    expect(r.calls).toEqual([]);
    expect(r.sys.calls).toEqual([]);
    expect(r.error?.code).toBe(1);
    expect(r.error?.message).toContain("--release");
  });

  test("without --release the update body is empty", async () => {
    const r = await run(ALL, GOOD);
    for (const c of r.calls.filter((c) => c.method === "POST")) expect(c.body).toEqual({});
  });

  test("a second run in which every machine is up-to-date succeeds", async () => {
    const r = await run([host("local", "2.0.0"), host("a", "2.0.0"), host("b", "2.0.0")], { a: { update: upToDate("2.0.0") }, b: { update: upToDate("2.0.0") }, local: { update: upToDate("2.0.0") } });
    expect(r.error).toBeUndefined();
    for (const id of ["a", "b", "local"]) expect(r.row(id)).toMatch(/up-to-date$/);
    expect(r.calls.some((c) => c.path.endsWith("/node"))).toBe(false);
    expect(r.text).toContain(VERSION);
  });

  test("--json prints the rows as JSON", async () => {
    const r = await run(ALL, GOOD, { json: true });
    const rows = JSON.parse(r.out.at(-1)!);
    expect(rows.map((x: { machine: string }) => x.machine)).toEqual(["a", "b", "local", "client"]);
    expect(rows[0].status).toBe("updated");
  });
});

describe("index: update --all-nodes", () => {
  const env = () => ({ credsFile: path.join(mkdtempSync(path.join(os.tmpdir(), "rc-ua-")), "credentials.json"), open: async () => {}, readLine: async () => "" });

  test("without a login it gives the login message (exit 2)", async () => {
    const err: string[] = [];
    const code = await main(["update", "--all-nodes"], { out: () => {}, err: (s) => err.push(s) }, env());
    expect(code).toBe(2);
    expect(err.join("\n")).toBe(LOGIN_MESSAGE);
  });

  test("--binary with --all-nodes is an error before the login check", async () => {
    const err: string[] = [];
    const code = await main(["update", "--all-nodes", "--binary", "/tmp/x"], { out: () => {}, err: (s) => err.push(s) }, env());
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("--binary");
  });

  test("update without --all-nodes still needs no login", async () => {
    const s = fakeSys();
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["update"], { out: (x) => out.push(x), err: (x) => err.push(x) }, { ...env(), sys: s.sys });
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(out.at(-1)).toBe(`claude-rc is already up to date (${VERSION})`);
  });
});

/** A fake event stream. Each open takes the next script: events to send, or an Error to fail the open. */
type Script = ({ event: string; data: string } | "end")[] | Error;
type Ev = { host: string; line: string };
const logEv = (host: string, line: string) => ({ event: "log", data: JSON.stringify({ host, line, at: 1 }) });

async function runLive(opts: { scripts: Script[]; onPost?: Record<string, Ev[]>; json?: boolean; nodes?: Record<string, Node>; streamDelayMs?: number }) {
  const h = fakeHub(ALL, opts.nodes ?? GOOD);
  const s = fakeSys();
  const events: string[] = [];
  // The 3 s wait for the stream is real here (short), so a stream that answers late wins the race. Other sleeps are instant.
  const baseSleep = s.sys.sleep;
  s.sys.sleep = async (ms) => (ms === 3000 ? void (await new Promise((r) => setTimeout(r, 300))) : baseSleep(ms));
  const out: string[] = [];
  const err: string[] = [];
  const opens: { aborted: () => boolean }[] = [];
  const queues: ((ev: { event: string; data: string } | "end") => void)[] = [];
  const hubAny = h.hub as any;
  const baseRequest = hubAny.request.bind(hubAny);
  hubAny.request = async (method: string, p: string, ...rest: unknown[]) => {
    if (method === "POST") events.push(`post ${p}`);
    const r = await baseRequest(method, p, ...rest);
    const m = /^\/cli\/api\/hosts\/([^/]+)\/update$/.exec(p);
    if (m && method === "POST") {
      for (const e of opts.onPost?.[m[1]!] ?? []) queues.at(-1)?.(logEv(e.host, e.line));
      await new Promise((r) => setTimeout(r, 5));
    }
    return r;
  };
  let n = 0;
  hubAny.stream = (path: string, o?: { signal?: AbortSignal }) => {
    const script = opts.scripts[Math.min(n++, opts.scripts.length - 1)]!;
    opens.push({ aborted: () => !!o?.signal?.aborted });
    const pending: ({ event: string; data: string } | "end")[] = [];
    let wake: (() => void) | undefined;
    if (!(script instanceof Error)) queues.push((ev) => (pending.push(ev), wake?.()));
    return (async function* () {
      if (script instanceof Error) throw script;
      if (n === 1 && opts.streamDelayMs) await new Promise((r) => setTimeout(r, opts.streamDelayMs));
      for (const e of script) {
        if (e === "end") return;
        events.push("stream event");
        yield e;
      }
      if (script.length === 0) events.push("stream event");
      // Stay open and deliver what onPost pushes, until the signal aborts.
      const aborted = new Promise<void>((res) => o?.signal?.addEventListener("abort", () => res()));
      for (;;) {
        if (o?.signal?.aborted) return;
        const ev = pending.shift();
        if (ev === "end") return;
        if (ev) {
          yield ev;
          continue;
        }
        await Promise.race([new Promise<void>((res) => (wake = res)), aborted]);
      }
    })();
  };
  let error: ExitError | undefined;
  try {
    await updateAll({ flags: { "all-nodes": true, ...(opts.json ? { json: true } : {}) } as any, hub: h.hub, out: (x) => out.push(x), err: (x) => err.push(x), sys: s.sys });
  } catch (e) {
    if (!(e instanceof ExitError)) throw e;
    error = e;
  }
  return { ...h, out, err, error, opens, events, count: () => n };
}

describe("updateAll live output", () => {
  const lines = { a: [{ host: "a", line: "downloading" }, { host: "a", line: "installing" }], b: [{ host: "b", line: "verifying" }], local: [{ host: "local", line: "restarting" }] };

  test("prints each log line as [host] line, in order; the snapshot and other hosts are ignored", async () => {
    const snap = { event: "snapshot", data: JSON.stringify({ updates: [], logs: { a: [{ line: "OLD", at: 0 }] }, presence: [] }) };
    const r = await runLive({ scripts: [[snap, logEv("zzz", "not updated")]], onPost: lines });
    expect(r.error).toBeUndefined();
    const live = r.out.filter((l) => /^\[(a|b|local)\] /.test(l));
    expect(live).toEqual(["[a] downloading", "[a] installing", "[b] verifying", "[local] restarting"]);
    expect(r.out.join("\n")).not.toContain("OLD");
    expect(r.out.join("\n")).toContain("MACHINE");
    expect(r.err).toEqual([]);
    expect(r.opens[0]!.aborted()).toBe(true);
  });

  test("the first stream event is delivered before the first update starts", async () => {
    const snap = { event: "snapshot", data: JSON.stringify({ updates: [], logs: {}, presence: [] }) };
    const r = await runLive({ scripts: [[snap]], onPost: lines, streamDelayMs: 40 });
    expect(r.events[0]).toBe("stream event");
    expect(r.events.indexOf("stream event")).toBeLessThan(r.events.findIndex((e) => e.startsWith("post ")));
    expect(r.calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/cli/api/hosts/a/update", "/cli/api/hosts/b/update", "/cli/api/hosts/local/update"]);
  });

  test("with --json the lines go to standard error and the result stays on standard output", async () => {
    const r = await runLive({ scripts: [[]], onPost: lines, json: true });
    expect(r.err).toEqual(["[a] downloading", "[a] installing", "[b] verifying", "[local] restarting"]);
    expect(r.out.some((l) => /^\[(a|b|local)\] /.test(l))).toBe(false);
    expect(JSON.parse(r.out.join("\n")).map((x: { machine: string }) => x.machine)).toEqual(["a", "b", "local", "client"]);
  });

  test("a stream that cannot be opened changes nothing", async () => {
    const r = await runLive({ scripts: [new HubError("HTTP 404", 404, undefined)], onPost: lines });
    expect(r.error).toBeUndefined();
    expect(r.out.some((l) => /^\[(a|b|local)\] /.test(l))).toBe(false);
    expect(r.out.join("\n")).toContain("MACHINE");
    expect(r.calls.filter((c) => c.method === "POST")).toHaveLength(3);
    expect(r.count()).toBe(1);
    expect(r.err).toEqual([]);
    expect(r.out.join("\n")).not.toMatch(/stream|HTTP 404|events/i);
    expect(r.out.filter((l) => !/^updating /.test(l) && !/^(MACHINE|a |b |local |client )/.test(l) && l.split("\n").every((x) => !/^(MACHINE|a |b |local |client )/.test(x)))).toEqual([]);
  });

  test("a failing machine gives the same exit code and table with a failing stream as with a working one", async () => {
    const nodes = { ...GOOD, a: { update: new HubError("boom", 500, {}) } };
    const good = await runLive({ scripts: [[]], nodes });
    const bad = await runLive({ scripts: [new HubError("HTTP 500", 500, undefined)], nodes });
    expect(bad.error?.code).toBe(good.error?.code);
    expect(bad.error?.message).toBe(good.error?.message);
    const table = (o: string[]) => o.filter((l) => !/^updating /.test(l) && !/^\[/.test(l));
    expect(table(bad.out)).toEqual(table(good.out));
    expect(bad.err).toEqual([]);
  });

  test("a stream that ends is reopened, and lines after the reopen appear", async () => {
    const r = await runLive({ scripts: [[logEv("a", "first"), "end"], []], onPost: { local: [{ host: "local", line: "after restart" }] } });
    expect(r.count()).toBe(2);
    // "first" came before any update started, so it is not printed.
    expect(r.out.filter((l) => /^\[(a|b|local)\] /.test(l))).toEqual(["[local] after restart"]);
    expect(r.error).toBeUndefined();
  });

  test("a stream that keeps failing after it opened gives up silently", async () => {
    const r = await runLive({ scripts: [[logEv("a", "first"), "end"], new Error("down")], onPost: lines });
    expect(r.error).toBeUndefined();
    expect(r.count()).toBeLessThanOrEqual(50);
    expect(r.out.join("\n")).toContain("MACHINE");
  });
});

describe("updateAll live output: safety and scope", () => {
  const live = (r: { out: string[] }) => r.out.filter((l) => /^\[(a|b|local)\] /.test(l));

  test("sanitizeLine replaces control characters except tab and caps the length", () => {
    expect(sanitizeLine("a\tb")).toBe("a\tb");
    expect(sanitizeLine("x\u001b[2Jy\u001b]0;title\u0007z\rq\bw\u007f\u0085\u009f\n")).toBe("x?[2Jy?]0;title?z?q?w???" + "?");
    expect(sanitizeLine("é ü 日本")).toBe("é ü 日本");
    expect(sanitizeLine("x".repeat(5000))).toHaveLength(500);
  });

  test("escape sequences, carriage returns, backspaces and bells from a node are not printed", async () => {
    const evil = "ok\u001b[2J\u001b]0;pwned\u0007\u001b]52;c;QQ==\u001b\\\rfake [a] updated\b\bX";
    const r = await runLive({ scripts: [[]], onPost: { a: [{ host: "a", line: evil }] } });
    const printed = live(r).join("\n");
    expect(printed).toContain("[a] ok");
    for (const bad of ["\u001b", "\r", "\b", "\u0007"]) expect(r.out.join("\n")).not.toContain(bad);
  });

  test("a line of 5000 characters is capped", async () => {
    const r = await runLive({ scripts: [[]], onPost: { a: [{ host: "a", line: "y".repeat(5000) }] } });
    expect(live(r)[0]!.length).toBeLessThanOrEqual("[a] ".length + 500);
    expect(live(r)[0]!.length).toBeGreaterThan(400);
  });

  test("only the machine being updated now prints: later hosts and finished hosts are ignored", async () => {
    const r = await runLive({
      scripts: [[]],
      onPost: {
        a: [{ host: "b", line: "web update of b" }, { host: "local", line: "later" }, { host: "a", line: "mine a" }],
        b: [{ host: "a", line: "finished a" }, { host: "b", line: "mine b" }],
        local: [{ host: "a", line: "replayed a" }, { host: "b", line: "replayed b" }, { host: "local", line: "mine local" }],
      },
    });
    expect(live(r)).toEqual(["[a] mine a", "[b] mine b", "[local] mine local"]);
  });

  test("nothing prints while a machine is not being updated (before the first update, for the client)", async () => {
    const r = await runLive({ scripts: [[logEv("a", "early"), "end"], []], onPost: {} });
    expect(live(r)).toEqual([]);
  });

  test("a hub that is down for 60 seconds still gets its stream reopened", async () => {
    const down = Array.from({ length: 30 }, () => new Error("down"));
    const r = await runLive({ scripts: [[logEv("a", "x"), "end"], ...down, []], onPost: { local: [{ host: "local", line: "after restart" }] } });
    expect(r.count()).toBe(32);
    expect(live(r)).toEqual(["[local] after restart"]);
  });
});

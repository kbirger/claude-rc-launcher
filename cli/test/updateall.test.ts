import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExitError, LOGIN_MESSAGE } from "../src/creds";
import { HubError, type HubClient } from "../src/hub";
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

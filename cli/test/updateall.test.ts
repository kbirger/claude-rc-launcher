import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { VERSION } from "../../server/src/shared/version";
import { ExitError, LOGIN_MESSAGE } from "../src/creds";
import { sanitizeLine } from "../src/format";
import { HubError } from "../src/hub";
import type { HubClient } from "../src/hub";
import { main } from "../src/index";
import type { Sys } from "../src/nodesetup";
import { updateAll, updateNodes, watchLogs } from "../src/updateall";
import { defined } from "./support";

const EXE = "/usr/local/bin/claude-rc";
const ASSET = "claude-rc-linux-x64";
const RELEASE = "https://github.com/kbirger/claude-rc-launcher/releases";
const BIN = new TextEncoder().encode("#!client");
const sha = (uint8Array: Uint8Array) => createHash("sha256").update(uint8Array).digest("hex");
const TOO_OLD = "cannot update remotely (node too old: run claude-rc node update on it once)";

interface Report {
  status: "restarting" | "up-to-date" | "clients-only" | "failed";
  from: string;
  to?: string;
  clients: { path: string; status: string; from?: string; to?: string; error?: string }[];
  error?: string;
}
interface Host {
  id: string;
  name: string;
  status: "ok" | "offline" | "error";
  error?: string;
  version?: string;
}
/** What one machine does: its update answer (or an error to throw) and the versions its GET /node answers in turn. */
interface Node {
  update?: Report | Error;
  versions?: (string | Error)[];
}

/** A fake Sys with a clock: `sleep` advances `now`. The local client is already current unless `clientNew` is set. */
function fakeSys(options: { clientNew?: boolean } = {}) {
  let count = 0;
  const calls: string[] = [];
  const current = options.clientNew ? new TextEncoder().encode("#!old") : BIN;
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
    readFile: (file) => (file === EXE ? current : new Uint8Array()),
    writeTemp: (name) => `/tmp/fake/${name}`,
    removeTemp: () => {},
    fetch: ((url: string | URL) => {
      const text = String(url);
      calls.push(`fetch ${text}`);
      if (text.endsWith("/SHA256SUMS")) return Promise.resolve(new Response(`${sha(BIN)}  ${ASSET}\n`));
      if (text.endsWith(`/${ASSET}`)) return Promise.resolve(new Response(BIN));
      return Promise.resolve(new Response("nope", { status: 404 }));
    }) as unknown as typeof fetch,
    sleep: (ms) => Promise.resolve(void (count += ms)),
    now: () => count,
  };
  return { sys, calls, now: () => count };
}

interface Call {
  method: string;
  path: string;
  body?: unknown;
  timeoutMs?: number;
}

function fakeHub(hosts: Host[], nodes: Record<string, Node>) {
  const calls: Call[] = [];
  const polls: Record<string, number> = {};
  const hub = {
    request(method: string, item: string, body?: unknown, opts?: { timeoutMs?: number }) {
      calls.push({
        method,
        path: item,
        ...(body !== undefined ? { body } : {}),
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
      if (method === "GET" && item === "/cli/api/hosts") return Promise.resolve(hosts);
      const match = /^\/cli\/api\/hosts\/([^/]+)\/(node|update)$/.exec(item);
      if (!match) return Promise.reject(new HubError(`no route ${item}`, 404, undefined));
      const id = decodeURIComponent(match[1]);
      const node = nodes[id] ?? {};

      if (match[2] === "update") {
        if (node.update instanceof Error) return Promise.reject(node.update);
        return Promise.resolve(node.update);
      }

      const list = node.versions ?? [];
      const value = polls[id] ?? 0;
      polls[id] = value + 1;
      const error = list[Math.min(value, list.length - 1)];
      if (error === undefined) return Promise.reject(new ExitError("cannot reach hub: connection refused", 1));
      if (error instanceof Error) return Promise.reject(error);
      return Promise.resolve({ ok: true, name: id, version: error });
    },
  };
  return { hub: hub as unknown as HubClient, calls };
}

const restarting = (from: string, to: string, clients: Report["clients"] = []): Report => ({
  status: "restarting",
  from,
  to,
  clients,
});
const upToDate = (value: string): Report => ({
  status: "up-to-date",
  from: value,
  clients: [{ path: "/usr/local/bin/claude-rc", status: "up-to-date" }],
});
const host = (id: string, version = "1.0.0", status: Host["status"] = "ok"): Host => ({
  id,
  name: id,
  status,
  version,
});

async function run(
  hosts: Host[],
  nodes: Record<string, Node>,
  flags: Record<string, unknown> = {},
  sysOpts: { clientNew?: boolean } = {},
) {
  const hub = fakeHub(hosts, nodes);
  const sys = fakeSys(sysOpts);
  const out: string[] = [];
  let error: ExitError | undefined;

  try {
    await updateAll({
      flags: { "all-nodes": true, ...flags },
      hub: hub.hub,
      out: (line) => out.push(line),
      sys: sys.sys,
    });
  } catch (caught) {
    if (!(caught instanceof ExitError)) throw caught;
    error = caught;
  }

  const text = out.join("\n");
  const row = (name: string) => text.split("\n").find((part) => part.startsWith(`${name} `)) ?? "";
  return { ...hub, sys: sys, out, text, error, row };
}

const ALL = [host("local"), host("alpha"), host("beta")];
const GOOD = {
  alpha: { update: restarting("1.0.0", "2.0.0"), versions: ["2.0.0"] },
  beta: { update: restarting("1.0.0", "2.0.0"), versions: ["2.0.0"] },
  local: { update: restarting("1.0.0", "2.0.0"), versions: ["2.0.0"] },
};

describe("updateAll", () => {
  test("all machines updated: remote hosts in list order, then local, then the local client", async () => {
    const outcome = await run(ALL, GOOD);
    expect(outcome.error).toBeUndefined();
    const posts = outcome.calls.filter((call) => call.method === "POST").map((call) => call.path);
    expect(posts).toEqual(["/cli/api/hosts/alpha/update", "/cli/api/hosts/beta/update", "/cli/api/hosts/local/update"]);
    // The client runs after the last hub call.
    expect(outcome.sys.calls.some((call) => call.startsWith("fetch"))).toBe(true);

    for (const id of ["alpha", "beta", "local"]) {
      expect(outcome.row(id)).toContain("1.0.0");
      expect(outcome.row(id)).toContain("2.0.0");
      expect(outcome.row(id)).toMatch(/updated$/);
    }

    expect(outcome.text).toContain(EXE);
  });

  test("the update call waits at least 190 seconds; the polls are short", async () => {
    const outcome = await run(ALL, GOOD);
    for (const call of outcome.calls.filter((item) => item.method === "POST"))
      expect(defined(call.timeoutMs)).toBeGreaterThanOrEqual(190_000);
    for (const call of outcome.calls.filter((item) => item.path.endsWith("/node")))
      expect(defined(call.timeoutMs)).toBeLessThanOrEqual(10_000);
  });

  test("an offline host is skipped and the others still run", async () => {
    const outcome = await run([host("local"), host("alpha", "1.0.0", "offline"), host("beta")], GOOD);
    expect(outcome.calls.some((call) => call.path.startsWith("/cli/api/hosts/alpha/"))).toBe(false);
    expect(outcome.row("alpha")).toContain("skipped (offline)");
    expect(outcome.row("beta")).toMatch(/updated$/);
    expect(outcome.row("local")).toMatch(/updated$/);
    expect(outcome.error?.code).toBe(1);
  });

  test("a 404 from POST update says the node cannot be updated remotely and names node update", async () => {
    const outcome = await run(ALL, {
      ...GOOD,
      alpha: { update: new HubError("not found", 404, { error: "not found" }) },
    });
    expect(outcome.row("alpha")).toContain(TOO_OLD);
    expect(outcome.row("alpha")).toContain("claude-rc node update");
    expect(outcome.row("beta")).toMatch(/updated$/);
    expect(outcome.error?.code).toBe(1);
  });

  test("another error from POST update is failed (<message>) and the others still run", async () => {
    const outcome = await run(ALL, {
      ...GOOD,
      alpha: { update: new HubError("another update is running on this machine", 409, {}) },
    });
    expect(outcome.row("alpha")).toContain("failed (another update is running on this machine)");
    expect(outcome.row("beta")).toMatch(/updated$/);
    expect(outcome.row("local")).toMatch(/updated$/);
    expect(outcome.error?.code).toBe(1);
  });

  test("a failed report is failed (<error>)", async () => {
    const outcome = await run(ALL, {
      ...GOOD,
      alpha: { update: { status: "failed", from: "1.0.0", clients: [], error: "checksum mismatch" } },
    });
    expect(outcome.row("alpha")).toContain("failed (checksum mismatch)");
  });

  test("a machine that never answers within 90 seconds is no answer", async () => {
    const outcome = await run(ALL, { ...GOOD, alpha: { update: restarting("1.0.0", "2.0.0"), versions: [] } });
    expect(outcome.row("alpha")).toContain("no answer");
    const polls = outcome.calls.filter((call) => call.path === "/cli/api/hosts/alpha/node").length;
    expect(polls).toBeGreaterThanOrEqual(44);
    expect(polls).toBeLessThanOrEqual(47);
    expect(outcome.row("beta")).toMatch(/updated$/);
    expect(outcome.text).toContain("journalctl -u claude-rc-launcher");
  });

  test("connection errors during the restart are not failures", async () => {
    const down = new ExitError("cannot reach hub: connection refused", 1);
    const outcome = await run(ALL, {
      ...GOOD,
      local: {
        update: restarting("1.0.0", "2.0.0"),
        versions: ["1.0.0", down, down, new HubError("bad gateway", 502, {}), "2.0.0"],
      },
    });
    expect(outcome.row("local")).toMatch(/updated$/);
    expect(outcome.error).toBeUndefined();
  });

  test("a version that is unchanged after a restart report is rolled back", async () => {
    const outcome = await run(ALL, {
      ...GOOD,
      alpha: {
        update: restarting("1.0.0", "2.0.0"),
        versions: ["1.0.0", new ExitError("cannot reach hub: down", 1), "1.0.0"],
      },
    });
    expect(outcome.row("alpha")).toContain("rolled back");
    expect(outcome.row("alpha")).not.toContain("2.0.0");
    expect(outcome.error?.code).toBe(1);
  });

  test("up-to-date does not poll", async () => {
    const outcome = await run(ALL, { ...GOOD, alpha: { update: upToDate("1.0.0") } });
    expect(outcome.calls.some((call) => call.path === "/cli/api/hosts/alpha/node")).toBe(false);
    expect(outcome.row("alpha")).toMatch(/up-to-date$/);
  });

  test("clients-only does not poll and is updated with the client paths", async () => {
    const outcome = await run(ALL, {
      ...GOOD,
      alpha: {
        update: {
          status: "clients-only",
          from: "1.0.0",
          clients: [{ path: "/opt/bin/claude-rc", status: "updated", from: "0.9.0", to: "1.0.0" }],
        },
      },
    });
    expect(outcome.calls.some((call) => call.path === "/cli/api/hosts/alpha/node")).toBe(false);
    expect(outcome.row("alpha")).toContain("/opt/bin/claude-rc");
    expect(outcome.row("alpha")).toMatch(/updated$/);
  });

  test("a failed client makes the row failed even when the service updated", async () => {
    const clients = [{ path: "/opt/bin/claude-rc", status: "failed", error: "permission denied" }];
    const outcome = await run(ALL, {
      ...GOOD,
      alpha: { update: restarting("1.0.0", "2.0.0", clients), versions: ["2.0.0"] },
      beta: {
        update: {
          status: "clients-only",
          from: "1.0.0",
          clients: [...clients, { path: "/usr/bin/claude-rc", status: "updated" }],
        },
      },
    });
    expect(outcome.row("alpha")).toContain("failed (/opt/bin/claude-rc: permission denied)");
    expect(outcome.row("beta")).toContain("failed (/opt/bin/claude-rc: permission denied)");
    expect(outcome.error?.code).toBe(1);
    expect(outcome.error?.message).toBe("2 of 4 machines were not updated");
  });

  test("the hub (local) is updated after every remote host, even when it is listed first", async () => {
    const outcome = await run([host("local"), host("zulu"), host("alpha")], { ...GOOD, zulu: GOOD.alpha });
    const posts = outcome.calls.filter((call) => call.method === "POST").map((call) => call.path);
    expect(posts.at(-1)).toBe("/cli/api/hosts/local/update");
    expect(posts).toEqual(["/cli/api/hosts/zulu/update", "/cli/api/hosts/alpha/update", "/cli/api/hosts/local/update"]);
    const lastLocal = outcome.calls.findLastIndex((call) => call.path.startsWith("/cli/api/hosts/local/"));
    const lastRemote = outcome.calls.findLastIndex((call) => /\/hosts\/(alpha|zulu)\//.test(call.path));
    expect(lastLocal).toBeGreaterThan(lastRemote);
  });

  test("all good rows give no error; any failed row gives ExitError 1", async () => {
    expect((await run(ALL, GOOD)).error).toBeUndefined();
    const bad = await run(ALL, { ...GOOD, beta: { update: new HubError("boom", 500, {}) } });
    expect(bad.error).toBeInstanceOf(ExitError);
    expect(bad.error?.code).toBe(1);
    expect(bad.error?.message).toBe("1 of 4 machines were not updated");
    // The table is printed before the error.
    expect(bad.row("beta")).toContain("failed (boom)");
  });

  test("a failed local client update is a failed row", async () => {
    const hub = fakeHub(ALL, GOOD);
    const sys = fakeSys();
    sys.sys.execPath = "/home/me/src/bun";
    const out: string[] = [];
    const value = await updateAll({
      flags: { "all-nodes": true } as any,
      hub: hub.hub,
      out: (line) => out.push(line),
      sys: sys.sys,
    }).then(
      () => undefined,
      (element) => element,
    );
    expect(value?.code).toBe(1);
    expect(out.join("\n")).toContain("failed (claude-rc update works on the installed binary only");
  });

  test("--binary with --all-nodes is an error before any request", async () => {
    const outcome = await run(ALL, GOOD, { binary: "/tmp/x" });
    expect(outcome.calls).toEqual([]);
    expect(outcome.error?.code).toBe(1);
    expect(outcome.error?.message).toContain("--binary");
  });

  test("--release is passed to every machine and to the local client", async () => {
    const outcome = await run(ALL, GOOD, { release: "v1.2.3" });
    for (const call of outcome.calls.filter((item) => item.method === "POST"))
      expect(call.body).toEqual({ release: "v1.2.3" });
    expect(outcome.sys.calls).toContain(`fetch ${RELEASE}/download/v1.2.3/${ASSET}`);
  });

  test.each([[""], ["latest"], ["1.2"]])("a bad --release %p is an error before any request", async (rel) => {
    const outcome = await run(ALL, GOOD, { release: rel });
    expect(outcome.calls).toEqual([]);
    expect(outcome.sys.calls).toEqual([]);
    expect(outcome.error?.code).toBe(1);
    expect(outcome.error?.message).toContain("--release");
  });

  test("without --release the update body is empty", async () => {
    const outcome = await run(ALL, GOOD);
    for (const call of outcome.calls.filter((item) => item.method === "POST")) expect(call.body).toEqual({});
  });

  test("a second run in which every machine is up-to-date succeeds", async () => {
    const outcome = await run([host("local", "2.0.0"), host("alpha", "2.0.0"), host("beta", "2.0.0")], {
      alpha: { update: upToDate("2.0.0") },
      beta: { update: upToDate("2.0.0") },
      local: { update: upToDate("2.0.0") },
    });
    expect(outcome.error).toBeUndefined();
    for (const id of ["alpha", "beta", "local"]) expect(outcome.row(id)).toMatch(/up-to-date$/);
    expect(outcome.calls.some((call) => call.path.endsWith("/node"))).toBe(false);
    expect(outcome.text).toContain(VERSION);
  });

  test("--json prints the rows as JSON", async () => {
    const outcome = await run(ALL, GOOD, { json: true });
    const rows = JSON.parse(defined(outcome.out.at(-1)));
    expect(rows.map((row: { machine: string }) => row.machine)).toEqual(["alpha", "beta", "local", "client"]);
    expect(rows[0].status).toBe("updated");
  });
});

describe("index: update --all-nodes", () => {
  const env = () => ({
    credsFile: path.join(mkdtempSync(path.join(os.tmpdir(), "rc-ua-")), "credentials.json"),
    open: async () => {},
    readLine: () => Promise.resolve(""),
  });

  test("without a login it gives the login message (exit 2)", async () => {
    const err: string[] = [];
    const code = await main(["update", "--all-nodes"], { out: () => {}, err: (line) => err.push(line) }, env());
    expect(code).toBe(2);
    expect(err.join("\n")).toBe(LOGIN_MESSAGE);
  });

  test("--binary with --all-nodes is an error before the login check", async () => {
    const err: string[] = [];
    const code = await main(
      ["update", "--all-nodes", "--binary", "/tmp/x"],
      { out: () => {}, err: (line) => err.push(line) },
      env(),
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("--binary");
  });

  test("update without --all-nodes still needs no login", async () => {
    const sys = fakeSys();
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      ["update"],
      { out: (line) => out.push(line), err: (line) => err.push(line) },
      { ...env(), sys: sys.sys },
    );
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(out.at(-1)).toBe(`claude-rc is already up to date (${VERSION})`);
  });
});

/** A fake event stream. Each open takes the next script: events to send, or an Error to fail the open. */
type Script = ({ event: string; data: string } | "end")[] | Error;
interface Ev {
  host: string;
  line: string;
}
const logEv = (host: string, line: string) => ({ event: "log", data: JSON.stringify({ host, line, at: 1 }) });

async function runLive(opts: {
  scripts: Script[];
  onPost?: Record<string, Ev[]>;
  json?: boolean;
  nodes?: Record<string, Node>;
  streamDelayMs?: number;
}) {
  const hub = fakeHub(ALL, opts.nodes ?? GOOD);
  const sys = fakeSys();
  const events: string[] = [];
  // The 3 s wait for the stream is real here (short), so a stream that answers late wins the race. Other sleeps are instant.
  const baseSleep = sys.sys.sleep;
  sys.sys.sleep = async (ms) =>
    ms === 3000 ? void (await new Promise((resolve) => setTimeout(resolve, 300))) : baseSleep(ms);
  const out: string[] = [];
  const err: string[] = [];
  const opens: { aborted: () => boolean }[] = [];
  const queues: ((ev: { event: string; data: string } | "end") => void)[] = [];
  const hubAny = hub.hub as any;
  const baseRequest = hubAny.request.bind(hubAny);

  hubAny.request = async (method: string, value: string, ...rest: unknown[]) => {
    if (method === "POST") events.push(`post ${value}`);
    const response = await baseRequest(method, value, ...rest);
    const match = /^\/cli\/api\/hosts\/([^/]+)\/update$/.exec(value);

    if (match && method === "POST") {
      for (const ev of opts.onPost?.[match[1]] ?? []) queues.at(-1)?.(logEv(ev.host, ev.line));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    return response;
  };

  let count = 0;

  hubAny.stream = (_path: string, options?: { signal?: AbortSignal }) => {
    const script = opts.scripts[Math.min(count++, opts.scripts.length - 1)];
    opens.push({ aborted: () => !!options?.signal?.aborted });
    const pending: ({ event: string; data: string } | "end")[] = [];
    let wake: (() => void) | undefined;
    if (!(script instanceof Error)) queues.push((ev) => (pending.push(ev), wake?.()));
    return (async function* () {
      if (script instanceof Error) throw script;
      if (count === 1 && opts.streamDelayMs) await new Promise((resolve) => setTimeout(resolve, opts.streamDelayMs));

      for (const item of script) {
        if (item === "end") return;
        events.push("stream event");
        yield item;
      }

      if (script.length === 0) events.push("stream event");
      // Stay open and deliver what onPost pushes, until the signal aborts.
      const aborted = new Promise<void>((res) =>
        options?.signal?.addEventListener("abort", () => {
          res();
        }),
      );

      for (;;) {
        if (options?.signal?.aborted) return;
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
    await updateAll({
      flags: { "all-nodes": true, ...(opts.json ? { json: true } : {}) },
      hub: hub.hub,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      sys: sys.sys,
    });
  } catch (caught) {
    if (!(caught instanceof ExitError)) throw caught;
    error = caught;
  }

  return { ...hub, out, err, error, opens, events, count: () => count };
}

describe("updateAll live output", () => {
  const lines = {
    alpha: [
      { host: "alpha", line: "downloading" },
      { host: "alpha", line: "installing" },
    ],
    beta: [{ host: "beta", line: "verifying" }],
    local: [{ host: "local", line: "restarting" }],
  };

  test("prints each log line as [host] line, in order; the snapshot and other hosts are ignored", async () => {
    const snap = {
      event: "snapshot",
      data: JSON.stringify({ updates: [], logs: { alpha: [{ line: "OLD", at: 0 }] }, presence: [] }),
    };
    const harness = await runLive({ scripts: [[snap, logEv("zzz", "not updated")]], onPost: lines });
    expect(harness.error).toBeUndefined();
    const live = harness.out.filter((item) => /^\[(alpha|beta|local)\] /.test(item));
    expect(live).toEqual(["[alpha] downloading", "[alpha] installing", "[beta] verifying", "[local] restarting"]);
    expect(harness.out.join("\n")).not.toContain("OLD");
    expect(harness.out.join("\n")).toContain("MACHINE");
    expect(harness.err).toEqual([]);
    expect(harness.opens[0].aborted()).toBe(true);
  });

  test("the first stream event is delivered before the first update starts", async () => {
    const snap = { event: "snapshot", data: JSON.stringify({ updates: [], logs: {}, presence: [] }) };
    const live = await runLive({ scripts: [[snap]], onPost: lines, streamDelayMs: 40 });
    expect(live.events[0]).toBe("stream event");
    expect(live.events.indexOf("stream event")).toBeLessThan(
      live.events.findIndex((event) => event.startsWith("post ")),
    );
    expect(live.calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual([
      "/cli/api/hosts/alpha/update",
      "/cli/api/hosts/beta/update",
      "/cli/api/hosts/local/update",
    ]);
  });

  test("with --json the lines go to standard error and the result stays on standard output", async () => {
    const live = await runLive({ scripts: [[]], onPost: lines, json: true });
    expect(live.err).toEqual(["[alpha] downloading", "[alpha] installing", "[beta] verifying", "[local] restarting"]);
    expect(live.out.some((item) => /^\[(alpha|beta|local)\] /.test(item))).toBe(false);
    expect(JSON.parse(live.out.join("\n")).map((row: { machine: string }) => row.machine)).toEqual([
      "alpha",
      "beta",
      "local",
      "client",
    ]);
  });

  test("a stream that cannot be opened changes nothing", async () => {
    const live = await runLive({ scripts: [new HubError("HTTP 404", 404, undefined)], onPost: lines });
    expect(live.error).toBeUndefined();
    expect(live.out.some((item) => /^\[(alpha|beta|local)\] /.test(item))).toBe(false);
    expect(live.out.join("\n")).toContain("MACHINE");
    expect(live.calls.filter((call) => call.method === "POST")).toHaveLength(3);
    expect(live.count()).toBe(1);
    expect(live.err).toEqual([]);
    expect(live.out.join("\n")).not.toMatch(/stream|HTTP 404|events/i);
    expect(
      live.out.filter(
        (item) =>
          !item.startsWith("updating ") &&
          !/^(MACHINE|a |b |local |client )/.test(item) &&
          item.split("\n").every((part) => !/^(MACHINE|a |b |local |client )/.test(part)),
      ),
    ).toEqual([]);
  });

  test("a failing machine gives the same exit code and table with a failing stream as with a working one", async () => {
    const nodes = { ...GOOD, alpha: { update: new HubError("boom", 500, {}) } };
    const good = await runLive({ scripts: [[]], nodes });
    const bad = await runLive({ scripts: [new HubError("HTTP 500", 500, undefined)], nodes });
    expect(bad.error?.code).toBe(good.error?.code);
    expect(bad.error?.message).toBe(good.error?.message);
    const table = (item: string[]) => item.filter((entry) => !entry.startsWith("updating ") && !entry.startsWith("["));
    expect(table(bad.out)).toEqual(table(good.out));
    expect(bad.err).toEqual([]);
  });

  test("a stream that ends is reopened, and lines after the reopen appear", async () => {
    const live = await runLive({
      scripts: [[logEv("alpha", "first"), "end"], []],
      onPost: { local: [{ host: "local", line: "after restart" }] },
    });
    expect(live.count()).toBe(2);
    // "first" came before any update started, so it is not printed.
    expect(live.out.filter((item) => /^\[(alpha|beta|local)\] /.test(item))).toEqual(["[local] after restart"]);
    expect(live.error).toBeUndefined();
  });

  test("a stream that keeps failing after it opened gives up silently", async () => {
    const live = await runLive({ scripts: [[logEv("alpha", "first"), "end"], new Error("down")], onPost: lines });
    expect(live.error).toBeUndefined();
    expect(live.count()).toBeLessThanOrEqual(50);
    expect(live.out.join("\n")).toContain("MACHINE");
  });
});

describe("updateAll live output: safety and scope", () => {
  const live = (result: { out: string[] }) => result.out.filter((item) => /^\[(alpha|beta|local)\] /.test(item));

  test("sanitizeLine replaces control characters except tab and caps the length", () => {
    expect(sanitizeLine("a\tb")).toBe("a\tb");
    expect(sanitizeLine("x\u001b[2Jy\u001b]0;title\u0007z\rq\bw\u007f\u0085\u009f\n")).toBe(
      "x?[2Jy?]0;title?z?q?w???" + "?",
    );
    expect(sanitizeLine("é ü 日本")).toBe("é ü 日本");
    expect(sanitizeLine("x".repeat(5000))).toHaveLength(500);
  });

  test("sanitizeLine replaces bidi overrides and isolates, direction marks and zero-width characters", () => {
    for (const item of [
      "\u202a",
      "\u202b",
      "\u202c",
      "\u202d",
      "\u202e",
      "\u2066",
      "\u2067",
      "\u2068",
      "\u2069",
      "\u200e",
      "\u200f",
      "\u061c",
      "\u200b",
      "\u200c",
      "\u200d",
      "\u2060",
      "\ufeff",
    ]) {
      expect([item, sanitizeLine(`a${item}b`)]).toEqual([item, "a?b"]);
    }

    expect(sanitizeLine("\u202etxt.exe")).toBe("?txt.exe");
  });

  test("the log watcher stops at once when the run ends during its wait, without waiting for the sleep", async () => {
    const stream = async function* () {
      yield { event: "log", data: "{}" };
    };

    const hub = { stream: () => stream() } as unknown as HubClient;
    const sys = { now: () => 0, sleep: () => new Promise<void>(() => {}) } as unknown as Sys; // a sleep that never ends
    const ac = new AbortController();
    const done = watchLogs(
      hub,
      sys,
      () => undefined,
      () => {},
      ac.signal,
      () => {},
    );
    await new Promise((resolve) => setTimeout(resolve, 20)); // now it is in the wait
    ac.abort();
    expect(
      await Promise.race([
        done.then(() => "done"),
        new Promise((resolve) =>
          setTimeout(() => {
            resolve("hung");
          }, 500),
        ),
      ]),
    ).toBe("done");
  });

  test("escape sequences, carriage returns, backspaces and bells from a node are not printed", async () => {
    const evil = "ok\u001b[2J\u001b]0;pwned\u0007\u001b]52;c;QQ==\u001b\\\rfake [alpha] updated\b\bX";
    const harness = await runLive({ scripts: [[]], onPost: { alpha: [{ host: "alpha", line: evil }] } });
    const printed = live(harness).join("\n");
    expect(printed).toContain("[alpha] ok");
    for (const bad of ["\u001b", "\r", "\b", "\u0007"]) expect(harness.out.join("\n")).not.toContain(bad);
  });

  test("a line of 5000 characters is capped", async () => {
    const harness = await runLive({ scripts: [[]], onPost: { alpha: [{ host: "alpha", line: "y".repeat(5000) }] } });
    expect(live(harness)[0].length).toBeLessThanOrEqual("[alpha] ".length + 500);
    expect(live(harness)[0].length).toBeGreaterThan(400);
  });

  test("only the machine being updated now prints: later hosts and finished hosts are ignored", async () => {
    const harness = await runLive({
      scripts: [[]],
      onPost: {
        alpha: [
          { host: "beta", line: "web update of beta" },
          { host: "local", line: "later" },
          { host: "alpha", line: "mine alpha" },
        ],
        beta: [
          { host: "alpha", line: "finished alpha" },
          { host: "beta", line: "mine beta" },
        ],
        local: [
          { host: "alpha", line: "replayed alpha" },
          { host: "beta", line: "replayed beta" },
          { host: "local", line: "mine local" },
        ],
      },
    });
    expect(live(harness)).toEqual(["[alpha] mine alpha", "[beta] mine beta", "[local] mine local"]);
  });

  test("nothing prints while a machine is not being updated (before the first update, for the client)", async () => {
    const harness = await runLive({ scripts: [[logEv("alpha", "early"), "end"], []], onPost: {} });
    expect(live(harness)).toEqual([]);
  });

  test("a hub that is down for 60 seconds still gets its stream reopened", async () => {
    const down = Array.from({ length: 30 }, () => new Error("down"));
    const harness = await runLive({
      scripts: [[logEv("alpha", "x"), "end"], ...down, []],
      onPost: { local: [{ host: "local", line: "after restart" }] },
    });
    expect(harness.count()).toBe(32);
    expect(live(harness)).toEqual(["[local] after restart"]);
  });
});

describe("updateNodes (update --node)", () => {
  async function runNodes(flags: Record<string, unknown>, hosts: Host[] = ALL, nodes: Record<string, Node> = GOOD) {
    const hub = fakeHub(hosts, nodes);
    const sys = fakeSys();
    const out: string[] = [];
    const err: string[] = [];
    let error: ExitError | undefined;

    try {
      await updateNodes({
        flags,
        hub: hub.hub,
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        sys: sys.sys,
      });
    } catch (caught) {
      if (!(caught instanceof ExitError)) throw caught;
      error = caught;
    }

    const text = out.join("\n");
    const row = (name: string) => text.split("\n").find((part) => part.startsWith(`${name} `)) ?? "";
    return { ...hub, sys, out, text, error, row };
  }

  const posts = (outcome: { calls: Call[] }) =>
    outcome.calls.filter((call) => call.method === "POST").map((call) => call.path);

  test("updates only the named nodes, in the order given, and not the hub, other nodes or the client", async () => {
    const outcome = await runNodes({ node: "beta,alpha" });
    expect(outcome.error).toBeUndefined();
    expect(posts(outcome)).toEqual(["/cli/api/hosts/beta/update", "/cli/api/hosts/alpha/update"]);
    expect(outcome.sys.calls).toEqual([]);
    expect(outcome.row("alpha")).toMatch(/updated$/);
    expect(outcome.row("beta")).toMatch(/updated$/);
    expect(outcome.row("local")).toBe("");
    expect(outcome.row("client")).toBe("");
  });

  test("--release goes to each named node; without it the body is empty", async () => {
    const withTag = await runNodes({ node: "alpha", release: "v0.33.1-test.ssh.5bf4ca1" });
    for (const call of withTag.calls.filter((item) => item.method === "POST"))
      expect(call.body).toEqual({ release: "v0.33.1-test.ssh.5bf4ca1" });
    const without = await runNodes({ node: "alpha" });
    for (const call of without.calls.filter((item) => item.method === "POST")) expect(call.body).toEqual({});
  });

  test("the id local is refused and the message names --all-nodes", async () => {
    const outcome = await runNodes({ node: "alpha,local" });
    expect(posts(outcome)).toEqual([]);
    expect(outcome.error?.code).toBe(1);
    expect(outcome.error?.message).toContain("--all-nodes");
  });

  test("an unknown id is refused before anything runs", async () => {
    const outcome = await runNodes({ node: "alpha,nope" });
    expect(posts(outcome)).toEqual([]);
    expect(outcome.error?.code).toBe(1);
    expect(outcome.error?.message).toContain("nope");
  });

  test("a duplicate id is refused before anything runs", async () => {
    const outcome = await runNodes({ node: "alpha,beta,alpha" });
    expect(posts(outcome)).toEqual([]);
    expect(outcome.error?.code).toBe(1);
    expect(outcome.error?.message).toContain("alpha");
    expect(outcome.error?.message).toContain("more than once");
  });

  test("an empty id is refused", async () => {
    for (const value of ["", "alpha,,beta"]) {
      const outcome = await runNodes({ node: value });
      expect(posts(outcome)).toEqual([]);
      expect(outcome.error?.code).toBe(1);
    }
  });

  test("--binary and a bad --release are refused before any request", async () => {
    const binary = await runNodes({ node: "alpha", binary: "/tmp/x" });
    expect(binary.calls).toEqual([]);
    expect(binary.error?.message).toContain("--binary");
    const tag = await runNodes({ node: "alpha", release: "latest" });
    expect(tag.calls).toEqual([]);
    expect(tag.error?.message).toContain("--release");
  });

  test("--node together with --all-nodes is a usage error", async () => {
    const outcome = await runNodes({ node: "alpha", "all-nodes": true });
    expect(outcome.calls).toEqual([]);
    expect(outcome.error?.code).toBe(1);
    expect(outcome.error?.message).toContain("--all-nodes");
  });

  test("an offline node is skipped and gives exit 1 like --all-nodes", async () => {
    const outcome = await runNodes({ node: "alpha,beta" }, [
      host("local"),
      host("alpha", "1.0.0", "offline"),
      host("beta"),
    ]);
    expect(posts(outcome)).toEqual(["/cli/api/hosts/beta/update"]);
    expect(outcome.row("alpha")).toContain("skipped (offline");
    expect(outcome.error?.message).toBe("1 of 2 machines were not updated");
  });

  test("a node that is too old, and a failed node, behave as in --all-nodes", async () => {
    const outcome = await runNodes({ node: "alpha,beta" }, ALL, {
      alpha: { update: new HubError("no route", 404, undefined) },
      beta: { update: { status: "failed", from: "1.0.0", clients: [], error: "boom" } },
    });
    expect(outcome.row("alpha")).toContain(TOO_OLD);
    expect(outcome.row("beta")).toContain("failed (boom)");
    expect(outcome.error?.message).toBe("2 of 2 machines were not updated");
  });

  test("--json prints only the rows of the named nodes", async () => {
    const outcome = await runNodes({ node: "beta", json: true });
    const rows = JSON.parse(defined(outcome.out.at(-1))) as { machine: string; status: string }[];
    expect(rows.map((row) => row.machine)).toEqual(["beta"]);
    expect(rows[0]?.status).toBe("updated");
  });
});

describe("index: update --node", () => {
  const env = () => ({
    credsFile: path.join(mkdtempSync(path.join(os.tmpdir(), "rc-un-")), "credentials.json"),
    open: async () => {},
    readLine: () => Promise.resolve(""),
  });

  const attempt = async (...argv: string[]) => {
    const err: string[] = [];
    const code = await main(argv, { out: () => {}, err: (line) => err.push(line) }, env());
    return { code, text: err.join("\n") };
  };

  test("without a login it gives the login message (exit 2)", async () => {
    const outcome = await attempt("update", "--node", "a");
    expect(outcome.code).toBe(2);
    expect(outcome.text).toBe(LOGIN_MESSAGE);
  });

  test("--node with --all-nodes is a usage error before the login check", async () => {
    const outcome = await attempt("update", "--node", "a", "--all-nodes");
    expect(outcome.code).toBe(1);
    expect(outcome.text).toContain("--node");
    expect(outcome.text).toContain("--all-nodes");
  });

  test("--binary and stray flags are refused before the login check", async () => {
    const binary = await attempt("update", "--node", "a", "--binary", "/tmp/x");
    expect(binary.code).toBe(1);
    expect(binary.text).toContain("--binary");
    const stray = await attempt("update", "--node", "a", "--lines", "3");
    expect(stray.code).toBe(1);
    expect(stray.text).toContain("--lines does not apply to update");
  });

  test("an empty --node is a usage error", async () => {
    const outcome = await attempt("update", "--node", "");
    expect(outcome.code).toBe(1);
  });
});

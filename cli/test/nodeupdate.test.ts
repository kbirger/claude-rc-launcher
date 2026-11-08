import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main, type Env } from "../src/index";
import { ExitError } from "../src/creds";
import { nodeUpdate, type Sys } from "../src/nodesetup";

const BIN = "/usr/local/bin/claude-rc-launcher";
const UNIT_PATH = "/etc/systemd/system/claude-rc-launcher.service";
const CONFIG = "/etc/claude-rc-launcher/config.toml";
const ASSET = "claude-rc-launcher-linux-x64";
const RELEASE = "https://github.com/kbirger/claude-rc-launcher/releases";
const OLD = new TextEncoder().encode("#!old-binary");
const NEW = new TextEncoder().encode("#!new-binary");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

type Opts = {
  installed?: boolean;
  platform?: string;
  arch?: string;
  noSystemctl?: boolean;
  sums?: string;
  /** What `systemctl is-active` answers, one entry per call. The last one repeats. */
  active?: boolean[];
  files?: Record<string, Uint8Array>;
  /** Makes a sudo call fail. It gets the command line and how many times that same line was run before. */
  fail?: (cmd: string, nth: number) => boolean;
  journal?: string;
};

function fake(o: Opts = {}) {
  const calls: string[] = [];
  const fetched: string[] = [];
  const written = new Map<string, Uint8Array>();
  let clock = 0;
  let polls = 0;
  const seen = new Map<string, number>();
  const existing = new Set(o.installed === false ? [] : [BIN, UNIT_PATH]);
  const sys: Sys = {
    platform: o.platform ?? "linux",
    arch: o.arch ?? "x64",
    isRoot: () => false,
    hasCommand: (n) => !(o.noSystemctl && n === "systemctl"),
    localAddresses: () => [],
    exists: (p) => existing.has(p),
    run(args) {
      calls.push(`run ${args.join(" ")}`);
      if (args[0] === "systemctl" && args[1] === "is-active") {
        const seq = o.active ?? [true];
        const up = seq[Math.min(polls++, seq.length - 1)]!;
        return { code: up ? 0 : 3, stdout: up ? "active" : "failed" };
      }
      return { code: 0, stdout: "" };
    },
    sudo(args) {
      const cmd = args.join(" ");
      calls.push(`sudo ${cmd}`);
      const nth = seen.get(cmd) ?? 0;
      seen.set(cmd, nth + 1);
      if (o.fail?.(cmd, nth)) return { code: 1, stdout: "", stderr: "denied" };
      if (args[0] === "journalctl") return { code: 0, stdout: o.journal ?? "Nov 07 node[1]: boom: port in use", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    readFile: (p) => (p === BIN ? OLD : (o.files?.[p] ?? new Uint8Array())),
    writeTemp(name, data) {
      written.set(`/tmp/fake/${name}`, data);
      return `/tmp/fake/${name}`;
    },
    removeTemp: (p) => void calls.push(`rm ${p}`),
    fetch: (async (url: string | URL) => {
      const u = String(url);
      fetched.push(u);
      if (u === `${RELEASE}/latest/download/${ASSET}` || u === `${RELEASE}/download/v0.2.0/${ASSET}`) return new Response(NEW);
      if (u.endsWith("/SHA256SUMS")) return new Response(o.sums ?? `${sha(NEW)}  ${ASSET}\n`);
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch,
    sleep: async (ms) => {
      calls.push(`sleep ${ms}`);
      clock += ms;
    },
    now: () => clock,
  };
  return { sys, calls, fetched, written, clock: () => clock };
}

async function update(sys: Sys, flags: Record<string, unknown> = {}) {
  const out: string[] = [];
  await nodeUpdate({ flags: flags as any, out: (s) => out.push(s), sys });
  return out;
}
const fails = async (p: Promise<unknown>) => (await p.then(() => undefined, (e) => e)) as ExitError | undefined;
const sudoCalls = (calls: string[]) => calls.filter((c) => c.startsWith("sudo ")).map((c) => c.slice(5));

describe("nodeUpdate", () => {
  test("the happy path backs up, installs, restarts and waits for the service, in order", async () => {
    const f = fake();
    const out = await update(f.sys);
    const steps = [
      `cp -p ${BIN} ${BIN}.prev`,
      `install -m 755 /tmp/fake/claude-rc-launcher ${BIN}.new`,
      `mv -f ${BIN}.new ${BIN}`,
      "systemctl restart claude-rc-launcher",
    ];
    expect(sudoCalls(f.calls)).toEqual(steps);
    expect(f.calls.slice(f.calls.indexOf("sudo systemctl restart claude-rc-launcher") + 1)).toEqual([
      "run systemctl is-active claude-rc-launcher",
      "sleep 2000",
      "run systemctl is-active claude-rc-launcher",
    ]);
    expect(f.written.get("/tmp/fake/claude-rc-launcher")).toEqual(NEW);
    const restart = f.calls.indexOf("sudo systemctl restart claude-rc-launcher");
    expect(f.calls.slice(restart + 1).some((c) => c === "run systemctl is-active claude-rc-launcher")).toBe(true);
    expect(f.calls.some((c) => c.startsWith("sudo journalctl"))).toBe(false);
    expect(out.at(-1)).toBe(`updated ${BIN} (the previous binary is kept as ${BIN}.prev) and restarted claude-rc-launcher`);
  });

  test("a service that is active and then inactive within the 2 second window fails and rolls back", async () => {
    const f = fake({ active: [true, false] });
    const e = await fails(update(f.sys));
    expect(e).toBeInstanceOf(ExitError);
    const i = f.calls.indexOf("sleep 2000");
    expect(f.calls.slice(i - 1, i + 2)).toEqual(["run systemctl is-active claude-rc-launcher", "sleep 2000", "run systemctl is-active claude-rc-launcher"]);
    expect(sudoCalls(f.calls)).toContain(`mv -f ${BIN}.prev ${BIN}`);
  });

  test("a service that becomes active after a few polls is accepted", async () => {
    const f = fake({ active: [false, false, true] });
    const out = await update(f.sys);
    expect(out.at(-1)).toContain("and restarted claude-rc-launcher");
    expect(sudoCalls(f.calls).filter((c) => c.startsWith("systemctl restart"))).toHaveLength(1);
  });

  test("a failed health check restores the previous binary, restarts again and prints the journal", async () => {
    const f = fake({ active: [false] });
    const out: string[] = [];
    const e = await fails(nodeUpdate({ flags: {}, out: (s) => out.push(s), sys: f.sys }));
    expect(e).toBeInstanceOf(ExitError);
    expect(e!.code).toBe(1);
    expect(e!.message).toContain("update failed");
    expect(e!.message).toContain("previous binary was restored");
    expect(f.clock()).toBeGreaterThanOrEqual(30_000);
    const sudo = sudoCalls(f.calls);
    const restore = sudo.indexOf(`mv -f ${BIN}.prev ${BIN}`);
    expect(restore).toBeGreaterThan(sudo.indexOf(`mv -f ${BIN}.new ${BIN}`));
    expect(sudo.slice(restore + 1)).toContain("systemctl restart claude-rc-launcher");
    expect(sudo.at(-1)).toBe("journalctl -u claude-rc-launcher -n 15 --no-pager");
    expect(out.join("\n")).toContain("boom: port in use");
  });

  describe("failures during the install", () => {
    const noReplace = (f: ReturnType<typeof fake>) => {
      expect(f.calls.some((c) => c.includes("systemctl restart"))).toBe(false);
      expect(f.calls.some((c) => c.includes(`mv -f ${BIN}.prev`))).toBe(false);
    };
    test("cp -p failing stops before anything is installed", async () => {
      const f = fake({ fail: (c) => c.startsWith("cp -p") });
      const e = await fails(update(f.sys));
      expect(e!.message).toContain("backing up");
      expect(sudoCalls(f.calls)).toEqual([`cp -p ${BIN} ${BIN}.prev`]);
    });
    test("install failing leaves the binary untouched and does not restart", async () => {
      const f = fake({ fail: (c) => c.startsWith("install ") });
      expect(await fails(update(f.sys))).toBeInstanceOf(ExitError);
      expect(sudoCalls(f.calls).some((c) => c.startsWith(`mv -f ${BIN}.new`))).toBe(false);
      noReplace(f);
    });
    test("mv failing removes the .new file, leaves the binary untouched and does not restart", async () => {
      const f = fake({ fail: (c) => c === `mv -f ${BIN}.new ${BIN}` });
      expect(await fails(update(f.sys))).toBeInstanceOf(ExitError);
      expect(sudoCalls(f.calls).at(-1)).toBe(`rm -f ${BIN}.new`);
      noReplace(f);
    });
  });

  test("systemctl restart returning non-zero triggers the rollback", async () => {
    const f = fake({ fail: (c, n) => c === "systemctl restart claude-rc-launcher" && n === 0 });
    const e = await fails(update(f.sys));
    expect(e!.message).toContain("previous binary was restored");
    expect(sudoCalls(f.calls)).toContain(`mv -f ${BIN}.prev ${BIN}`);
    expect(f.calls.some((c) => c.includes("is-active"))).toBe(false);
  });

  test("when the restore mv fails the message says the new binary is still installed and gives the manual command", async () => {
    const f = fake({ active: [false], fail: (c) => c === `mv -f ${BIN}.prev ${BIN}` });
    const e = await fails(update(f.sys));
    expect(e!.message).toContain("NEW binary is still installed");
    expect(e!.message).toContain(`sudo mv -f ${BIN}.prev ${BIN} && sudo systemctl restart claude-rc-launcher`);
    expect(sudoCalls(f.calls).filter((c) => c.startsWith("systemctl restart"))).toHaveLength(1);
  });

  test("when the second restart fails the message says the service did not restart and the journal is shown", async () => {
    const f = fake({ active: [false], fail: (c, n) => c === "systemctl restart claude-rc-launcher" && n === 1 });
    const out: string[] = [];
    const e = await fails(nodeUpdate({ flags: {}, out: (s) => out.push(s), sys: f.sys }));
    expect(e!.message).toContain("back in place");
    expect(e!.message).toContain("did not restart");
    expect(e!.message).not.toContain("service was restarted");
    expect(out.join("\n")).toContain("boom: port in use");
  });

  test("an empty journal prints no blank line", async () => {
    const f = fake({ active: [false], journal: "" });
    const out: string[] = [];
    await fails(nodeUpdate({ flags: {}, out: (s) => out.push(s), sys: f.sys }));
    expect(out.filter((l) => l === "")).toEqual([]);
  });

  test("the same checksum as the installed binary changes nothing and does not restart", async () => {
    const f = fake({ sums: `${sha(OLD)}  ${ASSET}\n` });
    f.sys.fetch = (async (url: string | URL) => (String(url).endsWith("/SHA256SUMS") ? new Response(`${sha(OLD)}  ${ASSET}\n`) : new Response(OLD))) as unknown as typeof fetch;
    const out = await update(f.sys);
    expect(out).toContain("already up to date");
    expect(sudoCalls(f.calls)).toEqual([]);
    expect(f.calls.some((c) => c.includes("restart"))).toBe(false);
  });

  test("--binary installs that file and downloads nothing", async () => {
    const f = fake({ files: { "/tmp/mine": NEW } });
    await update(f.sys, { binary: "/tmp/mine" });
    expect(f.fetched).toEqual([]);
    expect(f.written.get("/tmp/fake/claude-rc-launcher")).toEqual(NEW);
    expect(sudoCalls(f.calls)).toContain("systemctl restart claude-rc-launcher");
  });

  test("--binary works on an architecture without a release build", async () => {
    const f = fake({ arch: "riscv64", files: { "/tmp/mine": NEW } });
    await update(f.sys, { binary: "/tmp/mine" });
    expect(sudoCalls(f.calls)).toContain("systemctl restart claude-rc-launcher");
  });

  test("--release picks that release", async () => {
    const f = fake();
    await update(f.sys, { release: "v0.2.0" });
    expect(f.fetched).toEqual([`${RELEASE}/download/v0.2.0/${ASSET}`, `${RELEASE}/download/v0.2.0/SHA256SUMS`]);
  });

  test("the default is the latest release", async () => {
    const f = fake();
    await update(f.sys);
    expect(f.fetched[0]).toBe(`${RELEASE}/latest/download/${ASSET}`);
  });

  test("a checksum mismatch installs nothing", async () => {
    const f = fake({ sums: `${"0".repeat(64)}  ${ASSET}\n` });
    const e = await fails(update(f.sys));
    expect(e!.message).toContain("Nothing was installed");
    expect(f.calls.filter((c) => c.startsWith("sudo "))).toEqual([]);
  });

  describe("refusals before any change", () => {
    const untouched = (f: ReturnType<typeof fake>) => {
      expect(f.fetched).toEqual([]);
      expect(f.calls.filter((c) => c.startsWith("sudo "))).toEqual([]);
    };
    test("not Linux", async () => {
      const f = fake({ platform: "darwin" });
      expect((await fails(update(f.sys)))!.message).toContain("Linux");
      untouched(f);
    });
    test("no systemctl", async () => {
      const f = fake({ noSystemctl: true });
      expect((await fails(update(f.sys)))!.message).toContain("systemctl");
      untouched(f);
    });
    test("an unsupported architecture", async () => {
      const f = fake({ arch: "riscv64" });
      const e = await fails(update(f.sys));
      expect(e!.message).toContain("unsupported CPU architecture: riscv64");
      untouched(f);
    });
    test("the node is not installed", async () => {
      const f = fake({ installed: false });
      expect((await fails(update(f.sys)))!.message).toContain("claude-rc node setup");
      untouched(f);
    });
    test("the unit is missing", async () => {
      const f = fake();
      f.sys.exists = (p) => p === BIN;
      expect((await fails(update(f.sys)))!.message).toContain("claude-rc node setup");
      untouched(f);
    });
    test("--binary and --release together", async () => {
      const f = fake();
      const e = await fails(update(f.sys, { binary: "/tmp/mine", release: "v0.2.0" }));
      expect(e!.message).toContain("--binary and --release");
      untouched(f);
    });
  });

  test("the config, the unit and the certificate are never written", async () => {
    const f = fake();
    await update(f.sys);
    for (const c of sudoCalls(f.calls)) {
      expect(c.startsWith("tee")).toBe(false);
      expect(c).not.toContain(CONFIG);
      expect(c).not.toContain(UNIT_PATH);
      expect(c).not.toContain("node-cert.pem");
      expect(c).not.toContain("daemon-reload");
    }
  });
});

describe("claude-rc node update", () => {
  function cli(sys: Sys) {
    const hubCalls: string[] = [];
    const env: Env = {
      credsFile: path.join(mkdtempSync(path.join(os.tmpdir(), "rc-upd-")), "none.json"),
      open: async () => {},
      readLine: async () => "",
      fetch: (async (u: string | URL) => void hubCalls.push(String(u))) as unknown as typeof fetch,
      sys,
    };
    const out: string[] = [];
    const err: string[] = [];
    const run = async (...argv: string[]) => ({ code: await main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) }, env), out, err });
    return { run, hubCalls };
  }

  test("runs without a saved login and sends nothing to the hub", async () => {
    const f = fake();
    const c = cli(f.sys);
    const r = await c.run("node", "update");
    expect(r.code).toBe(0);
    expect(r.out.at(-1)).toContain("and restarted claude-rc-launcher");
    expect(c.hubCalls).toEqual([]);
  });

  test("passes --binary and --release through", async () => {
    const f = fake();
    const r = await cli(f.sys).run("node", "update", "--release", "v0.2.0");
    expect(r.code).toBe(0);
    expect(f.fetched[0]).toContain("download/v0.2.0/");
  });

  test("rejects extra positional arguments", async () => {
    const f = fake();
    const r = await cli(f.sys).run("node", "update", "extra");
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("unexpected argument: extra");
    expect(f.calls).toEqual([]);
  });

  for (const [flag, value] of [["--hub", "https://rc.example.com"], ["--force", ""], ["--listen", "10.0.0.9"], ["--name", "x"], ["--roots", "/a"], ["--url", "https://x"], ["--service-user", "kir"]] as const) {
    test(`rejects ${flag}, which does not apply to node update`, async () => {
      const f = fake();
      const r = await cli(f.sys).run("node", "update", flag, ...(value ? [value] : []));
      expect(r.code).toBe(1);
      expect(r.err.join("\n")).toContain(`${flag} does not apply to node update`);
      expect(r.err.join("\n")).toContain("claude-rc node update [--binary <file>] [--release <tag>]");
      expect(f.calls).toEqual([]);
    });
  }

  test("rejects unknown flags", async () => {
    const r = await cli(fake().sys).run("node", "update", "--bogus");
    expect(r.code).toBe(1);
  });

  test("a failure exits with its code", async () => {
    const r = await cli(fake({ installed: false }).sys).run("node", "update");
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("claude-rc node setup");
  });
});

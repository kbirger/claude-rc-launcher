import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExitError } from "../src/creds";
import { main } from "../src/index";
import type { Env } from "../src/index";
import { nodeUpdate } from "../src/nodesetup";
import type { Sys } from "../src/nodesetup";
import { defined } from "./support";

const BIN = "/usr/local/bin/claude-rc-launcher";
const UNIT_PATH = "/etc/systemd/system/claude-rc-launcher.service";
const CONFIG = "/etc/claude-rc-launcher/config.toml";
const ASSET = "claude-rc-launcher-linux-x64";
const RELEASE = "https://github.com/kbirger/claude-rc-launcher/releases";
const OLD = new TextEncoder().encode("#!old-binary");
const NEW = new TextEncoder().encode("#!new-binary");
const sha = (uint8Array: Uint8Array) => createHash("sha256").update(uint8Array).digest("hex");

interface Opts {
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
}

function fake(opts: Opts = {}) {
  const calls: string[] = [];
  const fetched: string[] = [];
  const written = new Map<string, Uint8Array>();
  let clock = 0;
  let polls = 0;
  const seen = new Map<string, number>();
  const existing = new Set(opts.installed === false ? [] : [BIN, UNIT_PATH]);
  const sys: Sys = {
    platform: opts.platform ?? "linux",
    arch: opts.arch ?? "x64",
    isRoot: () => false,
    hasCommand: (name) => !(opts.noSystemctl && name === "systemctl"),
    localAddresses: () => [],
    exists: (file) => existing.has(file),
    run(args) {
      calls.push(`run ${args.join(" ")}`);

      if (args[0] === "systemctl" && args[1] === "is-active") {
        const seq = opts.active ?? [true];
        const up = seq[Math.min(polls++, seq.length - 1)];
        return { code: up ? 0 : 3, stdout: up ? "active" : "failed" };
      }

      return { code: 0, stdout: "" };
    },
    sudo(args) {
      const cmd = args.join(" ");
      calls.push(`sudo ${cmd}`);
      const nth = seen.get(cmd) ?? 0;
      seen.set(cmd, nth + 1);
      if (opts.fail?.(cmd, nth)) return { code: 1, stdout: "", stderr: "denied" };
      if (args[0] === "journalctl")
        return { code: 0, stdout: opts.journal ?? "Nov 07 node[1]: boom: port in use", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    readFile: (file) => (file === BIN ? OLD : (opts.files?.[file] ?? new Uint8Array())),
    writeTemp(name, data) {
      written.set(`/tmp/fake/${name}`, data);
      return `/tmp/fake/${name}`;
    },
    removeTemp: (file) => void calls.push(`rm ${file}`),
    fetch: ((url: string | URL) => {
      const text = String(url);
      fetched.push(text);
      if (text === `${RELEASE}/latest/download/${ASSET}` || text === `${RELEASE}/download/v0.2.0/${ASSET}`)
        return Promise.resolve(new Response(NEW));
      if (text.endsWith("/SHA256SUMS")) return Promise.resolve(new Response(opts.sums ?? `${sha(NEW)}  ${ASSET}\n`));
      return Promise.resolve(new Response("nope", { status: 404 }));
    }) as unknown as typeof fetch,
    sleep: (ms) => {
      calls.push(`sleep ${ms}`);
      clock += ms;
      return Promise.resolve();
    },
    now: () => clock,
  };
  return { sys, calls, fetched, written, clock: () => clock };
}

async function update(sys: Sys, flags: Record<string, unknown> = {}) {
  const out: string[] = [];
  await nodeUpdate({ flags: flags, out: (line) => out.push(line), sys });
  return out;
}

const fails = async (promise: Promise<unknown>) =>
  (await promise.then(
    () => undefined,
    (entry) => entry,
  )) as ExitError | undefined;
const sudoCalls = (calls: string[]) => calls.filter((call) => call.startsWith("sudo ")).map((call) => call.slice(5));

describe("nodeUpdate", () => {
  test("the happy path backs up, installs, restarts and waits for the service, in order", async () => {
    const harness = fake();
    const out = await update(harness.sys);
    const steps = [
      `install -m 755 /tmp/fake/claude-rc-launcher ${BIN}.new`,
      `cp -p ${BIN} ${BIN}.prev`,
      `mv -f ${BIN}.new ${BIN}`,
      "systemctl restart claude-rc-launcher",
    ];
    expect(sudoCalls(harness.calls)).toEqual(steps);
    expect(harness.calls.slice(harness.calls.indexOf("sudo systemctl restart claude-rc-launcher") + 1)).toEqual([
      "run systemctl is-active claude-rc-launcher",
      "sleep 2000",
      "run systemctl is-active claude-rc-launcher",
    ]);
    expect(harness.written.get("/tmp/fake/claude-rc-launcher")).toEqual(NEW);
    const restart = harness.calls.indexOf("sudo systemctl restart claude-rc-launcher");
    expect(harness.calls.slice(restart + 1).some((call) => call === "run systemctl is-active claude-rc-launcher")).toBe(
      true,
    );
    expect(harness.calls.some((call) => call.startsWith("sudo journalctl"))).toBe(false);
    expect(out.at(-1)).toBe(
      `updated ${BIN} (the previous binary is kept as ${BIN}.prev) and restarted claude-rc-launcher`,
    );
  });

  test("a service that is active and then inactive within the 2 second window fails and rolls back", async () => {
    const harness = fake({ active: [true, false] });
    const exitError = await fails(update(harness.sys));
    expect(exitError).toBeInstanceOf(ExitError);
    const position = harness.calls.indexOf("sleep 2000");
    expect(harness.calls.slice(position - 1, position + 2)).toEqual([
      "run systemctl is-active claude-rc-launcher",
      "sleep 2000",
      "run systemctl is-active claude-rc-launcher",
    ]);
    expect(sudoCalls(harness.calls)).toContain(`mv -f ${BIN}.prev ${BIN}`);
  });

  test("a service that becomes active after a few polls is accepted", async () => {
    const harness = fake({ active: [false, false, true] });
    const out = await update(harness.sys);
    expect(out.at(-1)).toContain("and restarted claude-rc-launcher");
    expect(sudoCalls(harness.calls).filter((sudoCall) => sudoCall.startsWith("systemctl restart"))).toHaveLength(1);
  });

  test("a failed health check restores the previous binary, restarts again and prints the journal", async () => {
    const harness = fake({ active: [false] });
    const out: string[] = [];
    const exitError = await fails(nodeUpdate({ flags: {}, out: (line) => out.push(line), sys: harness.sys }));
    expect(exitError).toBeInstanceOf(ExitError);
    expect(defined(exitError).code).toBe(1);
    expect(defined(exitError).message).toContain("update failed");
    expect(defined(exitError).message).toContain("previous binary was restored");
    expect(harness.clock()).toBeGreaterThanOrEqual(30_000);
    const sudo = sudoCalls(harness.calls);
    const restore = sudo.indexOf(`mv -f ${BIN}.prev ${BIN}`);
    expect(restore).toBeGreaterThan(sudo.indexOf(`mv -f ${BIN}.new ${BIN}`));
    expect(sudo.slice(restore + 1)).toContain("systemctl restart claude-rc-launcher");
    expect(sudo.at(-1)).toBe("journalctl -u claude-rc-launcher -n 15 --no-pager");
    expect(out.join("\n")).toContain("boom: port in use");
  });

  describe("failures during the install", () => {
    const noReplace = (returnType: ReturnType<typeof fake>) => {
      expect(returnType.calls.some((call) => call.includes("systemctl restart"))).toBe(false);
      expect(returnType.calls.some((call) => call.includes(`mv -f ${BIN}.prev`))).toBe(false);
    };

    test("cp -p failing removes .new and leaves the binary untouched", async () => {
      const harness = fake({ fail: (value) => value.startsWith("cp -p") });
      const exitError = await fails(update(harness.sys));
      expect(defined(exitError).message).toContain("backing up");
      expect(sudoCalls(harness.calls)).toEqual([
        `install -m 755 /tmp/fake/claude-rc-launcher ${BIN}.new`,
        `cp -p ${BIN} ${BIN}.prev`,
        `rm -f ${BIN}.new`,
      ]);
      noReplace(harness);
    });
    test("install failing leaves the binary untouched and does not restart", async () => {
      const harness = fake({ fail: (entry) => entry.startsWith("install ") });
      expect(await fails(update(harness.sys))).toBeInstanceOf(ExitError);
      expect(sudoCalls(harness.calls).some((sudoCall) => sudoCall.startsWith(`mv -f ${BIN}.new`))).toBe(false);
      expect(harness.calls.some((call) => call.includes(".prev"))).toBe(false);
      noReplace(harness);
    });
    test("mv failing removes the .new file, leaves the binary untouched and does not restart", async () => {
      const harness = fake({ fail: (entry) => entry === `mv -f ${BIN}.new ${BIN}` });
      expect(await fails(update(harness.sys))).toBeInstanceOf(ExitError);
      expect(sudoCalls(harness.calls).at(-1)).toBe(`rm -f ${BIN}.new`);
      noReplace(harness);
    });
  });

  test("systemctl restart returning non-zero triggers the rollback", async () => {
    const harness = fake({ fail: (value, count) => value === "systemctl restart claude-rc-launcher" && count === 0 });
    const exitError = await fails(update(harness.sys));
    expect(defined(exitError).message).toContain("previous binary was restored");
    expect(sudoCalls(harness.calls)).toContain(`mv -f ${BIN}.prev ${BIN}`);
    expect(harness.calls.some((call) => call.includes("is-active"))).toBe(false);
  });

  test("when the restore mv fails the message says the new binary is still installed and gives the manual command", async () => {
    const harness = fake({ active: [false], fail: (value) => value === `mv -f ${BIN}.prev ${BIN}` });
    const exitError = await fails(update(harness.sys));
    expect(defined(exitError).message).toContain("NEW binary is still installed");
    expect(defined(exitError).message).toContain(
      `sudo mv -f ${BIN}.prev ${BIN} && sudo systemctl restart claude-rc-launcher`,
    );
    expect(sudoCalls(harness.calls).filter((sudoCall) => sudoCall.startsWith("systemctl restart"))).toHaveLength(1);
  });

  test("when the second restart fails the message says the service did not restart and the journal is shown", async () => {
    const harness = fake({
      active: [false],
      fail: (value, count) => value === "systemctl restart claude-rc-launcher" && count === 1,
    });
    const out: string[] = [];
    const exitError = await fails(nodeUpdate({ flags: {}, out: (line) => out.push(line), sys: harness.sys }));
    expect(defined(exitError).message).toContain("back in place");
    expect(defined(exitError).message).toContain("did not restart");
    expect(defined(exitError).message).not.toContain("service was restarted");
    expect(out.join("\n")).toContain("boom: port in use");
  });

  test("an empty journal prints no blank line", async () => {
    const harness = fake({ active: [false], journal: "" });
    const out: string[] = [];
    await fails(nodeUpdate({ flags: {}, out: (line) => out.push(line), sys: harness.sys }));
    expect(out.filter((item) => item === "")).toEqual([]);
  });

  test("the same checksum as the installed binary changes nothing and does not restart", async () => {
    const harness = fake({ sums: `${sha(OLD)}  ${ASSET}\n` });
    harness.sys.fetch = ((url: string | URL) =>
      Promise.resolve(
        String(url).endsWith("/SHA256SUMS") ? new Response(`${sha(OLD)}  ${ASSET}\n`) : new Response(OLD),
      )) as unknown as typeof fetch;
    const out = await update(harness.sys);
    expect(out).toContain("already up to date");
    expect(sudoCalls(harness.calls)).toEqual([]);
    expect(harness.calls.some((call) => call.includes("restart"))).toBe(false);
  });

  test("--binary installs that file and downloads nothing", async () => {
    const harness = fake({ files: { "/tmp/mine": NEW } });
    await update(harness.sys, { binary: "/tmp/mine" });
    expect(harness.fetched).toEqual([]);
    expect(harness.written.get("/tmp/fake/claude-rc-launcher")).toEqual(NEW);
    expect(sudoCalls(harness.calls)).toContain("systemctl restart claude-rc-launcher");
  });

  test("--binary works on an architecture without a release build", async () => {
    const harness = fake({ arch: "riscv64", files: { "/tmp/mine": NEW } });
    await update(harness.sys, { binary: "/tmp/mine" });
    expect(sudoCalls(harness.calls)).toContain("systemctl restart claude-rc-launcher");
  });

  test("--release picks that release", async () => {
    const harness = fake();
    await update(harness.sys, { release: "v0.2.0" });
    expect(harness.fetched).toEqual([`${RELEASE}/download/v0.2.0/${ASSET}`, `${RELEASE}/download/v0.2.0/SHA256SUMS`]);
  });

  test("the default is the latest release", async () => {
    const harness = fake();
    await update(harness.sys);
    expect(harness.fetched[0]).toBe(`${RELEASE}/latest/download/${ASSET}`);
  });

  test("a checksum mismatch installs nothing", async () => {
    const harness = fake({ sums: `${"0".repeat(64)}  ${ASSET}\n` });
    const exitError = await fails(update(harness.sys));
    expect(defined(exitError).message).toContain("Nothing was installed");
    expect(harness.calls.filter((call) => call.startsWith("sudo "))).toEqual([]);
  });

  describe("refusals before any change", () => {
    const untouched = (returnType: ReturnType<typeof fake>) => {
      expect(returnType.fetched).toEqual([]);
      expect(returnType.calls.filter((call) => call.startsWith("sudo "))).toEqual([]);
    };

    test("not Linux", async () => {
      const harness = fake({ platform: "darwin" });
      expect(defined(await fails(update(harness.sys))).message).toContain("Linux");
      untouched(harness);
    });
    test("no systemctl", async () => {
      const harness = fake({ noSystemctl: true });
      expect(defined(await fails(update(harness.sys))).message).toContain("systemctl");
      untouched(harness);
    });
    test("an unsupported architecture", async () => {
      const harness = fake({ arch: "riscv64" });
      const exitError = await fails(update(harness.sys));
      expect(defined(exitError).message).toContain("unsupported CPU architecture: riscv64");
      untouched(harness);
    });
    test("the node is not installed", async () => {
      const harness = fake({ installed: false });
      expect(defined(await fails(update(harness.sys))).message).toContain("claude-rc node setup");
      untouched(harness);
    });
    test("the unit is missing", async () => {
      const harness = fake();
      harness.sys.exists = (entry) => entry === BIN;
      expect(defined(await fails(update(harness.sys))).message).toContain("claude-rc node setup");
      untouched(harness);
    });
    test("--binary and --release together", async () => {
      const harness = fake();
      const exitError = await fails(update(harness.sys, { binary: "/tmp/mine", release: "v0.2.0" }));
      expect(defined(exitError).message).toContain("--binary and --release");
      untouched(harness);
    });
  });

  test("the config, the unit and the certificate are never written", async () => {
    const harness = fake();
    await update(harness.sys);

    for (const sudoCall of sudoCalls(harness.calls)) {
      expect(sudoCall.startsWith("tee")).toBe(false);
      expect(sudoCall).not.toContain(CONFIG);
      expect(sudoCall).not.toContain(UNIT_PATH);
      expect(sudoCall).not.toContain("node-cert.pem");
      expect(sudoCall).not.toContain("daemon-reload");
    }
  });
});

describe("claude-rc node update", () => {
  function cli(sys: Sys) {
    const hubCalls: string[] = [];
    const env: Env = {
      credsFile: path.join(mkdtempSync(path.join(os.tmpdir(), "rc-upd-")), "none.json"),
      open: async () => {},
      readLine: () => Promise.resolve(""),
      fetch: ((item: string | URL) => Promise.resolve(void hubCalls.push(String(item)))) as unknown as typeof fetch,
      sys,
    };
    const out: string[] = [];
    const err: string[] = [];
    const run = async (...argv: string[]) => ({
      code: await main(argv, { out: (line) => out.push(line), err: (line) => err.push(line) }, env),
      out,
      err,
    });
    return { run, hubCalls };
  }

  test("runs without a saved login and sends nothing to the hub", async () => {
    const harness = fake();
    const fixture = cli(harness.sys);
    const outcome = await fixture.run("node", "update");
    expect(outcome.code).toBe(0);
    expect(outcome.out.at(-1)).toContain("and restarted claude-rc-launcher");
    expect(fixture.hubCalls).toEqual([]);
  });

  test("passes --binary and --release through", async () => {
    const harness = fake();
    const outcome = await cli(harness.sys).run("node", "update", "--release", "v0.2.0");
    expect(outcome.code).toBe(0);
    expect(harness.fetched[0]).toContain("download/v0.2.0/");
  });

  test("rejects extra positional arguments", async () => {
    const harness = fake();
    const outcome = await cli(harness.sys).run("node", "update", "extra");
    expect(outcome.code).toBe(1);
    expect(outcome.err.join("\n")).toContain("unexpected argument: extra");
    expect(harness.calls).toEqual([]);
  });

  for (const [flag, value] of [
    ["--hub", "https://rc.example.com"],
    ["--force", ""],
    ["--listen", "10.0.0.9"],
    ["--name", "x"],
    ["--roots", "/a"],
    ["--url", "https://x"],
    ["--service-user", "kir"],
  ] as const) {
    test(`rejects ${flag}, which does not apply to node update`, async () => {
      const harness = fake();
      const outcome = await cli(harness.sys).run("node", "update", flag, ...(value ? [value] : []));
      expect(outcome.code).toBe(1);
      expect(outcome.err.join("\n")).toContain(`${flag} does not apply to node update`);
      expect(outcome.err.join("\n")).toContain("claude-rc node update [--binary <file>] [--release <tag>]");
      expect(harness.calls).toEqual([]);
    });
  }

  test("rejects unknown flags", async () => {
    const outcome = await cli(fake().sys).run("node", "update", "--bogus");
    expect(outcome.code).toBe(1);
  });

  test("a failure exits with its code", async () => {
    const outcome = await cli(fake({ installed: false }).sys).run("node", "update");
    expect(outcome.code).toBe(1);
    expect(outcome.err.join("\n")).toContain("claude-rc node setup");
  });
});

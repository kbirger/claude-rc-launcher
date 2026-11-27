import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { VERSION } from "../../server/src/shared/version";
import { ExitError } from "../src/creds";
import { main } from "../src/index";
import type { Env } from "../src/index";
import type { Sys } from "../src/nodesetup";
import { selfUpdate } from "../src/update";
import { defined } from "./support";

const EXE = "/usr/local/bin/claude-rc";
const ASSET = "claude-rc-linux-x64";
const RELEASE = "https://github.com/kbirger/claude-rc-launcher/releases";
const OLD = new TextEncoder().encode("#!old-binary");
const NEW = new TextEncoder().encode("#!new-binary");
const sha = (uint8Array: Uint8Array) => createHash("sha256").update(uint8Array).digest("hex");
const USAGE = "claude-rc update [--release <tag>]";

interface Opts {
  execPath?: string;
  platform?: string;
  arch?: string;
  sums?: string;
  writable?: boolean;
  root?: boolean;
  /** The output of the new binary's --version. */
  version?: { code: number; stdout: string };
  /** Makes a command fail. It gets the command line (without sudo). */
  fail?: (cmd: string) => boolean;
  /** What stderr a failed plain command reports. */
  stderr?: string;
  /** Leaves out Sys.writable and Sys.execPath. */
  bare?: boolean;
}

function fake(item: Opts = {}) {
  const calls: string[] = [];
  const fetched: string[] = [];
  const timeouts: (number | undefined)[] = [];
  const written = new Map<string, Uint8Array>();
  const exe = item.execPath ?? EXE;
  const sys: Sys = {
    platform: item.platform ?? "linux",
    arch: item.arch ?? "x64",
    execPath: exe,
    isRoot: () => item.root ?? false,
    hasCommand: () => true,
    localAddresses: () => [],
    exists: () => true,
    writable: (entry) => (calls.push(`writable ${entry}`), item.writable ?? true),
    run(args, opts) {
      const cmd = args.join(" ");
      calls.push(`run ${cmd}`);
      if (args[1] === "--version") timeouts.push(opts?.timeoutMs);
      if (item.fail?.(cmd)) return { code: 1, stdout: "", stderr: item.stderr ?? "" };
      if (args[0] === exe && args[1] === "--version") return item.version ?? { code: 0, stdout: "claude-rc 9.9.9\n" };
      return { code: 0, stdout: "" };
    },
    sudo(args) {
      const cmd = args.join(" ");
      calls.push(`sudo ${cmd}`);
      if (item.fail?.(cmd)) return { code: 1, stdout: "", stderr: "denied" };
      return { code: 0, stdout: "", stderr: "" };
    },
    readFile: (path) => (path === exe ? OLD : new Uint8Array()),
    writeTemp(name, data) {
      written.set(`/tmp/fake/${name}`, data);
      return `/tmp/fake/${name}`;
    },
    removeTemp: (path) => void calls.push(`rm ${path}`),
    fetch: ((url: string | URL) => {
      const text = String(url);
      fetched.push(text);
      if (text === `${RELEASE}/latest/download/${ASSET}` || text === `${RELEASE}/download/v0.3.0/${ASSET}`)
        return Promise.resolve(new Response(NEW));
      if (text.endsWith("/SHA256SUMS")) return Promise.resolve(new Response(item.sums ?? `${sha(NEW)}  ${ASSET}\n`));
      return Promise.resolve(new Response("nope", { status: 404 }));
    }) as unknown as typeof fetch,
    sleep: async () => {},
    now: () => 0,
  };

  if (item.bare) {
    delete sys.execPath;
    delete sys.writable;
  }

  return { sys, calls, fetched, written, timeouts };
}

async function update(sys: Sys, flags: Record<string, unknown> = {}) {
  const out: string[] = [];
  await selfUpdate({ flags: flags, out: (line) => out.push(line), sys });
  return out;
}

const fails = async (promise: Promise<unknown>) =>
  (await promise.then(
    () => undefined,
    (entry) => entry,
  )) as ExitError | undefined;
const changes = (calls: string[]) => calls.filter((call) => /^(sudo|run) (cp|install|mv|rm) /.test(call));

describe("selfUpdate", () => {
  test("the happy path backs up, installs, replaces and checks the new binary, in order", async () => {
    const harness = fake();
    const out = await update(harness.sys);
    expect(harness.calls.filter((call) => !call.startsWith("writable"))).toEqual([
      `run install -m 755 /tmp/fake/claude-rc ${EXE}.new`,
      `run cp -p ${EXE} ${EXE}.prev`,
      `run mv -f ${EXE}.new ${EXE}`,
      "rm /tmp/fake/claude-rc",
      `run ${EXE} --version`,
    ]);
    expect(harness.written.get("/tmp/fake/claude-rc")).toEqual(NEW);
    expect(out.at(-1)).toBe(`updated ${EXE} from ${VERSION} to 9.9.9 (the previous binary is kept as ${EXE}.prev)`);
  });

  test("the directory of the executable is the one that is tested for write access", async () => {
    const harness = fake();
    await update(harness.sys);
    expect(harness.calls).toContain("writable /usr/local/bin");
  });

  test("sudo is used for every change when the directory is not writable", async () => {
    const harness = fake({ writable: false });
    await update(harness.sys);
    expect(harness.calls.filter((call) => !call.startsWith("writable"))).toEqual([
      `sudo install -m 755 /tmp/fake/claude-rc ${EXE}.new`,
      `sudo cp -p ${EXE} ${EXE}.prev`,
      `sudo mv -f ${EXE}.new ${EXE}`,
      "rm /tmp/fake/claude-rc",
      `run ${EXE} --version`,
    ]);
  });

  test("no sudo is used when the directory is writable", async () => {
    const harness = fake();
    await update(harness.sys);
    expect(harness.calls.some((call) => call.startsWith("sudo "))).toBe(false);
  });

  test("--release picks that release", async () => {
    const harness = fake();
    await update(harness.sys, { release: "v0.3.0" });
    expect(harness.fetched).toEqual([`${RELEASE}/download/v0.3.0/${ASSET}`, `${RELEASE}/download/v0.3.0/SHA256SUMS`]);
  });

  test("the default is the latest release", async () => {
    const harness = fake();
    await update(harness.sys);
    expect(harness.fetched).toEqual([`${RELEASE}/latest/download/${ASSET}`, `${RELEASE}/latest/download/SHA256SUMS`]);
  });

  test("macOS on arm64 downloads claude-rc-darwin-arm64", async () => {
    const harness = fake({ platform: "darwin", arch: "arm64" });
    harness.sys.fetch = ((url: string | URL) => {
      harness.fetched.push(String(url));
      return Promise.resolve(
        String(url).endsWith("SHA256SUMS") ? new Response(`${sha(NEW)}  claude-rc-darwin-arm64\n`) : new Response(NEW),
      );
    }) as unknown as typeof fetch;
    await update(harness.sys);
    expect(harness.fetched[0]).toBe(`${RELEASE}/latest/download/claude-rc-darwin-arm64`);
  });

  test("an executable in another directory is updated in place", async () => {
    const harness = fake({ execPath: "/opt/x/claude-rc" });
    await update(harness.sys);
    expect(harness.calls).toContain("run cp -p /opt/x/claude-rc /opt/x/claude-rc.prev");
  });

  test("without Sys.execPath the running process.execPath is used", async () => {
    const harness = fake({ bare: true, execPath: process.execPath });
    const exitError = await fails(update(harness.sys));
    // the test runner is bun, which is a source run
    expect(defined(exitError).message).toContain("source run");
    expect(harness.calls).toEqual([]);
  });

  test("without Sys.writable the sudo path is used", async () => {
    const harness = fake({ bare: true, execPath: EXE });
    harness.sys.execPath = EXE;
    await update(harness.sys);
    expect(harness.calls.some((call) => call === `sudo mv -f ${EXE}.new ${EXE}`)).toBe(true);
    expect(harness.calls.some((call) => call.startsWith("run cp") || call.startsWith("run mv"))).toBe(false);
  });

  test("a checksum mismatch installs nothing", async () => {
    const harness = fake({ sums: `${"0".repeat(64)}  ${ASSET}\n` });
    const exitError = await fails(update(harness.sys));
    expect(defined(exitError).message).toContain("Nothing was installed");
    expect(changes(harness.calls)).toEqual([]);
  });

  test("the same checksum as the running executable changes nothing", async () => {
    const harness = fake();
    harness.sys.fetch = ((url: string | URL) =>
      Promise.resolve(
        String(url).endsWith("/SHA256SUMS") ? new Response(`${sha(OLD)}  ${ASSET}\n`) : new Response(OLD),
      )) as unknown as typeof fetch;
    const out = await update(harness.sys);
    expect(out).toEqual([`downloading ${ASSET} (latest release)`, `claude-rc is already up to date (${VERSION})`]);
    expect(changes(harness.calls)).toEqual([]);
    expect(harness.calls.some((call) => call.includes("--version"))).toBe(false);
  });

  describe("failures after the replace", () => {
    for (const [what, version] of [
      ["a non-zero exit", { code: 1, stdout: "claude-rc 9.9.9\n" }],
      ["output that does not start with claude-rc", { code: 0, stdout: "something else\n" }],
      ["empty output", { code: 0, stdout: "" }],
    ] as const) {
      test(`${what} restores .prev`, async () => {
        const harness = fake({ version });
        const exitError = await fails(update(harness.sys));
        expect(exitError).toBeInstanceOf(ExitError);
        expect(defined(exitError).code).toBe(1);
        expect(defined(exitError).message).toContain("update failed");
        expect(defined(exitError).message).toContain("previous binary was restored");
        expect(harness.calls.at(-1)).toBe(`run mv -f ${EXE}.prev ${EXE}`);
        expect(harness.calls.indexOf(`run mv -f ${EXE}.prev ${EXE}`)).toBeGreaterThan(
          harness.calls.indexOf(`run ${EXE} --version`),
        );
      });
    }

    test("the version check has a 10 second timeout and a timeout restores .prev", async () => {
      const harness = fake({ version: { code: 1, stdout: "" } });
      const exitError = await fails(update(harness.sys));
      expect(harness.timeouts).toEqual([10_000]);
      expect(defined(exitError).message).toContain("did not answer");
      expect(defined(exitError).message).toContain("10 seconds");
      expect(harness.calls.at(-1)).toBe(`run mv -f ${EXE}.prev ${EXE}`);
    });

    test("the restore uses sudo when the directory is not writable", async () => {
      const harness = fake({ writable: false, version: { code: 1, stdout: "" } });
      await fails(update(harness.sys));
      expect(harness.calls.at(-1)).toBe(`sudo mv -f ${EXE}.prev ${EXE}`);
    });

    test("when the restore fails the message gives the manual command", async () => {
      const harness = fake({ version: { code: 1, stdout: "" }, fail: (value) => value === `mv -f ${EXE}.prev ${EXE}` });
      const exitError = await fails(update(harness.sys));
      expect(defined(exitError).message).toContain("could not be restored");
      expect(defined(exitError).message).toContain("NEW binary is still installed");
      expect(defined(exitError).message).toContain(`mv -f ${EXE}.prev ${EXE}`);
    });
  });

  describe("failures during the install", () => {
    test("cp -p failing removes .new and leaves the executable untouched", async () => {
      const harness = fake({ fail: (value) => value.startsWith("cp -p") });
      const exitError = await fails(update(harness.sys));
      expect(defined(exitError).message).toContain("backing up");
      expect(changes(harness.calls)).toEqual([
        `run install -m 755 /tmp/fake/claude-rc ${EXE}.new`,
        `run cp -p ${EXE} ${EXE}.prev`,
        `run rm -f ${EXE}.new`,
      ]);
    });
    test("install failing never touches an existing .prev and removes .new", async () => {
      const harness = fake({ fail: (entry) => entry.startsWith("install ") });
      expect(await fails(update(harness.sys))).toBeInstanceOf(ExitError);
      expect(harness.calls.some((call) => call.includes(".prev"))).toBe(false);
      expect(harness.calls).toContain(`run rm -f ${EXE}.new`);
      expect(harness.calls.some((call) => call.startsWith(`run mv -f ${EXE}.new`))).toBe(false);
      expect(harness.calls.some((call) => call.includes("--version"))).toBe(false);
    });
    test("a failure shows the stderr of a plain command", async () => {
      const harness = fake({ fail: (entry) => entry.startsWith("install "), stderr: "Text file busy\n" });
      expect(defined(await fails(update(harness.sys))).message).toContain(
        "installing the binary failed (install exit 1): Text file busy",
      );
    });
    test("mv failing removes the .new file", async () => {
      const harness = fake({ fail: (entry) => entry === `mv -f ${EXE}.new ${EXE}` });
      expect(await fails(update(harness.sys))).toBeInstanceOf(ExitError);
      expect(harness.calls).toContain(`run rm -f ${EXE}.new`);
      expect(harness.calls.some((call) => call.includes("--version"))).toBe(false);
    });
  });

  describe("refusals before any call", () => {
    const untouched = (returnType: ReturnType<typeof fake>) => {
      expect(returnType.fetched).toEqual([]);
      expect(returnType.calls).toEqual([]);
    };

    for (const path of ["/usr/bin/bun", "/usr/bin/node", "/usr/local/bin/claude-rc-launcher"]) {
      test(`running as ${path} is a source run`, async () => {
        const harness = fake({ execPath: path });
        const exitError = await fails(update(harness.sys));
        expect(defined(exitError).message).toContain(
          "claude-rc update works on the installed binary only. This looks like a source run",
        );
        untouched(harness);
      });
    }

    test("Windows", async () => {
      const harness = fake({ platform: "win32", execPath: "C:\\bin\\claude-rc.exe" });
      const exitError = await fails(update(harness.sys));
      expect(defined(exitError).message).toContain(
        "updating on Windows is not supported yet. Download the new claude-rc-windows-x64.exe from the release page",
      );
      untouched(harness);
    });
    test("an unsupported operating system", async () => {
      const harness = fake({ platform: "freebsd" });
      expect(defined(await fails(update(harness.sys))).message).toContain("unsupported operating system: freebsd");
      untouched(harness);
    });
    test("an unsupported CPU", async () => {
      const harness = fake({ arch: "riscv64" });
      expect(defined(await fails(update(harness.sys))).message).toContain("unsupported CPU architecture: riscv64");
      untouched(harness);
    });
  });
});

describe("claude-rc update", () => {
  function cli(sys: Sys) {
    const touched: string[] = [];
    const env: Env = {
      get credsFile(): string {
        touched.push("credsFile");
        return "/nonexistent/credentials.json";
      },
      fetch: (() => Promise.resolve(void touched.push("hub fetch"))) as unknown as typeof fetch,
      open: () => Promise.resolve(void touched.push("open")),
      readLine: () => Promise.resolve((touched.push("readLine"), "")),
      sys,
    };
    const out: string[] = [];
    const err: string[] = [];
    const run = async (...argv: string[]) => ({
      code: await main(argv, { out: (line) => out.push(line), err: (line) => err.push(line) }, env),
      out,
      err,
    });
    return { run, touched };
  }

  test("runs without a login and touches neither the credentials nor the hub", async () => {
    const harness = fake();
    const fixture = cli(harness.sys);
    const outcome = await fixture.run("update");
    expect(outcome.code).toBe(0);
    expect(outcome.out.at(-1)).toContain(`updated ${EXE} from`);
    expect(fixture.touched).toEqual([]);
  });

  test("passes --release through", async () => {
    const harness = fake();
    expect((await cli(harness.sys).run("update", "--release", "v0.3.0")).code).toBe(0);
    expect(harness.fetched[0]).toContain("download/v0.3.0/");
  });

  test("rejects extra positional arguments", async () => {
    const harness = fake();
    const outcome = await cli(harness.sys).run("update", "extra");
    expect(outcome.code).toBe(1);
    expect(outcome.err.join("\n")).toContain("unexpected argument: extra");
    expect(outcome.err.join("\n")).toContain(USAGE);
    expect(harness.calls).toEqual([]);
  });

  for (const [flag, value] of [
    ["--hub", "https://rc.example.com"],
    ["--binary", "/tmp/x"],
    ["--force", ""],
    ["--listen", "10.0.0.9"],
    ["--name", "x"],
    ["--host", "pi"],
  ] as const) {
    test(`rejects ${flag}, which does not apply to update`, async () => {
      const harness = fake();
      const outcome = await cli(harness.sys).run("update", flag, ...(value ? [value] : []));
      expect(outcome.code).toBe(1);
      expect(outcome.err.join("\n")).toContain(`${flag} does not apply to update`);
      expect(outcome.err.join("\n")).toContain(USAGE);
      expect(harness.calls).toEqual([]);
    });
  }

  test("a failure exits with its code", async () => {
    const outcome = await cli(fake({ execPath: "/usr/bin/bun" }).sys).run("update");
    expect(outcome.code).toBe(1);
    expect(outcome.err.join("\n")).toContain("source run");
  });

  test("help text lists update", () => {
    return import("../src/index").then((item) => {
      expect(item.USAGE).toContain("update [--release tag]");
    });
  });
});

describe("realSys.run", () => {
  test("kills a command that runs past the timeout and reports a failure", () => {
    const { realSys } = require("../src/nodesetup") as typeof import("../src/nodesetup");
    const item = Date.now();
    const outcome = realSys.run(["sleep", "5"], { timeoutMs: 200 });
    expect(outcome.code).not.toBe(0);
    expect(Date.now() - item).toBeLessThan(3000);
  });
  test("returns stderr", () => {
    const { realSys } = require("../src/nodesetup") as typeof import("../src/nodesetup");
    const outcome = realSys.run(["sh", "-c", "echo oops >&2; exit 3"]);
    expect(outcome).toMatchObject({ code: 3, stderr: "oops\n" });
  });
});

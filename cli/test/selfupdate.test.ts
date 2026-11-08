import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { main, type Env } from "../src/index";
import { ExitError } from "../src/creds";
import { selfUpdate } from "../src/update";
import type { Sys } from "../src/nodesetup";
import { VERSION } from "../../server/src/version";

const EXE = "/usr/local/bin/claude-rc";
const ASSET = "claude-rc-linux-x64";
const RELEASE = "https://github.com/kbirger/claude-rc-launcher/releases";
const OLD = new TextEncoder().encode("#!old-binary");
const NEW = new TextEncoder().encode("#!new-binary");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const USAGE = "claude-rc update [--release <tag>]";

type Opts = {
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
};

function fake(o: Opts = {}) {
  const calls: string[] = [];
  const fetched: string[] = [];
  const written = new Map<string, Uint8Array>();
  const exe = o.execPath ?? EXE;
  const sys: Sys = {
    platform: o.platform ?? "linux",
    arch: o.arch ?? "x64",
    execPath: exe,
    isRoot: () => o.root ?? false,
    hasCommand: () => true,
    localAddresses: () => [],
    exists: () => true,
    writable: (p) => (calls.push(`writable ${p}`), o.writable ?? true),
    run(args) {
      const cmd = args.join(" ");
      calls.push(`run ${cmd}`);
      if (o.fail?.(cmd)) return { code: 1, stdout: "" };
      if (args[0] === exe && args[1] === "--version") return o.version ?? { code: 0, stdout: "claude-rc 9.9.9\n" };
      return { code: 0, stdout: "" };
    },
    sudo(args) {
      const cmd = args.join(" ");
      calls.push(`sudo ${cmd}`);
      if (o.fail?.(cmd)) return { code: 1, stdout: "", stderr: "denied" };
      return { code: 0, stdout: "", stderr: "" };
    },
    readFile: (p) => (p === exe ? OLD : new Uint8Array()),
    writeTemp(name, data) {
      written.set(`/tmp/fake/${name}`, data);
      return `/tmp/fake/${name}`;
    },
    removeTemp: (p) => void calls.push(`rm ${p}`),
    fetch: (async (url: string | URL) => {
      const u = String(url);
      fetched.push(u);
      if (u === `${RELEASE}/latest/download/${ASSET}` || u === `${RELEASE}/download/v0.3.0/${ASSET}`) return new Response(NEW);
      if (u.endsWith("/SHA256SUMS")) return new Response(o.sums ?? `${sha(NEW)}  ${ASSET}\n`);
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch,
    sleep: async () => {},
    now: () => 0,
  };
  return { sys, calls, fetched, written };
}

async function update(sys: Sys, flags: Record<string, unknown> = {}) {
  const out: string[] = [];
  await selfUpdate({ flags: flags as any, out: (s) => out.push(s), sys });
  return out;
}
const fails = async (p: Promise<unknown>) => (await p.then(() => undefined, (e) => e)) as ExitError | undefined;
const changes = (calls: string[]) => calls.filter((c) => /^(sudo|run) (cp|install|mv|rm) /.test(c));

describe("selfUpdate", () => {
  test("the happy path backs up, installs, replaces and checks the new binary, in order", async () => {
    const f = fake();
    const out = await update(f.sys);
    expect(f.calls.filter((c) => !c.startsWith("writable"))).toEqual([
      `run cp -p ${EXE} ${EXE}.prev`,
      `run install -m 755 /tmp/fake/claude-rc ${EXE}.new`,
      `run mv -f ${EXE}.new ${EXE}`,
      "rm /tmp/fake/claude-rc",
      `run ${EXE} --version`,
    ]);
    expect(f.written.get("/tmp/fake/claude-rc")).toEqual(NEW);
    expect(out.at(-1)).toBe(`updated ${EXE} from ${VERSION} to 9.9.9 (the previous binary is kept as ${EXE}.prev)`);
  });

  test("the directory of the executable is the one that is tested for write access", async () => {
    const f = fake();
    await update(f.sys);
    expect(f.calls).toContain("writable /usr/local/bin");
  });

  test("sudo is used for every change when the directory is not writable", async () => {
    const f = fake({ writable: false });
    await update(f.sys);
    expect(f.calls.filter((c) => !c.startsWith("writable"))).toEqual([
      `sudo cp -p ${EXE} ${EXE}.prev`,
      `sudo install -m 755 /tmp/fake/claude-rc ${EXE}.new`,
      `sudo mv -f ${EXE}.new ${EXE}`,
      "rm /tmp/fake/claude-rc",
      `run ${EXE} --version`,
    ]);
  });

  test("no sudo is used when the directory is writable", async () => {
    const f = fake();
    await update(f.sys);
    expect(f.calls.some((c) => c.startsWith("sudo "))).toBe(false);
  });

  test("--release picks that release", async () => {
    const f = fake();
    await update(f.sys, { release: "v0.3.0" });
    expect(f.fetched).toEqual([`${RELEASE}/download/v0.3.0/${ASSET}`, `${RELEASE}/download/v0.3.0/SHA256SUMS`]);
  });

  test("the default is the latest release", async () => {
    const f = fake();
    await update(f.sys);
    expect(f.fetched).toEqual([`${RELEASE}/latest/download/${ASSET}`, `${RELEASE}/latest/download/SHA256SUMS`]);
  });

  test("macOS on arm64 downloads claude-rc-darwin-arm64", async () => {
    const f = fake({ platform: "darwin", arch: "arm64" });
    f.sys.fetch = (async (url: string | URL) => {
      f.fetched.push(String(url));
      return String(url).endsWith("SHA256SUMS") ? new Response(`${sha(NEW)}  claude-rc-darwin-arm64\n`) : new Response(NEW);
    }) as unknown as typeof fetch;
    await update(f.sys);
    expect(f.fetched[0]).toBe(`${RELEASE}/latest/download/claude-rc-darwin-arm64`);
  });

  test("an executable in another directory is updated in place", async () => {
    const f = fake({ execPath: "/opt/x/claude-rc" });
    await update(f.sys);
    expect(f.calls).toContain("run cp -p /opt/x/claude-rc /opt/x/claude-rc.prev");
  });

  test("a checksum mismatch installs nothing", async () => {
    const f = fake({ sums: `${"0".repeat(64)}  ${ASSET}\n` });
    const e = await fails(update(f.sys));
    expect(e!.message).toContain("Nothing was installed");
    expect(changes(f.calls)).toEqual([]);
  });

  test("the same checksum as the running executable changes nothing", async () => {
    const f = fake();
    f.sys.fetch = (async (url: string | URL) => (String(url).endsWith("/SHA256SUMS") ? new Response(`${sha(OLD)}  ${ASSET}\n`) : new Response(OLD))) as unknown as typeof fetch;
    const out = await update(f.sys);
    expect(out).toEqual([`downloading ${ASSET} (latest release)`, `claude-rc is already up to date (${VERSION})`]);
    expect(changes(f.calls)).toEqual([]);
    expect(f.calls.some((c) => c.includes("--version"))).toBe(false);
  });

  describe("failures after the replace", () => {
    for (const [what, version] of [
      ["a non-zero exit", { code: 1, stdout: "claude-rc 9.9.9\n" }],
      ["output that does not start with claude-rc", { code: 0, stdout: "something else\n" }],
      ["empty output", { code: 0, stdout: "" }],
    ] as const) {
      test(`${what} restores .prev`, async () => {
        const f = fake({ version });
        const e = await fails(update(f.sys));
        expect(e).toBeInstanceOf(ExitError);
        expect(e!.code).toBe(1);
        expect(e!.message).toContain("update failed");
        expect(e!.message).toContain("previous binary was restored");
        expect(f.calls.at(-1)).toBe(`run mv -f ${EXE}.prev ${EXE}`);
        expect(f.calls.indexOf(`run mv -f ${EXE}.prev ${EXE}`)).toBeGreaterThan(f.calls.indexOf(`run ${EXE} --version`));
      });
    }

    test("the restore uses sudo when the directory is not writable", async () => {
      const f = fake({ writable: false, version: { code: 1, stdout: "" } });
      await fails(update(f.sys));
      expect(f.calls.at(-1)).toBe(`sudo mv -f ${EXE}.prev ${EXE}`);
    });

    test("when the restore fails the message gives the manual command", async () => {
      const f = fake({ version: { code: 1, stdout: "" }, fail: (c) => c === `mv -f ${EXE}.prev ${EXE}` });
      const e = await fails(update(f.sys));
      expect(e!.message).toContain("could not be restored");
      expect(e!.message).toContain("NEW binary is still installed");
      expect(e!.message).toContain(`mv -f ${EXE}.prev ${EXE}`);
    });
  });

  describe("failures during the install", () => {
    test("cp -p failing stops before anything is installed", async () => {
      const f = fake({ fail: (c) => c.startsWith("cp -p") });
      const e = await fails(update(f.sys));
      expect(e!.message).toContain("backing up");
      expect(changes(f.calls)).toEqual([`run cp -p ${EXE} ${EXE}.prev`]);
    });
    test("install failing leaves the executable untouched", async () => {
      const f = fake({ fail: (c) => c.startsWith("install ") });
      expect(await fails(update(f.sys))).toBeInstanceOf(ExitError);
      expect(f.calls.some((c) => c.startsWith(`run mv -f ${EXE}.new`))).toBe(false);
      expect(f.calls.some((c) => c.includes("--version"))).toBe(false);
    });
    test("mv failing removes the .new file", async () => {
      const f = fake({ fail: (c) => c === `mv -f ${EXE}.new ${EXE}` });
      expect(await fails(update(f.sys))).toBeInstanceOf(ExitError);
      expect(f.calls).toContain(`run rm -f ${EXE}.new`);
      expect(f.calls.some((c) => c.includes("--version"))).toBe(false);
    });
  });

  describe("refusals before any call", () => {
    const untouched = (f: ReturnType<typeof fake>) => {
      expect(f.fetched).toEqual([]);
      expect(f.calls).toEqual([]);
    };
    for (const p of ["/usr/bin/bun", "/usr/bin/node", "/usr/local/bin/claude-rc-launcher"]) {
      test(`running as ${p} is a source run`, async () => {
        const f = fake({ execPath: p });
        const e = await fails(update(f.sys));
        expect(e!.message).toContain("claude-rc update works on the installed binary only. This looks like a source run");
        untouched(f);
      });
    }
    test("Windows", async () => {
      const f = fake({ platform: "win32", execPath: "C:\\bin\\claude-rc.exe" });
      const e = await fails(update(f.sys));
      expect(e!.message).toContain("updating on Windows is not supported yet. Download the new claude-rc-windows-x64.exe from the release page");
      untouched(f);
    });
    test("an unsupported operating system", async () => {
      const f = fake({ platform: "freebsd" });
      expect((await fails(update(f.sys)))!.message).toContain("unsupported operating system: freebsd");
      untouched(f);
    });
    test("an unsupported CPU", async () => {
      const f = fake({ arch: "riscv64" });
      expect((await fails(update(f.sys)))!.message).toContain("unsupported CPU architecture: riscv64");
      untouched(f);
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
      fetch: (async () => void touched.push("hub fetch")) as unknown as typeof fetch,
      open: async () => void touched.push("open"),
      readLine: async () => (touched.push("readLine"), ""),
      sys,
    };
    const out: string[] = [];
    const err: string[] = [];
    const run = async (...argv: string[]) => ({ code: await main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) }, env), out, err });
    return { run, touched };
  }

  test("runs without a login and touches neither the credentials nor the hub", async () => {
    const f = fake();
    const c = cli(f.sys);
    const r = await c.run("update");
    expect(r.code).toBe(0);
    expect(r.out.at(-1)).toContain(`updated ${EXE} from`);
    expect(c.touched).toEqual([]);
  });

  test("passes --release through", async () => {
    const f = fake();
    expect((await cli(f.sys).run("update", "--release", "v0.3.0")).code).toBe(0);
    expect(f.fetched[0]).toContain("download/v0.3.0/");
  });

  test("rejects extra positional arguments", async () => {
    const f = fake();
    const r = await cli(f.sys).run("update", "extra");
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("unexpected argument: extra");
    expect(r.err.join("\n")).toContain(USAGE);
    expect(f.calls).toEqual([]);
  });

  for (const [flag, value] of [["--hub", "https://rc.example.com"], ["--binary", "/tmp/x"], ["--force", ""], ["--listen", "10.0.0.9"], ["--name", "x"], ["--host", "pi"]] as const) {
    test(`rejects ${flag}, which does not apply to update`, async () => {
      const f = fake();
      const r = await cli(f.sys).run("update", flag, ...(value ? [value] : []));
      expect(r.code).toBe(1);
      expect(r.err.join("\n")).toContain(`${flag} does not apply to update`);
      expect(r.err.join("\n")).toContain(USAGE);
      expect(f.calls).toEqual([]);
    });
  }

  test("a failure exits with its code", async () => {
    const r = await cli(fake({ execPath: "/usr/bin/bun" }).sys).run("update");
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("source run");
  });

  test("help text lists update", () => {
    return import("../src/index").then((m) => expect(m.USAGE).toContain("update [--release tag]"));
  });
});

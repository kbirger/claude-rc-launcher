import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bunRun, checkSshClient, checkSshClientHere, clientDirs, parseVersion, pipeSelfTest } from "../src/win/sshclient";
import type { RunResult, SshClientDeps } from "../src/win/sshclient";

const onWindows = process.platform === "win32";
const windowsTest = test.skipIf(!onWindows);

const ENV = { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files" };
const SYSTEM = join("C:\\Windows", "System32", "OpenSSH");
const PROGRAM = join("C:\\Program Files", "OpenSSH");
const VERSION_OUTPUT = "OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2\r\n";

function deps(options: {
  present?: string[];
  version?: Record<string, RunResult>;
  selfTest?: (path: string) => boolean;
}): SshClientDeps & { ran: string[] } {
  const ran: string[] = [];
  const present = new Set(options.present ?? []);

  return {
    env: ENV,
    ran,
    exists: (path) => present.has(path),
    run: (exe) => {
      ran.push(exe);
      return Promise.resolve(options.version?.[exe] ?? { code: 0, output: VERSION_OUTPUT });
    },
    selfTest: (path) => Promise.resolve(options.selfTest ? options.selfTest(path) : true),
  };
}

const both = (dir: string) => [join(dir, "ssh.exe"), join(dir, "ssh-add.exe")];

describe("the folders of the client", () => {
  test("System32 comes first, then Program Files", () => {
    expect(clientDirs(ENV)).toEqual([SYSTEM, PROGRAM]);
  });

  test("no folder comes from the PATH", () => {
    expect(clientDirs({ ...ENV, PATH: "C:\\Program Files\\Git\\usr\\bin" })).toEqual([SYSTEM, PROGRAM]);
  });

  test("windir is the fallback for SystemRoot", () => {
    expect(clientDirs({ windir: "D:\\Win" })).toEqual([join("D:\\Win", "System32", "OpenSSH")]);
  });

  test("an empty environment gives no folder", () => {
    expect(clientDirs({})).toEqual([]);
  });
});

describe("the version", () => {
  test.each([
    ["OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2", "OpenSSH_for_Windows_9.5p2", 9, 5],
    ["OpenSSH_9.0p1, OpenSSL 3", "OpenSSH_9.0p1", 9, 0],
    ["OpenSSH_for_Windows_10.4p1", "OpenSSH_for_Windows_10.4p1", 10, 4],
    ["OpenSSH_8.1", "OpenSSH_8.1", 8, 1],
  ])("%p", (text, name, major, minor) => {
    expect(parseVersion(text)).toEqual({ text: name, major, minor });
  });

  test("text with no version gives nothing", () => {
    expect(parseVersion("ssh: command not found")).toBeUndefined();
  });
});

describe("checkSshClient", () => {
  test("no client anywhere gives the install reason", async () => {
    const result = await checkSshClient(deps({}));
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("not installed") });
  });

  test("a client in System32 passes", async () => {
    const result = await checkSshClient(deps({ present: both(SYSTEM) }));
    expect(result).toEqual({
      ok: true,
      sshPath: join(SYSTEM, "ssh.exe"),
      sshAddPath: join(SYSTEM, "ssh-add.exe"),
      version: "OpenSSH_for_Windows_9.5p2",
    });
  });

  test("a client only in Program Files passes", async () => {
    const result = await checkSshClient(deps({ present: both(PROGRAM) }));
    expect(result.ok && result.sshPath).toBe(join(PROGRAM, "ssh.exe"));
  });

  test("a folder with only ssh.exe is skipped", async () => {
    const result = await checkSshClient(deps({ present: [join(SYSTEM, "ssh.exe"), ...both(PROGRAM)] }));
    expect(result.ok && result.sshPath).toBe(join(PROGRAM, "ssh.exe"));
  });

  test("a version below the minimum is refused with its number", async () => {
    const result = await checkSshClient(
      deps({
        present: both(SYSTEM),
        version: { [join(SYSTEM, "ssh.exe")]: { code: 0, output: "OpenSSH_for_Windows_8.6p1" } },
      }),
    );
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("version 8.6. The node needs version 9.0") });
  });

  test("version 9.0 is accepted", async () => {
    const result = await checkSshClient(
      deps({
        present: both(SYSTEM),
        version: { [join(SYSTEM, "ssh.exe")]: { code: 0, output: "OpenSSH_for_Windows_9.0p1" } },
      }),
    );
    expect(result.ok).toBe(true);
  });

  test("output with no version is refused", async () => {
    const result = await checkSshClient(
      deps({ present: both(SYSTEM), version: { [join(SYSTEM, "ssh.exe")]: { code: 0, output: "hello" } } }),
    );
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("did not give an OpenSSH version") });
  });

  test("a failed self test is refused", async () => {
    const result = await checkSshClient(deps({ present: both(SYSTEM), selfTest: () => false }));
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("could not read a key") });
  });

  test("a bad client in System32 does not stop a good one in Program Files", async () => {
    const result = await checkSshClient(
      deps({ present: [...both(SYSTEM), ...both(PROGRAM)], selfTest: (path) => path.startsWith(PROGRAM) }),
    );
    expect(result.ok && result.sshAddPath).toBe(join(PROGRAM, "ssh-add.exe"));
  });

  test("no program outside the two folders is run", async () => {
    const fake = deps({ present: both(SYSTEM) });
    await checkSshClient(fake);
    expect(fake.ran.every((exe) => exe.startsWith(SYSTEM))).toBe(true);
  });
});

describe("with the real client", () => {
  windowsTest("the machine client passes the check", async () => {
    const result = await checkSshClientHere();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sshPath.toLowerCase()).toContain("openssh");
      expect(result.version).toMatch(/^OpenSSH/);
    }
  });

  windowsTest("an environment with no client folder gives the install reason", async () => {
    const result = await checkSshClientHere({ SystemRoot: "C:\\no-such-folder-claude-rc" });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("not installed") });
  });

  windowsTest("the self test passes for the Windows ssh-add", async () => {
    const sshAdd = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH", "ssh-add.exe");
    expect(await pipeSelfTest(sshAdd, bunRun)).toBe(true);
  });

  const gitSshAdd = "C:\\Program Files\\Git\\usr\\bin\\ssh-add.exe";
  test.skipIf(!onWindows || !existsSync(gitSshAdd))("the self test fails for the ssh-add of Git for Windows", async () => {
    expect(await pipeSelfTest(gitSshAdd, bunRun)).toBe(false);
  });

  windowsTest("a program that does not exist gives code 127", async () => {
    expect((await bunRun("C:\\no-such-folder-claude-rc\\x.exe", [])).code).toBe(127);
  });
});

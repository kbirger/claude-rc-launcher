import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinuxSshdMachine } from "../../../src/ssh/node/LinuxSshdMachine";
import type { CommandResult } from "../../../src/ssh/node/SshdDropin";

const SSHD = "/usr/sbin/sshd";
const OK: CommandResult = { code: 0, stdout: "", stderr: "" };

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sshdmachine-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A runner that records each command and answers from the list, in order. */
function recorder(answers: CommandResult[] = []): {
  calls: string[][];
  run: (cmd: string[]) => Promise<CommandResult>;
} {
  const calls: string[][] = [];

  return {
    calls,
    run: (cmd) => {
      calls.push(cmd);
      return Promise.resolve(answers[calls.length - 1] ?? OK);
    },
  };
}

function machine(run: (cmd: string[]) => Promise<CommandResult>, sshd: string | null = SSHD): LinuxSshdMachine {
  return new LinuxSshdMachine({ run, findSshd: () => sshd ?? undefined, isRoot: () => false });
}

async function leftovers(folder: string): Promise<string[]> {
  return (await readdir(folder)).filter((name) => name.includes(".tmp-"));
}

describe("LinuxSshdMachine", () => {
  test("sshdEffective runs sshd -T with the account match", async () => {
    const { calls, run } = recorder([{ code: 0, stdout: "port 22\n", stderr: "" }]);
    const result = await machine(run).sshdEffective("alice");

    expect(result?.stdout).toBe("port 22\n");
    expect(calls).toEqual([[SSHD, "-T", "-C", "user=alice,host=localhost,addr=127.0.0.1"]]);
  });

  test("sshdEffective without an account runs sshd -T, and sshdTest runs sshd -t", async () => {
    const { calls, run } = recorder();
    const box = machine(run);
    await box.sshdEffective();
    await box.sshdTest();
    expect(calls).toEqual([
      [SSHD, "-T"],
      [SSHD, "-t"],
    ]);
  });

  test("sshdEffective is undefined when no sshd binary is found", async () => {
    const { calls, run } = recorder();
    const box = machine(run, null);
    expect(await box.sshdEffective("alice")).toBeUndefined();
    expect((await box.sshdTest()).code).toBe(127);
    expect(calls).toEqual([]);
  });

  test("writeFile makes the folder, writes mode 644 and leaves no temporary file", async () => {
    const folder = join(dir, "sshd_config.d");
    const path = join(folder, "49-claude-rc.conf");
    await machine(recorder().run).writeFile(path, "AuthorizedKeysFile .ssh/a\n");

    expect(await readFile(path, "utf8")).toBe("AuthorizedKeysFile .ssh/a\n");
    expect((await stat(path)).mode & 0o777).toBe(0o644);
    expect((await stat(folder)).mode & 0o777).toBe(0o755);
    expect(await leftovers(folder)).toEqual([]);
  });

  test("writeFile replaces an old file and does not change the mode of an existing folder", async () => {
    const folder = join(dir, "sshd_config.d");
    await mkdir(folder, { mode: 0o750 });
    const path = join(folder, "49-claude-rc.conf");
    await writeFile(path, "old\n", { mode: 0o600 });
    await machine(recorder().run).writeFile(path, "new\n");

    expect(await readFile(path, "utf8")).toBe("new\n");
    expect((await stat(path)).mode & 0o777).toBe(0o644);
    expect((await stat(folder)).mode & 0o777).toBe(0o750);
  });

  test("writeFile as root gives the file to root", async () => {
    if (process.getuid?.() !== 0) return;
    const path = join(dir, "49-claude-rc.conf");
    await new LinuxSshdMachine({ run: recorder().run, findSshd: () => SSHD, isRoot: () => true }).writeFile(
      path,
      "x\n",
    );
    const info = await stat(path);
    expect([info.uid, info.gid]).toEqual([0, 0]);
  });

  test("writeFile refuses a link at the path and leaves the target and the folder alone", async () => {
    const target = join(dir, "target");
    await writeFile(target, "target\n");
    const path = join(dir, "49-claude-rc.conf");
    await symlink(target, path);

    await expect(machine(recorder().run).writeFile(path, "new\n")).rejects.toThrow(/link/);
    expect(await readFile(target, "utf8")).toBe("target\n");
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await leftovers(dir)).toEqual([]);
  });

  test("writeFile and removeFile refuse a folder that is a link", async () => {
    const real = join(dir, "real");
    await mkdir(real);
    await writeFile(join(real, "49-claude-rc.conf"), "keep\n");
    const folder = join(dir, "sshd_config.d");
    await symlink(real, folder);
    const box = machine(recorder().run);

    await expect(box.writeFile(join(folder, "49-claude-rc.conf"), "new\n")).rejects.toThrow(/link/);
    await expect(box.removeFile(join(folder, "49-claude-rc.conf"))).rejects.toThrow(/link/);
    expect(await readFile(join(real, "49-claude-rc.conf"), "utf8")).toBe("keep\n");
    expect(await leftovers(real)).toEqual([]);
  });

  test("writeFile leaves no temporary file when the rename fails", async () => {
    const path = join(dir, "49-claude-rc.conf");
    await mkdir(path);
    await writeFile(join(path, "inside"), "x");

    await expect(machine(recorder().run).writeFile(path, "new\n")).rejects.toThrow();
    expect(await leftovers(dir)).toEqual([]);
  });

  test("writeFile replaces a stale temporary file of an earlier run", async () => {
    const path = join(dir, "49-claude-rc.conf");
    await writeFile(`${path}.tmp-${process.pid}`, "stale");
    await machine(recorder().run).writeFile(path, "new\n");
    expect(await readFile(path, "utf8")).toBe("new\n");
    expect(await leftovers(dir)).toEqual([]);
  });

  test("readFile is undefined for a missing file", async () => {
    const box = machine(recorder().run);
    expect(await box.readFile(join(dir, "missing"))).toBeUndefined();
    await writeFile(join(dir, "there"), "text\n");
    expect(await box.readFile(join(dir, "there"))).toBe("text\n");
  });

  test("removeFile removes the file, and a missing file is not an error", async () => {
    const path = join(dir, "49-claude-rc.conf");
    await writeFile(path, "x");
    const box = machine(recorder().run);
    await box.removeFile(path);
    await box.removeFile(path);
    expect(await readdir(dir)).toEqual([]);
  });

  test("reloadSshd tries ssh, then sshd", async () => {
    const { calls, run } = recorder([
      { code: 5, stdout: "", stderr: "Unit ssh.service not found." },
      { code: 0, stdout: "", stderr: "" },
    ]);
    const result = await machine(run).reloadSshd();

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      ["systemctl", "reload", "ssh"],
      ["systemctl", "reload", "sshd"],
    ]);
  });

  test("reloadSshd stops after ssh works, and names the stderr of both when both fail", async () => {
    const first = recorder();
    expect((await machine(first.run).reloadSshd()).ok).toBe(true);
    expect(first.calls).toEqual([["systemctl", "reload", "ssh"]]);

    const both = recorder([
      { code: 5, stdout: "", stderr: "Unit ssh.service not found." },
      { code: 5, stdout: "", stderr: "Unit sshd.service not found." },
    ]);
    const result = await machine(both.run).reloadSshd();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Unit ssh.service not found.");
    expect(result.detail).toContain("Unit sshd.service not found.");
  });

  test("the default runner refuses to run under test", async () => {
    const box = new LinuxSshdMachine({ findSshd: () => SSHD, isRoot: () => false });
    await expect(box.sshdTest()).rejects.toThrow(/run/);
    await expect(box.reloadSshd()).rejects.toThrow(/run/);
  });
});

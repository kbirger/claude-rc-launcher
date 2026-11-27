import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRunner, runProvisioner } from "../../../src/ssh/hub/maintenance";
import type { SshRunner } from "../../../src/ssh/hub/maintenance";
import { NodeError } from "../../../src/ssh/hub/SshService";

// The runner spawns a fake `ssh`: a shell script in a temporary folder that records its arguments, its environment and
// its stdin, and prints a scripted answer. No real ssh runs.

const root = mkdtempSync(path.join(os.tmpdir(), "rc-ssh-maint-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

let count = 0;

/** A folder with a fake `ssh` that runs `body` after it recorded its call. */
function fakeSsh(body: string): { bin: string; record: string } {
  const folder = path.join(root, `case${++count}`);
  const record = path.join(folder, "record");
  const bin = path.join(folder, "bin");
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(record, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const script = [
    "#!/bin/sh",
    `n=0; for a in "$@"; do n=$((n + 1)); printf '%s' "$a" > '${record}/arg'$n; done`,
    `echo $n > '${record}/argc'`,
    `env > '${record}/env'`,
    `cat > '${record}/stdin'`,
    body,
    "",
  ].join("\n");
  writeFileSync(path.join(bin, "ssh"), script);
  chmodSync(path.join(bin, "ssh"), 0o755);
  return { bin, record };
}

const args = (record: string): string[] => {
  const total = Number(readFileSync(path.join(record, "argc"), "utf8").trim());
  return Array.from({ length: total }, (_unused, index) => readFileSync(path.join(record, `arg${index + 1}`), "utf8"));
};

describe("the ssh runner", () => {
  test("passes the command as one argument, with a clean environment and no stdin", async () => {
    const { bin, record } = fakeSsh("echo 'ok sources 10.0.0.1,10.0.0.2'");
    const before = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = "/tmp/not-the-agent.sock";

    try {
      const result = await createRunner({ path: bin })(
        "/run/x/maintenance/g.config",
        "nas",
        "sources 10.0.0.1,10.0.0.2",
        5000,
      );
      expect(result).toEqual({ code: 0, stdout: "ok sources 10.0.0.1,10.0.0.2\n", stderr: "" });
    } finally {
      if (before === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = before;
    }

    const argv = args(record);
    expect(argv.slice(0, 2)).toEqual(["-F", "/run/x/maintenance/g.config"]);
    expect(argv).toContain("-T");
    expect(argv).toContain("BatchMode=yes");
    expect(argv).toContain("ConnectTimeout=10");
    expect(argv).toContain("StrictHostKeyChecking=yes");
    expect(argv).toContain("IdentitiesOnly=yes");
    expect(argv).toContain("ClearAllForwardings=yes");
    // The last two: the host alias of the config file, and the command as one argument.
    expect(argv.slice(-3)).toEqual(["--", "nas", "sources 10.0.0.1,10.0.0.2"]);
    const env = readFileSync(path.join(record, "env"), "utf8");
    expect(env).not.toContain("SSH_AUTH_SOCK");
    expect(env).not.toContain("not-the-agent");
    expect(readFileSync(path.join(record, "stdin"), "utf8")).toBe("");
  });

  test("kills the child after the timeout", async () => {
    const { bin } = fakeSsh("exec sleep 30");
    const started = Date.now();
    const result = await createRunner({ path: bin })("/c", "nas", "status", 300);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.code).toBe(124);
  });

  test("a child that leaves a process with the pipes open still returns after the timeout", async () => {
    // `sleep` keeps stdout open after the shell is killed. The runner must not wait for it.
    const { bin } = fakeSsh("sleep 3; echo late");
    const started = Date.now();
    const result = await createRunner({ path: bin })("/c", "nas", "status", 300);
    expect(Date.now() - started).toBeLessThan(2500);
    expect(result.code).toBe(124);
    expect(result.stdout).not.toContain("late");
  });

  test("caps stdout and stderr at 4096 bytes", async () => {
    const { bin } = fakeSsh(
      "i=0; while [ $i -lt 2000 ]; do printf 'abcdefghij'; printf 'ABCDEFGHIJ' >&2; i=$((i + 1)); done",
    );
    const result = await createRunner({ path: bin })("/c", "nas", "status", 5000);
    expect(result.code).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBe(4096);
    expect(Buffer.byteLength(result.stderr)).toBe(4096);
    expect(result.stdout.startsWith("abcdefghij")).toBe(true);
  });

  test("gives code 127 when ssh is missing", async () => {
    const empty = path.join(root, "empty");
    mkdirSync(empty, { recursive: true });
    const result = await createRunner({ path: empty })("/c", "nas", "status", 1000);
    expect(result.code).toBe(127);
  });
});

const runnerOf =
  (reply: { code: number; stdout?: string; stderr?: string }): SshRunner =>
  () =>
    Promise.resolve({ code: reply.code, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" });

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(NodeError);
    return (error as Error).message;
  }

  throw new Error("no failure");
}

describe("runProvisioner", () => {
  test("gives the parsed answer and calls the runner with 15 seconds", async () => {
    const seen: unknown[] = [];

    const runner: SshRunner = (...call) => {
      seen.push(call);
      return Promise.resolve({ code: 0, stdout: "ok status present 10.0.0.1\n", stderr: "" });
    };

    expect(await runProvisioner(runner, "/c", "nas", "status")).toEqual({
      kind: "status",
      present: true,
      list: ["10.0.0.1"],
    });
    expect(seen).toEqual([["/c", "nas", "status", 15_000]]);
  });

  test("a code 0 answer that does not parse is a failure", async () => {
    expect(await failure(runProvisioner(runnerOf({ code: 0, stdout: "hello\n" }), "/c", "nas", "on"))).toBe(
      "the script gave no valid answer",
    );
  });

  test("an error line of the script becomes one short line", async () => {
    const text = await failure(
      runProvisioner(
        runnerOf({ code: 4, stderr: "error guard the new key file failed the check, nothing was written\nmore\n" }),
        "/c",
        "nas",
        "on",
      ),
    );
    expect(text).toBe("the script failed (exit 4): guard: the new key file failed the check, nothing was written");
  });

  test("an ssh failure names the code and the first line of stderr only", async () => {
    const text = await failure(
      runProvisioner(
        runnerOf({ code: 255, stderr: "user@10.0.0.5: Permission denied (publickey).\r\nsecond\n" }),
        "/c",
        "nas",
        "on",
      ),
    );
    expect(text).toBe("ssh exited with code 255: user@10.0.0.5: Permission denied (publickey).");
  });

  test("code 127 and a timeout have plain texts", async () => {
    expect(await failure(runProvisioner(runnerOf({ code: 127, stderr: "ssh: not found" }), "/c", "nas", "on"))).toBe(
      "the hub has no ssh program: install the OpenSSH client on the hub machine",
    );
    expect(await failure(runProvisioner(runnerOf({ code: 124, stderr: "ssh: timed out" }), "/c", "nas", "on"))).toBe(
      "the run on the target took longer than 15 seconds",
    );
  });

  test("a remote exit code 127 is not taken for a missing ssh", async () => {
    const text = await failure(
      runProvisioner(runnerOf({ code: 127, stderr: "sh: 1: /home/u/.claude-rc/x.sh: not found\n" }), "/c", "nas", "on"),
    );
    expect(text).toBe("ssh exited with code 127: sh: 1: /home/u/.claude-rc/x.sh: not found");
  });

  test("refuses a command that is not of the grammar before it runs", async () => {
    let ran = false;

    const runner: SshRunner = () => {
      ran = true;
      return Promise.resolve({ code: 0, stdout: "ok on 1\n", stderr: "" });
    };

    expect(await failure(runProvisioner(runner, "/c", "nas", "on; id"))).toBe("the command is not valid");
    expect(ran).toBe(false);
  });
});

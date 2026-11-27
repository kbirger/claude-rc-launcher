import { asUser } from "../../shared/asuser";
import type { IdentityFor } from "../../shared/asuser";
import { HttpError } from "../../shared/HttpError";
import type { SshdReads } from "./ManagedKeyInstaller";
import type { SshdDropin } from "./SshdDropin";
import type { SshManagedOptions } from "./types";

// The commands that the SSH routes of a node run by default: ssh-keyscan, an ssh probe, the provision script and the
// sshd check before a managed install.
// A test injects its own functions in their place.

/** Runs a command with a time limit. A command that cannot start gives code 127. */
export async function runCommand(
  cmd: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let child: ReturnType<typeof Bun.spawn>;

  try {
    child = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }

  const timer = setTimeout(() => {
    child.kill();
  }, timeoutMs);

  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout as ReadableStream).text(),
      new Response(child.stderr as ReadableStream).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** The host keys that `ssh-keyscan` finds, as `<type> <base64>` lines. It gives up after 5 seconds. */
export async function keyscanDefault(address: string, port: number): Promise<string[]> {
  const result = await runCommand(["ssh-keyscan", "-T", "5", "-t", "ed25519", "-p", String(port), address], 5000);
  const lines: string[] = [];

  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("#")) continue;
    const [, type, key] = line.trim().split(/\s+/);
    if (type && key) lines.push(`${type} ${key}`);
  }

  return lines;
}

export async function probeDefault(config: string, targetId: string): Promise<{ code: number; stderr: string }> {
  const { code, stderr } = await runCommand(
    ["ssh", "-F", config, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", targetId, "true"],
    30_000,
  );
  return { code, stderr };
}

const SCRIPT_TIMEOUT_MS = 60_000;

/** Runs a command with the script on stdin. A command that cannot start gives code 127. */
async function runWithStdin(
  cmd: string,
  args: string[],
  script: string,
  env?: Record<string, string>,
  timeoutMs: number = SCRIPT_TIMEOUT_MS,
): Promise<{ code: number; stderr: string; stdout: string }> {
  let child: ReturnType<typeof Bun.spawn>;

  try {
    child = Bun.spawn([cmd, ...args], {
      stdin: new Blob([script]),
      stdout: "pipe",
      stderr: "pipe",
      ...(env ? { env } : {}),
    });
  } catch (error) {
    return { code: 127, stderr: error instanceof Error ? error.message : String(error), stdout: "" };
  }

  const timer = setTimeout(() => {
    child.kill();
  }, timeoutMs);

  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout as ReadableStream).text(),
      new Response(child.stderr as ReadableStream).text(),
      child.exited,
    ]);
    return { code, stderr, stdout };
  } finally {
    clearTimeout(timer);
  }
}

/** A test must never run a real provision script: it would write an `authorized_keys` file of the machine. */
function refuseUnderTest(): void {
  if (process.env.NODE_ENV === "test")
    throw new HttpError(500, "the provision script does not run under test: inject runAs in sshManaged");
}

export function defaultRunAs(identityFor?: IdentityFor): NonNullable<SshManagedOptions["runAs"]> {
  return async (account, { shell, script }, timeoutMs) => {
    if (shell === "powershell") {
      refuseUnderTest();
      return runWithStdin(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", "-"],
        script,
        undefined,
        timeoutMs,
      );
    }

    // Fail closed: without a user switch the script would write to the home of the node's own user.
    if (!identityFor) throw new HttpError(501, "the node has no user switch");
    // identityFor rejects an unknown account with a 400.
    const wrapped = asUser(await identityFor(account), "sh", ["-s"]);
    refuseUnderTest();
    return runWithStdin(wrapped.cmd, wrapped.args, script, wrapped.env, timeoutMs);
  };
}

/**
 * The sshd check of a managed install. A node that is not root cannot run `sshd -T`, so it answers `skipped`. As root,
 * it asks sshd for the list of the account, with the home of the account for the full path form. The caller gives the
 * drop-in: `commands.ts` cannot build the real machine, which imports it. Without one, under test it refuses, and else
 * it fails closed.
 */
export function defaultSshdReads(
  identityFor: IdentityFor | undefined,
  isRoot: () => boolean,
  dropin?: SshdDropin,
): SshdReads {
  return async (account, keyFile) => {
    if (!dropin) {
      if (process.env.NODE_ENV === "test")
        throw new HttpError(500, "the sshd check does not run under test: inject sshdReads in sshManaged");
      throw new HttpError(500, "the node has no sshd check");
    }

    if (!isRoot()) return "skipped";
    if (!identityFor) throw new HttpError(501, "the node has no user switch");
    // identityFor rejects an unknown account with a 400.
    const { home } = await identityFor(account);
    if (await dropin.readsFor(account, home, keyFile)) return "passed";
    return (await dropin.readsGlobally(home, keyFile)) ? "match-block" : "missing";
  };
}

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { publicKeyBlob, publicKeyLine, GrantAgent } from "../ssh";
import { newPipeName, pipeTransport } from "./pipe";

// Finds a Windows OpenSSH client that can talk to a named pipe, and proves it. The Git for Windows `ssh` and `ssh-add`
// often come first on the PATH and cannot use a pipe, so the PATH is never searched. Only the two folders of the
// Windows OpenSSH client count. The self test starts a throwaway agent on a pipe and expects `ssh-add -L` to list its key.

/** The oldest OpenSSH version that the node accepts. Only 9.5p2 is tested. */
export const MIN_VERSION = { major: 9, minor: 0 } as const;

export interface SshClient {
  ok: true;
  sshPath: string;
  sshAddPath: string;
  /** The text from `ssh -V`, such as `OpenSSH_for_Windows_9.5p2`. */
  version: string;
}

export interface SshClientOff {
  ok: false;
  /** Plain English for the owner: why SSH access is off. */
  reason: string;
}

export type SshClientCheck = SshClient | SshClientOff;

export interface RunResult {
  code: number;
  output: string;
}

export interface SshClientDeps {
  env: Record<string, string | undefined>;
  exists: (path: string) => boolean;
  /** Runs a program and returns its exit code and all of its output (standard output and standard error). */
  run: (exe: string, args: string[], env?: Record<string, string>) => Promise<RunResult>;
  /** Proves that `ssh-add` can read a key from a pipe agent. Default: `pipeSelfTest`. */
  selfTest?: (sshAddPath: string, run: SshClientDeps["run"]) => Promise<boolean>;
}

/** The folders of the Windows OpenSSH client, best first. */
export function clientDirs(env: SshClientDeps["env"]): string[] {
  const dirs: string[] = [];
  const system = env.SystemRoot ?? env.windir;
  if (system) dirs.push(join(system, "System32", "OpenSSH"));
  const programFiles = env.ProgramFiles;
  if (programFiles) dirs.push(join(programFiles, "OpenSSH"));
  return dirs;
}

/** Reads the version from the output of `ssh -V`. Returns undefined when the text has no version. */
export function parseVersion(output: string): { text: string; major: number; minor: number } | undefined {
  const match = /(OpenSSH[A-Za-z_]*?_(\d+)\.(\d+)(?:p\d+)?)/.exec(output);
  if (!match) return undefined;
  return { text: match[1], major: Number(match[2]), minor: Number(match[3]) };
}

const atLeastMin = (version: { major: number; minor: number }) =>
  version.major > MIN_VERSION.major || (version.major === MIN_VERSION.major && version.minor >= MIN_VERSION.minor);

const NOT_FOUND =
  "The Windows OpenSSH client is not installed. Install the Windows feature OpenSSH Client, then restart the node.";

/** The environment of this process with the given names set. Windows names ignore case, so a name that differs only in case is replaced. */
export function mergedEnv(extra: Record<string, string>): Record<string, string> {
  const wanted = new Set(Object.keys(extra).map((name) => name.toLowerCase()));
  const out: Record<string, string> = {};

  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !wanted.has(name.toLowerCase())) out[name] = value;
  }

  return { ...out, ...extra };
}

/** Runs a program with Bun and stops it after a time limit. A program that cannot start gives code 127. */
export async function bunRun(
  exe: string,
  args: string[],
  env?: Record<string, string>,
  timeoutMs = 10_000,
): Promise<RunResult> {
  try {
    const proc = Bun.spawn([exe, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      ...(env ? { env: mergedEnv(env) } : {}),
      timeout: timeoutMs,
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, output: out + err };
  } catch (error) {
    return { code: 127, output: error instanceof Error ? error.message : String(error) };
  }
}

/** Starts a throwaway agent on a random pipe and asks `ssh-add -L` for its key. True when the key comes back. */
export async function pipeSelfTest(sshAddPath: string, run: SshClientDeps["run"]): Promise<boolean> {
  const raw = new Uint8Array(randomBytes(32));
  const comment = "claude-rc:self-test";
  const name = newPipeName("selftest");
  const agent = new GrantAgent({
    dir: "unused",
    topDir: "unused",
    grantId: "self-test",
    publicBlob: publicKeyBlob(raw),
    comment,
    forwardSign: () => Promise.reject(new Error("the self test does not sign")),
    transport: pipeTransport({ name }),
  });

  try {
    await agent.start();
    const result = await run(sshAddPath, ["-L"], { SSH_AUTH_SOCK: name });
    return result.code === 0 && result.output.trim() === publicKeyLine(raw, comment);
  } catch {
    return false;
  } finally {
    await agent.stop();
  }
}

/** Looks for a working client. The first folder that has both programs and passes every step wins. */
export async function checkSshClient(deps: SshClientDeps): Promise<SshClientCheck> {
  const selfTest = deps.selfTest ?? pipeSelfTest;
  let reason = NOT_FOUND;

  for (const dir of clientDirs(deps.env)) {
    const sshPath = join(dir, "ssh.exe");
    const sshAddPath = join(dir, "ssh-add.exe");
    if (!deps.exists(sshPath) || !deps.exists(sshAddPath)) continue;
    const result = await deps.run(sshPath, ["-V"]);
    const version = parseVersion(result.output);

    if (result.code !== 0 || !version) {
      reason = `The program ${sshPath} did not give an OpenSSH version.`;
      continue;
    }

    if (!atLeastMin(version)) {
      reason = `The Windows OpenSSH client at ${sshPath} is version ${version.major}.${version.minor}. The node needs version ${MIN_VERSION.major}.${MIN_VERSION.minor} or later.`;
      continue;
    }

    if (!(await selfTest(sshAddPath, deps.run))) {
      reason = `The Windows OpenSSH client at ${sshPath} could not read a key from the node agent.`;
      continue;
    }

    return { ok: true, sshPath, sshAddPath, version: version.text };
  }

  return { ok: false, reason };
}

/** The check with the real machine. */
export function checkSshClientHere(env: SshClientDeps["env"] = process.env): Promise<SshClientCheck> {
  return checkSshClient({ env, exists: existsSync, run: bunRun });
}

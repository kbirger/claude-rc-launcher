import { isAbsolute } from "node:path";
import { HOST_ID_RE } from "./hosts/id";
import { parseAnswer, parseCommand } from "./sshprovisioner";
import type { ProvisionerAnswer } from "./sshprovisioner";
import { NodeError } from "./sshservice";

// The `ssh` child process of the hub for a maintenance grant. The hub runs one command of the provisioner script on the
// target, through the agent socket and the config file that the node `local` wrote for the grant. No shell runs on the
// hub: the command is one argument. The child gets a clean environment, so no agent, no `SSH_AUTH_SOCK` and no other
// setting of the hub process reaches it. With `-F`, ssh reads no other config file (`~/.ssh/config` and
// `/etc/ssh/ssh_config` are skipped). The grant config pins the host key and names only the key of the grant.
// The child is killed (by its own handle, never by a name) after the timeout. At most 4096 bytes of each stream are kept.

export type SshRunner = (
  config: string,
  targetId: string,
  command: string,
  timeoutMs: number,
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** The time of one run. Three runs fit in the one minute of a maintenance grant. */
export const RUN_TIMEOUT_MS = 15_000;
/** The bytes kept of stdout and of stderr. The rest is read and dropped, so that the child never blocks. */
export const MAX_OUTPUT = 4096;
/** The code of a run that the runner killed after the timeout, as `timeout(1)` gives. */
export const TIMEOUT_CODE = 124;
/** The time that the runner waits for the pipes after the child exited. A process that the child left can hold them. */
const PIPE_GRACE_MS = 500;
const MAX_DETAIL = 200;
const NO_SSH = "the hub has no ssh program: install the OpenSSH client on the hub machine";
/** The stderr of a run that the runner could not start, or that it killed. A remote exit code 127 or 124 has other text. */
export const NOT_STARTED = "ssh: not found";
export const TIMED_OUT = "ssh: timed out";

/** The arguments after the program. Every option that the grant config sets is set here again: the command line wins. */
export function sshArgs(config: string, targetId: string, command: string): string[] {
  return [
    "-F",
    config,
    "-T",
    "-a",
    "-x",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "--",
    targetId,
    command,
  ];
}

/** Reads a stream to its end and keeps the first `MAX_OUTPUT` bytes. */
function capped(stream: ReadableStream<Uint8Array>): { done: Promise<void>; cancel(): void; text(): string } {
  const reader = stream.getReader();
  const kept: Uint8Array[] = [];
  let size = 0;

  const done = (async () => {
    try {
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) return;
        if (size >= MAX_OUTPUT) continue;
        const part = value.subarray(0, MAX_OUTPUT - size);
        kept.push(part);
        size += part.length;
      }
    } catch {
      // a cancelled or broken pipe: keep what was read
    }
  })();

  return {
    done,
    cancel: () => {
      reader.cancel().catch(() => {});
    },
    text: () => Buffer.concat(kept).toString("utf8"),
  };
}

/** A runner that spawns `ssh`. `path` is the search path for the program (tests give a folder with a fake one). */
export function createRunner(options: { path?: string } = {}): SshRunner {
  return async (config, targetId, command, timeoutMs) => {
    const program = Bun.which("ssh", options.path !== undefined ? { PATH: options.path } : {});
    if (!program) return { code: 127, stdout: "", stderr: NOT_STARTED };
    let child: Bun.Subprocess<"ignore", "pipe", "pipe">;

    try {
      child = Bun.spawn([program, ...sshArgs(config, targetId, command)], {
        env: { LC_ALL: "C" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch {
      return { code: 127, stdout: "", stderr: NOT_STARTED };
    }

    const out = capped(child.stdout);
    const err = capped(child.stderr);
    const run = { timedOut: false };
    // The kill reaches the ssh process only, by its own handle. That is enough: with this configuration ssh starts no
    // child (no ProxyCommand, no LocalCommand, no ControlMaster). A child that a hub crash leaves behind can never sign
    // again: the agent socket lives in the hub process and goes with it, and the grant store holds the key in memory only.
    const timer = setTimeout(() => {
      run.timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    try {
      const code = await child.exited;
      await Promise.race([Promise.all([out.done, err.done]), Bun.sleep(PIPE_GRACE_MS)]);
      if (run.timedOut) return { code: TIMEOUT_CODE, stdout: out.text(), stderr: TIMED_OUT };
      return { code, stdout: out.text(), stderr: err.text() };
    } finally {
      clearTimeout(timer);
      out.cancel();
      err.cancel();
    }
  };
}

export const defaultRunner: SshRunner = createRunner();

/** One line of at most 200 characters, with no control characters. */
function oneLine(text: string): string {
  return text
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim()
    .slice(0, MAX_DETAIL);
}

/** The text of a run that failed: the error line of the script, or the first line that ssh wrote. */
function failureText(code: number, stderr: string): string {
  const lines = stderr.split("\n").map((line) => oneLine(line));
  const scripted = lines.map((line) => /^error ([a-z-]{1,40}) (.+)$/.exec(line)).find((match) => match !== null);
  if (scripted) return oneLine(`the script failed (exit ${code}): ${scripted[1]}: ${scripted[2]}`);
  const first = lines.find((line) => line !== "");
  return oneLine(first ? `ssh exited with code ${code}: ${first}` : `ssh exited with code ${code}`);
}

/**
 * Runs one command of the provisioner script and gives its parsed answer. Every failure is a `NodeError` with one short
 * line: no ssh, a timeout, an exit code other than 0, or a code 0 with an answer that does not parse.
 */
export async function runProvisioner(
  runner: SshRunner,
  config: string,
  targetId: string,
  command: string,
): Promise<ProvisionerAnswer> {
  if (parseCommand(command) === undefined) throw new NodeError("the command is not valid");
  if (!HOST_ID_RE.test(targetId) || !isAbsolute(config)) throw new NodeError("the grant files are not valid");
  let result: { code: number; stdout: string; stderr: string };

  try {
    result = await runner(config, targetId, command, RUN_TIMEOUT_MS);
  } catch (error) {
    throw new NodeError(oneLine(`ssh could not run: ${error instanceof Error ? error.message : String(error)}`));
  }

  const own = result.stderr.trim();
  if (result.code === 127 && own === NOT_STARTED) throw new NodeError(NO_SSH);
  if (result.code === TIMEOUT_CODE && own === TIMED_OUT)
    throw new NodeError("the run on the target took longer than 15 seconds");
  if (result.code !== 0) throw new NodeError(failureText(result.code, result.stderr));
  const answer = parseAnswer(result.stdout);
  if (!answer) throw new NodeError("the script gave no valid answer");
  return answer;
}

import { LinuxSshdMachine, runSshdCommand, SshdDropin } from "../../server/src/ssh";
import { ExitError } from "./creds";

export const SSHD_USAGE = "usage: claude-rc node sshd install|check|remove";

/**
 * `claude-rc node sshd install|check|remove`: the sshd drop-in that makes sshd read `~/.ssh/authorized_keys.claude-rc`.
 * The text comes from the same command as `claude-rc-launcher sshd-dropin`. It prints its own lines, so the error that
 * ends a failed word has no message.
 */
export async function nodeSshd(options: {
  args: string[];
  out: (line: string) => void;
  err: (line: string) => void;
  dropin?: SshdDropin;
  platform?: NodeJS.Platform;
}): Promise<void> {
  const dropin = options.dropin ?? new SshdDropin(new LinuxSshdMachine(), { command: "claude-rc node sshd" });
  // A second word is an error: `undefined` makes the command print the usage.
  const sub = options.args.length === 1 ? options.args[0] : undefined;
  const code = await runSshdCommand(sub, {
    dropin,
    out: options.out,
    err: options.err,
    platform: options.platform ?? process.platform,
  });
  if (code !== 0) throw new ExitError("", code === 2 ? 2 : 1);
}

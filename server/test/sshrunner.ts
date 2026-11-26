import type { SshRunner } from "../src/sshmaintenance";

// A fake runner of the provisioner script for the maintenance tests: it answers like the Linux script, and no ssh runs.

export interface RunReply {
  code: number;
  stdout?: string;
  stderr?: string;
}

/** A runner that answers each command like the script does, unless `replies` says otherwise. It records each call. */
export function fakeRunner(
  replies: Partial<Record<string, RunReply | ((command: string) => RunReply | Promise<RunReply>)>> = {},
) {
  const calls: { config: string; targetId: string; command: string; timeoutMs: number }[] = [];
  let state = "";
  let present = false;

  const runner: SshRunner = async (config, targetId, command, timeoutMs) => {
    calls.push({ config, targetId, command, timeoutMs });
    const word = command.split(" ")[0] ?? "";
    const scripted = replies[word];
    const reply = typeof scripted === "function" ? await scripted(command) : scripted;
    if (reply) return { code: reply.code, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };

    if (word === "sources") {
      state = command.slice("sources ".length);
      return { code: 0, stdout: `ok sources ${state}\n`, stderr: "" };
    }

    if (word === "on") {
      present = true;
      return { code: 0, stdout: `ok on ${state}\n`, stderr: "" };
    }

    if (word === "status")
      return { code: 0, stdout: `ok status ${present ? "present" : "absent"} ${state}\n`, stderr: "" };
    if (word === "uninstall") return { code: 0, stdout: "ok uninstall\n", stderr: "" };
    return { code: 2, stdout: "", stderr: "error bad-command the command is not valid\n" };
  };

  return {
    runner,
    calls,
    commands: () => calls.map((call) => call.command),
    setPresent: (value: boolean, list: string) => {
      present = value;
      state = list;
    },
  };
}

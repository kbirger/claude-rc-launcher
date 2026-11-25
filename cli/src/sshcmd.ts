import { ExitError } from "./creds";

/** The message when the control socket of the instance is not known. */
export const SSH_OFF_MESSAGE = "SSH access is not turned on for this instance";

/**
 * Sends one line to the control socket of the node and returns the answer line. The commands talk to the node of the
 * instance and not to the hub, so they need no login.
 */
async function ask(control: string, message: object): Promise<Record<string, unknown>> {
  let buffer = "";

  let settle: (line: string) => void = () => {};

  let fail: (error: Error) => void = () => {};

  const answer = new Promise<string>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const socket = await Bun.connect({
    unix: control,
    socket: {
      open: (connection) => {
        connection.write(`${JSON.stringify(message)}\n`);
      },
      data: (connection, chunk) => {
        buffer += Buffer.from(chunk).toString("utf8");
        const end = buffer.indexOf("\n");
        if (end === -1) return;
        settle(buffer.slice(0, end));
        connection.end();
      },
      close: () => {
        fail(new Error("the node closed the connection without an answer"));
      },
      error: (_connection, error) => {
        fail(error);
      },
    },
  }).catch((error: unknown) => {
    throw new ExitError(`cannot reach the SSH control socket ${control}: ${(error as Error).message}`, 1);
  });

  try {
    const parsed: unknown = JSON.parse(await answer);
    if (typeof parsed !== "object" || parsed === null) throw new ExitError("the node sent a bad answer", 1);
    const result = parsed as Record<string, unknown>;
    if (result.ok !== true)
      throw new ExitError(typeof result.error === "string" ? result.error : "the node refused the request", 1);

    return result;
  } finally {
    socket.end();
  }
}

/** Prints one line for each target that the owner may ask for. */
export async function sshTargets(options: { control: string; out: (line: string) => void }): Promise<void> {
  const answer = await ask(options.control, { op: "targets" });
  const targets = (answer.targets ?? []) as { id: string; account: string; address: string }[];
  if (targets.length === 0) options.out("no targets");
  for (const target of targets) options.out(`${target.id}  ${target.account}@${target.address}`);
}

/** Asks for access to a target, waits for the approval, then prints `approved`, the end time, the paths and the ssh command. */
export async function sshRequest(options: {
  control: string;
  targetId: string;
  minutes?: number;
  reason?: string;
  out: (line: string) => void;
}): Promise<void> {
  options.out("waiting for approval");
  const answer = await ask(options.control, {
    op: "request",
    targetId: options.targetId,
    ...(options.minutes === undefined ? {} : { minutes: options.minutes }),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  });
  options.out("approved");
  if (typeof answer.endsAt === "number" && Number.isFinite(answer.endsAt))
    options.out(`access ends at ${new Date(answer.endsAt).toISOString()}`);
  options.out(`socket: ${String(answer.socket)}`);
  options.out(`config: ${String(answer.config)}`);
  options.out(`ssh -F ${String(answer.config)} ${options.targetId}`);
}

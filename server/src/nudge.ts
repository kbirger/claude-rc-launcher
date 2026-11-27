import { lstat, realpath } from "node:fs/promises";
import { connect } from "node:net";
import { asUser } from "./shared/asuser";
import type { Identity } from "./shared/asuser";
import { findSessionSocket } from "./livesessions";

/**
 * Checks that `path` is the user's own unix socket before anything connects to it. It must be a socket (not a link, a
 * file or a FIFO), owned by `ownerUid`, and its real path must be the path itself (no link in any folder of it).
 * Any error gives "refused".
 */
export async function checkSocket(
  path: string,
  ownerUid: number,
  options: { lstat?: typeof lstat; realpath?: typeof realpath } = {},
): Promise<"ok" | "refused"> {
  try {
    const st = await (options.lstat ?? lstat)(path);
    if (st.isSymbolicLink() || !st.isSocket() || st.uid !== ownerUid) return "refused";
    return (await (options.realpath ?? realpath)(path)) === path ? "ok" : "refused";
  } catch {
    return "refused";
  }
}

export type NudgeResult =
  { sent: true } | { sent: false; reason: "not_live" | "socket_refused" | "send_failed" | "unsupported" };

/** The fixed text sent to the session. It never holds the rule. The path is JSON-quoted with line separators escaped, so the text is one line. */
export function nudgeMessage(options: { list: "allow" | "ask" | "deny"; path: string }): string {
  const path = JSON.stringify(options.path)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `The user added a rule to the ${options.list} list in ${path}. You can try the blocked action again. Do not change any settings.`;
}

/** Connects to a unix socket, writes `line` and a newline, and ends. Rejects at the timeout or on any socket error. */
export function sendLine(socket: string, line: string, options: { timeoutMs?: number } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const connection = connect(socket);

    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      connection.destroy();
      err ? reject(err) : resolve();
    };

    const timer = setTimeout(() => {
      finish(new Error("timeout"));
    }, options.timeoutMs ?? 3000);
    connection.on("error", (error) => {
      finish(error);
    });
    connection.on("connect", () =>
      connection.end(line + "\n", () => {
        finish();
      }),
    );
  });
}

/**
 * Runs the send child as the instance user. `argv0` is the child command before "nudge-send". The socket path and the line
 * go to the child on stdin (two lines), so the path is not in the command line. Kills it at the timeout. A failure logs one
 * fixed line (no path, no pid, no message) and rejects.
 */
export async function sendAsUser(
  socket: string,
  line: string,
  identity: Identity,
  options: { argv0?: string[]; timeoutMs?: number; log?: (line: string) => void } = {},
): Promise<void> {
  const argv0 = options.argv0 ?? [process.execPath];
  const log =
    options.log ??
    ((entry: string) => {
      console.log(entry);
    });
  let code: number | undefined;
  let proc: Bun.Subprocess<"pipe", "ignore", "ignore"> | undefined;
  let exited = false;
  const hasExited = () => exited;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const user = asUser(identity, argv0[0], [...argv0.slice(1), "nudge-send"]);
    proc = Bun.spawn([user.cmd, ...user.args], { env: user.env, stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    const child = proc;
    void child.exited.then(() => {
      exited = true;
    });
    timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 3000);
    void child.stdin.write(socket + "\n" + line + "\n");
    await child.stdin.end();
    code = await child.exited;
    if (code !== 0) throw new Error("send failed");
  } catch (error) {
    log(code === undefined ? "nudge child failed" : `nudge child failed exit=${code}`);
    throw error;
  } finally {
    clearTimeout(timer);
    if (proc && !hasExited()) proc.kill("SIGKILL");
  }
}

/** Sends `message` as a user turn to the live session's socket. Never returns or logs the socket path. */
export async function nudge(options: {
  home: string;
  sessionId: string;
  message: string;
  identity?: Identity;
  platform?: NodeJS.Platform;
  find?: typeof findSessionSocket;
  send?: (socket: string, line: string, identity?: Identity) => Promise<void>;
  /** Tests: replace the root check. */
  isRoot?: () => boolean;
  /** Where the fixed child failure line goes. Defaults to console.log. */
  log?: (line: string) => void;
}): Promise<NudgeResult> {
  if ((options.platform ?? process.platform) !== "linux") return { sent: false, reason: "unsupported" };
  // On a root node a missing uid must never fall back to connecting as root in this process.
  if ((options.isRoot ?? (() => process.getuid?.() === 0))() && options.identity?.uid === undefined)
    return { sent: false, reason: "send_failed" };
  const socket = await (options.find ?? findSessionSocket)({ home: options.home, sessionId: options.sessionId });
  if (!socket) return { sent: false, reason: "not_live" };
  const self = process.getuid?.() ?? -1;
  // A uid without a gid must never fall back to connecting as the server user.
  if (options.identity?.uid !== undefined && options.identity.uid !== self && options.identity.gid === undefined)
    return { sent: false, reason: "send_failed" };
  const owner = options.identity?.uid ?? self;
  if ((await checkSocket(socket, owner)) !== "ok") return { sent: false, reason: "socket_refused" };
  const line = JSON.stringify({ type: "user", message: { role: "user", content: options.message } });
  const asOther = options.identity?.uid !== undefined && options.identity.uid !== self;
  const identity = asOther ? options.identity : undefined;
  const send =
    options.send ??
    (identity
      ? (entry: string, value: string) => sendAsUser(entry, value, identity, options.log ? { log: options.log } : {})
      : (entry: string, value: string) => sendLine(entry, value));

  try {
    await send(socket, line, options.identity);
    return { sent: true };
  } catch {
    return { sent: false, reason: "send_failed" };
  }
}

/** Child entry for `nudge-send`: reads two lines from stdin (the socket path, then the line) and sends the line. Prints one fixed word on failure. */
export async function runNudgeSend(
  _argv: string[],
  stdin: () => Promise<string>,
  print: (line: string) => void = console.log,
): Promise<number> {
  try {
    const [socket, line] = (await stdin()).split("\n");
    if (!socket) throw new Error("no socket");
    if (!line) throw new Error("no line");
    await sendLine(socket, line);
    return 0;
  } catch {
    print("failed");
    return 1;
  }
}

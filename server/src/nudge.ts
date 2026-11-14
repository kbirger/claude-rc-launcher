import { lstat, realpath } from "node:fs/promises";
import { connect } from "node:net";
import { asUser, type Identity } from "./asuser";
import { findSessionSocket } from "./livesessions";

/**
 * Checks that `path` is the user's own unix socket before anything connects to it. It must be a socket (not a link, a
 * file or a FIFO), owned by `ownerUid`, and its real path must be the path itself (no link in any folder of it).
 * Any error gives "refused".
 */
export async function checkSocket(
  path: string,
  ownerUid: number,
  o: { lstat?: typeof lstat; realpath?: typeof realpath } = {},
): Promise<"ok" | "refused"> {
  try {
    const st = await (o.lstat ?? lstat)(path);
    if (st.isSymbolicLink() || !st.isSocket() || st.uid !== ownerUid) return "refused";
    return (await (o.realpath ?? realpath)(path)) === path ? "ok" : "refused";
  } catch {
    return "refused";
  }
}

export type NudgeResult = { sent: true } | { sent: false; reason: "not_live" | "socket_refused" | "send_failed" | "unsupported" };

/** The fixed text sent to the session. It never holds the rule. The path is JSON-quoted with line separators escaped, so the text is one line. */
export function nudgeMessage(e: { list: "allow" | "ask" | "deny"; path: string }): string {
  const path = JSON.stringify(e.path).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `The user added a rule to the ${e.list} list in ${path}. You can try the blocked action again. Do not change any settings.`;
}

/** Connects to a unix socket, writes `line` and a newline, and ends. Rejects at the timeout or on any socket error. */
export function sendLine(socket: string, line: string, o: { timeoutMs?: number } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const c = connect(socket);
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      c.destroy();
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => finish(new Error("timeout")), o.timeoutMs ?? 3000);
    c.on("error", (e) => finish(e));
    c.on("connect", () => c.end(line + "\n", () => finish()));
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
  o: { argv0?: string[]; timeoutMs?: number; log?: (l: string) => void } = {},
): Promise<void> {
  const argv0 = o.argv0 ?? [process.execPath];
  const log = o.log ?? ((l: string) => console.log(l));
  let code: number | undefined;
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let exited = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const w = asUser(identity, argv0[0], [...argv0.slice(1), "nudge-send"]);
    proc = Bun.spawn([w.cmd, ...w.args], { env: w.env, stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    const child = proc;
    void child.exited.then(() => { exited = true; });
    timer = setTimeout(() => child.kill("SIGKILL"), o.timeoutMs ?? 3000);
    child.stdin!.write(socket + "\n" + line + "\n");
    await child.stdin!.end();
    code = await child.exited;
    if (code !== 0) throw new Error("send failed");
  } catch (e) {
    log(code === undefined ? "nudge child failed" : `nudge child failed exit=${code}`);
    throw e;
  } finally {
    clearTimeout(timer);
    if (proc && !exited) proc.kill("SIGKILL");
  }
}

/** Sends `message` as a user turn to the live session's socket. Never returns or logs the socket path. */
export async function nudge(o: {
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
  if ((o.platform ?? process.platform) !== "linux") return { sent: false, reason: "unsupported" };
  // On a root node a missing uid must never fall back to connecting as root in this process.
  if ((o.isRoot ?? (() => process.getuid!() === 0))() && o.identity?.uid === undefined) return { sent: false, reason: "send_failed" };
  const socket = await (o.find ?? findSessionSocket)({ home: o.home, sessionId: o.sessionId });
  if (!socket) return { sent: false, reason: "not_live" };
  const self = process.getuid!();
  // A uid without a gid must never fall back to connecting as the server user.
  if (o.identity?.uid !== undefined && o.identity.uid !== self && o.identity.gid === undefined) return { sent: false, reason: "send_failed" };
  const owner = o.identity?.uid ?? self;
  if ((await checkSocket(socket, owner)) !== "ok") return { sent: false, reason: "socket_refused" };
  const line = JSON.stringify({ type: "user", message: { role: "user", content: o.message } });
  const asOther = o.identity?.uid !== undefined && o.identity.uid !== self;
  const send = o.send ?? (asOther ? (s: string, l: string) => sendAsUser(s, l, o.identity!, o.log ? { log: o.log } : {}) : (s: string, l: string) => sendLine(s, l));
  try {
    await send(socket, line, o.identity);
    return { sent: true };
  } catch {
    return { sent: false, reason: "send_failed" };
  }
}

/** Child entry for `nudge-send`: reads two lines from stdin (the socket path, then the line) and sends the line. Prints one fixed word on failure. */
export async function runNudgeSend(_argv: string[], stdin: () => Promise<string>, print: (m: string) => void = console.log): Promise<number> {
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

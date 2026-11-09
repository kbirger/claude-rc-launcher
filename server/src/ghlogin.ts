import { asUser, type Identity, type IdentityFor } from "./asuser";
import { HttpError } from "./instances";
import type { Runner, RunResult } from "./runner";

export type LoginProc = { onOutput(cb: (chunk: string) => void): void; exited: Promise<number>; kill(): void };
export type LoginSpawner = (cmd: string, args: string[], opts: { env: Record<string, string>; stdin: string }) => LoginProc;
export type LoginClock = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (t: unknown) => void;
};
export type LoginStatus = { state: "pending" | "done" | "failed"; error?: string };

const LOGIN_TTL_MS = 10 * 60 * 1000;
const CODE_WAIT_MS = 15 * 1000;
const FORGET_MS = 10 * 60 * 1000;
const SETUP_TIMEOUT_MS = 60 * 1000;
const PIPE_GRACE_MS = 300;
const CODE_RE = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/i;
const URL_RE = /(https?:\/\/\S+)/;

/** Streams a command with Bun.spawn. stdout and stderr both go to onOutput. kill() ends the whole process group. */
export const bunLoginSpawner: LoginSpawner = (cmd, args, opts) => {
  const proc = Bun.spawn([cmd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: new Blob([opts.stdin]),
    env: opts.env,
    detached: true,
  });
  const cbs: ((chunk: string) => void)[] = [];
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const pump = (stream: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    const reader = stream.getReader();
    readers.push(reader);
    return (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = dec.decode(value, { stream: true });
          for (const cb of cbs) { try { cb(text); } catch {} }
        }
      } catch {}
    })();
  };
  const reads = [pump(proc.stdout), pump(proc.stderr)];
  const cancelReaders = () => { for (const r of readers) { try { r.cancel().catch(() => {}); } catch {} } };
  const exited = (async () => {
    const code = await proc.exited;
    let grace: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(reads), new Promise((r) => { grace = setTimeout(r, PIPE_GRACE_MS); })]);
    clearTimeout(grace);
    cancelReaders();
    return code;
  })();
  return {
    onOutput: (cb) => { cbs.push(cb); },
    exited,
    kill: () => {
      try { process.kill(-proc.pid, "SIGKILL"); } catch { try { proc.kill("SIGKILL"); } catch {} }
      cancelReaders();
    },
  };
};

type Entry = {
  id: string;
  key: string;
  state: "pending" | "done" | "failed";
  error?: string;
  /** Only kept while the login is pending, so the code is not held after the login ends. */
  ready?: Promise<LoginInfo>;
};
type LoginInfo = { id: string; code: string; url: string };

export type LoginManager = {
  start(user?: string): Promise<LoginInfo>;
  status(id: string): Promise<LoginStatus>;
};

export function createLoginManager(deps: {
  run: Runner;
  identityFor: IdentityFor;
  spawn?: LoginSpawner;
  clock?: LoginClock;
  /** Tells whether a failed command means the tool is missing (shared with the cloner). */
  missingTool: (cmd: string, stderr: string, tool: string) => string;
}): LoginManager {
  const spawn = deps.spawn ?? bunLoginSpawner;
  const clock: LoginClock = deps.clock ?? { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) };
  const byId = new Map<string, Entry>();
  const pendingByKey = new Map<string, Entry>();
  const startingByKey = new Map<string, Promise<LoginInfo>>();

  const begin = async (key: string, identity: Identity): Promise<LoginInfo> => {
    const w = asUser(identity, "gh", ["auth", "login", "--web", "--hostname", "github.com", "--git-protocol", "https"]);
    // gh prints the code and waits for Enter only when prompts are allowed; a no-op BROWSER stops it from opening one.
    const env = { ...w.env, BROWSER: "true" };
    delete (env as Record<string, string | undefined>).GH_PROMPT_DISABLED;

    const id = crypto.randomUUID().replaceAll("-", "");
    let proc: LoginProc;
    try {
      proc = spawn(w.cmd, w.args, { env, stdin: "\n" });
    } catch (e) {
      throw new HttpError(500, `${deps.missingTool(w.cmd, e instanceof Error ? e.message : String(e), "gh")} is not installed`);
    }

    let finished = false;
    let code = "";
    let url = "";
    let buf = "";
    let firstLine = "";
    const timers: unknown[] = [];
    let resolveReady!: (v: { id: string; code: string; url: string }) => void;
    let rejectReady!: (e: unknown) => void;
    const ready = new Promise<{ id: string; code: string; url: string }>((res, rej) => { resolveReady = res; rejectReady = rej; });
    ready.catch(() => {});
    const entry: Entry = { id, key, state: "pending", ready };
    byId.set(id, entry);
    pendingByKey.set(key, entry);

    const scrub = (s: string) => (code ? s.split(code).join("***") : s);
    const settle = (state: "done" | "failed", error?: string) => {
      if (finished) return;
      finished = true;
      entry.state = state;
      entry.ready = undefined;
      code = "";
      url = "";
      if (error !== undefined) entry.error = error;
      if (pendingByKey.get(key) === entry) pendingByKey.delete(key);
      for (const t of timers) clock.clearTimeout(t);
      timers.length = 0;
      clock.setTimeout(() => { byId.delete(id); }, FORGET_MS);
    };
    const abort = (e: HttpError) => {
      try { proc.kill(); } catch {}
      settle("failed", e.message);
      byId.delete(id);
      rejectReady(e);
    };

    const line = (l: string) => {
      const t = l.trim();
      if (!t) return;
      const c = CODE_RE.exec(t);
      if (c && !code) code = c[1].toUpperCase();
      else if (!c && !firstLine && !/^open this url/i.test(t)) firstLine = t;
      if (/open this url/i.test(t) || (!url && /github\.com\/login\/device/.test(t))) {
        const u = URL_RE.exec(t);
        if (u && !url) url = u[1];
      }
      if (code && url && !entry.error && entry.state === "pending") resolveReady({ id, code, url });
    };
    proc.onOutput((chunk) => {
      buf += chunk;
      if (buf.length > 64 * 1024) buf = buf.slice(-64 * 1024);
      const parts = buf.split(/\r?\n/);
      buf = parts.pop() ?? "";
      for (const p of parts) line(p);
    });

    timers.push(clock.setTimeout(() => {
      if (!code || !url) abort(new HttpError(504, "GitHub did not return a login code in time"));
    }, CODE_WAIT_MS));
    timers.push(clock.setTimeout(() => {
      try { proc.kill(); } catch {}
      settle("failed", "login timed out");
    }, LOGIN_TTL_MS));

    const onExit = async (exitCode: number) => {
      if (finished) return;
      // The process ended, so neither the code wait nor the lifetime timer matters now.
      for (const t of timers) clock.clearTimeout(t);
      timers.length = 0;
      if (buf) { line(buf); buf = ""; }
      if (!code || !url) {
        const msg = exitCode === 127
          ? `${deps.missingTool(w.cmd, firstLine, "gh")} is not installed`
          : `gh login failed: ${scrub(firstLine) || `exit ${exitCode}`}`;
        abort(new HttpError(exitCode === 127 ? 500 : 502, msg));
        return;
      }
      if (exitCode !== 0) {
        settle("failed", `gh login failed: ${scrub(firstLine) || `exit ${exitCode}`}`);
        return;
      }
      const s = asUser(identity, "gh", ["auth", "setup-git"]);
      let r: RunResult;
      try {
        r = await deps.run(s.cmd, s.args, { env: s.env, timeoutMs: SETUP_TIMEOUT_MS });
      } catch {
        settle("failed", "gh auth setup-git failed");
        return;
      }
      if (r.code === 0 && !r.timedOut) settle("done");
      else settle("failed", `gh auth setup-git failed: ${scrub(r.stderr.split("\n").map((l) => l.trim()).find(Boolean) ?? "") || `exit ${r.code}`}`);
    };
    const onFail = () => {
      if (finished) return;
      if (!code || !url) abort(new HttpError(502, "gh login failed"));
      else settle("failed", "gh login failed");
    };
    void proc.exited.then(onExit).catch(onFail);

    return ready;
  };

  return {
    async start(user) {
      const identity = await deps.identityFor(user);
      // One key per OS account: "no user" and the service user's name resolve to the same identity.
      const key = `${identity.uid ?? "service"}|${identity.home}`;
      const existing = pendingByKey.get(key);
      if (existing?.ready) return existing.ready;
      const starting = startingByKey.get(key);
      if (starting) return starting;
      const p = begin(key, identity).finally(() => { startingByKey.delete(key); });
      startingByKey.set(key, p);
      return p;
    },
    async status(id) {
      const e = byId.get(id);
      if (!e) throw new HttpError(404, "unknown login");
      return e.error === undefined ? { state: e.state } : { state: e.state, error: e.error };
    },
  };
}

import { asUser } from "../shared/asuser";
import type { Identity, IdentityFor } from "../shared/asuser";
import type { Runner, RunResult } from "../shared/runner";
import { HttpError } from "./InstanceService";

export interface LoginProc {
  onOutput(cb: (chunk: string) => void): void;
  exited: Promise<number>;
  kill(): void;
}
export type LoginSpawner = (
  cmd: string,
  args: string[],
  opts: { env: Record<string, string>; stdin: string },
) => LoginProc;
export interface LoginClock {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
}
export interface LoginStatus {
  state: "pending" | "done" | "failed";
  error?: string;
}

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

          for (const cb of cbs) {
            try {
              cb(text);
            } catch {}
          }
        }
      } catch {}
    })();
  };

  const reads = [pump(proc.stdout), pump(proc.stderr)];

  const cancelReaders = () => {
    for (const readableStreamDefaultReader of readers) {
      try {
        readableStreamDefaultReader.cancel().catch(() => {});
      } catch {}
    }
  };

  const exited = (async () => {
    const code = await proc.exited;
    let grace: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(reads),
      new Promise((resolve) => {
        grace = setTimeout(resolve, PIPE_GRACE_MS);
      }),
    ]);
    clearTimeout(grace);
    cancelReaders();
    return code;
  })();
  return {
    onOutput: (cb) => {
      cbs.push(cb);
    },
    exited,
    kill: () => {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }

      cancelReaders();
    },
  };
};

interface Entry {
  id: string;
  key: string;
  state: "pending" | "done" | "failed";
  error?: string;
  /** Only kept while the login is pending, so the code is not held after the login ends. */
  ready?: Promise<LoginInfo>;
}
interface LoginInfo {
  id: string;
  code: string;
  url: string;
}

export interface LoginManager {
  start(user?: string): Promise<LoginInfo>;
  status(id: string): Promise<LoginStatus>;
}

export function createLoginManager(deps: {
  run: Runner;
  identityFor: IdentityFor;
  spawn?: LoginSpawner;
  clock?: LoginClock;
  /** Tells whether a failed command means the tool is missing (shared with the cloner). */
  missingTool: (cmd: string, stderr: string, tool: string) => string;
}): LoginManager {
  const spawn = deps.spawn ?? bunLoginSpawner;
  const clock: LoginClock = deps.clock ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (timer) => {
      clearTimeout(timer as ReturnType<typeof setTimeout>);
    },
  };
  const byId = new Map<string, Entry>();
  const pendingByKey = new Map<string, Entry>();
  const startingByKey = new Map<string, Promise<LoginInfo>>();

  const begin = async (key: string, identity: Identity): Promise<LoginInfo> => {
    const user = asUser(identity, "gh", [
      "auth",
      "login",
      "--web",
      "--hostname",
      "github.com",
      "--git-protocol",
      "https",
    ]);
    // gh prints the code and waits for Enter only when prompts are allowed; a no-op BROWSER stops it from opening one.
    const env = { ...user.env, BROWSER: "true" };
    delete (env as Record<string, string | undefined>).GH_PROMPT_DISABLED;

    const id = crypto.randomUUID().replaceAll("-", "");
    let proc: LoginProc;

    try {
      proc = spawn(user.cmd, user.args, { env, stdin: "\n" });
    } catch (error) {
      throw new HttpError(
        500,
        `${deps.missingTool(user.cmd, error instanceof Error ? error.message : String(error), "gh")} is not installed`,
      );
    }

    let finished = false;
    let code = "";
    let url = "";
    let buf = "";
    let firstLine = "";
    const timers: unknown[] = [];
    let resolveReady!: (event: { id: string; code: string; url: string }) => void;
    let rejectReady!: (value: unknown) => void;
    const ready = new Promise<{ id: string; code: string; url: string }>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });
    ready.catch(() => {});
    const entry: Entry = { id, key, state: "pending", ready };
    byId.set(id, entry);
    pendingByKey.set(key, entry);

    const scrub = (value: string) => (code ? value.split(code).join("***") : value);

    const settle = (state: "done" | "failed", error?: string) => {
      if (finished) return;
      finished = true;
      entry.state = state;
      entry.ready = undefined;
      code = "";
      url = "";
      if (error !== undefined) entry.error = error;
      if (pendingByKey.get(key) === entry) pendingByKey.delete(key);
      for (const timer of timers) clock.clearTimeout(timer);
      timers.length = 0;
      clock.setTimeout(() => {
        byId.delete(id);
      }, FORGET_MS);
    };

    const abort = (httpError: HttpError) => {
      try {
        proc.kill();
      } catch {}

      settle("failed", httpError.message);
      byId.delete(id);
      rejectReady(httpError);
    };

    const line = (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const match = CODE_RE.exec(trimmed);
      if (match && !code) code = match[1].toUpperCase();
      else if (!match && !firstLine && !/^open this url/i.test(trimmed)) firstLine = trimmed;

      if (/open this url/i.test(trimmed) || (!url && trimmed.includes("github.com/login/device"))) {
        const urlMatch = URL_RE.exec(trimmed);
        if (urlMatch && !url) url = urlMatch[1];
      }

      if (code && url && !entry.error && entry.state === "pending") resolveReady({ id, code, url });
    };

    proc.onOutput((chunk) => {
      buf += chunk;
      if (buf.length > 64 * 1024) buf = buf.slice(-64 * 1024);
      const parts = buf.split(/\r?\n/);
      buf = parts.pop() ?? "";
      for (const part of parts) line(part);
    });

    timers.push(
      clock.setTimeout(() => {
        if (!code || !url) abort(new HttpError(504, "GitHub did not return a login code in time"));
      }, CODE_WAIT_MS),
    );
    timers.push(
      clock.setTimeout(() => {
        try {
          proc.kill();
        } catch {}

        settle("failed", "login timed out");
      }, LOGIN_TTL_MS),
    );

    const onExit = async (exitCode: number) => {
      if (finished) return;
      // The process ended, so neither the code wait nor the lifetime timer matters now.
      for (const timer of timers) clock.clearTimeout(timer);
      timers.length = 0;

      if (buf) {
        line(buf);
        buf = "";
      }

      if (!code || !url) {
        const msg =
          exitCode === 127
            ? `${deps.missingTool(user.cmd, firstLine, "gh")} is not installed`
            : `gh login failed: ${scrub(firstLine) || `exit ${exitCode}`}`;
        abort(new HttpError(exitCode === 127 ? 500 : 502, msg));
        return;
      }

      if (exitCode !== 0) {
        settle("failed", `gh login failed: ${scrub(firstLine) || `exit ${exitCode}`}`);
        return;
      }

      const harness = asUser(identity, "gh", ["auth", "setup-git"]);
      let runResult: RunResult;

      try {
        runResult = await deps.run(harness.cmd, harness.args, { env: harness.env, timeoutMs: SETUP_TIMEOUT_MS });
      } catch {
        settle("failed", "gh auth setup-git failed");
        return;
      }

      if (runResult.code === 0 && !runResult.timedOut) settle("done");
      else
        settle(
          "failed",
          `gh auth setup-git failed: ${
            scrub(
              runResult.stderr
                .split("\n")
                .map((part) => part.trim())
                .find(Boolean) ?? "",
            ) || `exit ${runResult.code}`
          }`,
        );
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
      const promise = begin(key, identity).finally(() => {
        startingByKey.delete(key);
      });
      startingByKey.set(key, promise);
      return promise;
    },
    status(id) {
      const response = byId.get(id);
      if (!response) return Promise.reject(new HttpError(404, "unknown login"));
      return Promise.resolve(
        response.error === undefined ? { state: response.state } : { state: response.state, error: response.error },
      );
    },
  };
}

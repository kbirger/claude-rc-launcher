export type RunOptions = {
  cwd?: string;
  /** Replaces the whole environment of the child (it is not merged with process.env). */
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
};
export type RunResult = { code: number; stdout: string; stderr: string; timedOut?: boolean };
export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

/** Reads a stream into a buffer that stays readable even if the read never ends. */
function collect(stream: ReadableStream<Uint8Array>) {
  const dec = new TextDecoder();
  const box = { text: "", done: Promise.resolve() };
  box.done = (async () => {
    try {
      for await (const chunk of stream) box.text += dec.decode(chunk, { stream: true });
    } catch {}
  })();
  return box;
}

/** Runs a command via Bun.spawn with an argv array (no shell). Spawn failures yield code 127.
 * On timeout the whole process group is killed, and we stop waiting for pipes that
 * descendants may still hold open. */
export const bunRunner: Runner = async (cmd, args, opts = {}) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn([cmd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
    });
    let timedOut = false;
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); }
      }, opts.timeoutMs);
    }
    const out = collect(proc.stdout);
    const err = collect(proc.stderr);
    const code = await proc.exited;
    if (timedOut) {
      // Give the pipes a short moment to drain, then stop waiting.
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all([out.done, err.done]),
        new Promise((r) => { grace = setTimeout(r, 300); }),
      ]);
      clearTimeout(grace);
      try { proc.stdout.cancel(); proc.stderr.cancel(); } catch {}
      return { code: code || 124, stdout: out.text, stderr: err.text, timedOut: true };
    }
    await Promise.all([out.done, err.done]);
    return { code, stdout: out.text, stderr: err.text };
  } catch (e) {
    return { code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
};

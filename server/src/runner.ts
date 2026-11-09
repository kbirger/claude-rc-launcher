export type RunOptions = {
  cwd?: string;
  /** Replaces the whole environment of the child (it is not merged with process.env). */
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
};
export type RunResult = { code: number; stdout: string; stderr: string; timedOut?: boolean };
export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

/** Runs a command via Bun.spawn with an argv array (no shell). Spawn failures yield code 127. */
export const bunRunner: Runner = async (cmd, args, opts = {}) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn([cmd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
      cwd: opts.cwd,
      env: opts.env,
    });
    let timedOut = false;
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, opts.timeoutMs);
    }
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return timedOut ? { code: code || 124, stdout, stderr, timedOut: true } : { code, stdout, stderr };
  } catch (e) {
    return { code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
};

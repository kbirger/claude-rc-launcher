export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (cmd: string, args: string[]) => Promise<RunResult>;

/** Runs a command via Bun.spawn with an argv array (no shell). Spawn failures yield code 127. */
export const bunRunner: Runner = async (cmd, args) => {
  try {
    const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } catch (e) {
    return { code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
};

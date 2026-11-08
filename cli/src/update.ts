import type { Flags } from "./args";
import { ExitError } from "./creds";
import { obtainBinary, releaseCpu, sha256, type Sys, realSys } from "./nodesetup";
import { VERSION } from "../../server/src/version";

const NAME = "claude-rc";
const VERSION_TIMEOUT_MS = 10_000;

/**
 * `claude-rc update`: replaces this client binary with a release build. The previous binary is kept as `.prev` and
 * comes back if the new one does not run. Nothing else is touched and the hub is not called.
 */
export async function selfUpdate(o: { flags: Flags; out: (s: string) => void; sys?: Sys }): Promise<void> {
  const sys = o.sys ?? realSys;
  const { flags, out } = o;
  const exe = sys.execPath ?? process.execPath;

  // 1. Checks
  const base = exe.split(/[\\/]/).pop();
  if (base !== NAME && base !== `${NAME}.exe`) throw new ExitError("claude-rc update works on the installed binary only. This looks like a source run", 1);
  if (sys.platform === "win32") throw new ExitError("updating on Windows is not supported yet. Download the new claude-rc-windows-x64.exe from the release page", 1);
  if (sys.platform !== "linux" && sys.platform !== "darwin") throw new ExitError(`unsupported operating system: ${sys.platform}`, 1);
  const cpu = releaseCpu(sys);
  if (!cpu) throw new ExitError(`unsupported CPU architecture: ${sys.arch}`, 1);

  // 2. The new binary
  const binary = await obtainBinary(sys, flags, `${NAME}-${sys.platform}-${cpu}`, out);
  if (sha256(binary) === sha256(sys.readFile(exe))) return out(`claude-rc is already up to date (${VERSION})`);

  // 3. Install. Elevate only when this user cannot write to the directory.
  const dir = exe.slice(0, Math.max(exe.lastIndexOf("/"), 0)) || "/";
  const plain = sys.writable?.(dir) ?? false;
  const run = (args: string[]) => {
    if (!plain) return sys.sudo(args);
    const r = sys.run(args);
    return { code: r.code, stdout: r.stdout, stderr: r.stderr ?? "" };
  };
  const step = (args: string[], what: string) => {
    const r = run(args);
    if (r.code !== 0) throw new ExitError(`${what} failed (${args[0]} exit ${r.code})${r.stderr ? `: ${r.stderr.trim()}` : ""}`, 1);
  };
  // The old .prev is only replaced once the new file is in place next to the executable.
  const tmp = sys.writeTemp(NAME, binary);
  try {
    step(["install", "-m", "755", tmp, `${exe}.new`], "installing the binary");
    step(["cp", "-p", exe, `${exe}.prev`], "backing up the installed binary");
    step(["mv", "-f", `${exe}.new`, exe], "installing the binary");
  } catch (e) {
    run(["rm", "-f", `${exe}.new`]);
    throw e;
  } finally {
    sys.removeTemp(tmp);
  }

  // 4. Make sure that the new binary runs
  const ran = sys.run([exe, "--version"], { timeoutMs: VERSION_TIMEOUT_MS });
  const line = ran.stdout.trim().split("\n")[0] ?? "";
  if (ran.code === 0 && line.startsWith(`${NAME} `)) {
    return out(`updated ${exe} from ${VERSION} to ${line.slice(NAME.length + 1)} (the previous binary is kept as ${exe}.prev)`);
  }

  // 5. Roll back
  if (run(["mv", "-f", `${exe}.prev`, exe]).code !== 0) {
    throw new ExitError(
      `the update failed and the previous binary could not be restored. The NEW binary is still installed and does not run. The previous binary is at ${exe}.prev. To restore it by hand, run: ${plain ? "" : "sudo "}mv -f ${exe}.prev ${exe}`,
      1,
    );
  }
  throw new ExitError(`the update failed: the new binary did not answer --version with a claude-rc version line within ${VERSION_TIMEOUT_MS / 1000} seconds. The previous binary was restored`, 1);
}

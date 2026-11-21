import { installWithBackup, restorePrevious, ReleaseError } from "../../server/src/release";
import type { ReleaseIo } from "../../server/src/release";
import { VERSION } from "../../server/src/version";
import type { Flags } from "./args";
import { ExitError } from "./creds";
import { obtainBinary, releaseCpu, sha256, realSys } from "./nodesetup";
import type { Sys } from "./nodesetup";

const NAME = "claude-rc";
const VERSION_TIMEOUT_MS = 10_000;

/**
 * `claude-rc update`: replaces this client binary with a release build. The previous binary is kept as `.prev` and
 * comes back if the new one does not run. Nothing else is touched and the hub is not called.
 */
export async function selfUpdate(options: { flags: Flags; out: (line: string) => void; sys?: Sys }): Promise<void> {
  const sys = options.sys ?? realSys;
  const { flags, out } = options;
  const exe = sys.execPath ?? process.execPath;

  // 1. Checks
  const base = exe.split(/[\\/]/).pop();
  if (base !== NAME && base !== `${NAME}.exe`)
    throw new ExitError("claude-rc update works on the installed binary only. This looks like a source run", 1);
  if (sys.platform === "win32")
    throw new ExitError(
      "updating on Windows is not supported yet. Download the new claude-rc-windows-x64.exe from the release page",
      1,
    );
  if (sys.platform !== "linux" && sys.platform !== "darwin")
    throw new ExitError(`unsupported operating system: ${sys.platform}`, 1);
  const cpu = releaseCpu(sys);
  if (!cpu) throw new ExitError(`unsupported CPU architecture: ${sys.arch}`, 1);

  // 2. The new binary
  const binary = await obtainBinary(sys, flags, `${NAME}-${sys.platform}-${cpu}`, out);

  if (sha256(binary) === sha256(sys.readFile(exe))) {
    out(`claude-rc is already up to date (${VERSION})`);
    return;
  }

  // 3. Install. Elevate only when this user cannot write to the directory.
  const dir = exe.slice(0, Math.max(exe.lastIndexOf("/"), 0)) || "/";
  const plain = sys.writable?.(dir) ?? false;

  const run = (args: string[]) => {
    if (!plain) return sys.sudo(args);
    const outcome = sys.run(args);
    return { code: outcome.code, stdout: outcome.stdout, stderr: outcome.stderr ?? "" };
  };

  const io: ReleaseIo = { fetch: sys.fetch, run, writeTemp: sys.writeTemp, removeTemp: sys.removeTemp };

  try {
    installWithBackup(io, exe, binary);
  } catch (error) {
    if (error instanceof ReleaseError) throw new ExitError(error.message, 1);
    throw error;
  }

  // 4. Make sure that the new binary runs
  const ran = sys.run([exe, "--version"], { timeoutMs: VERSION_TIMEOUT_MS });
  const line = ran.stdout.trim().split("\n")[0] ?? "";

  if (ran.code === 0 && line.startsWith(`${NAME} `)) {
    out(
      `updated ${exe} from ${VERSION} to ${line.slice(NAME.length + 1)} (the previous binary is kept as ${exe}.prev)`,
    );
    return;
  }

  // 5. Roll back
  if (!restorePrevious(io, exe)) {
    throw new ExitError(
      `the update failed and the previous binary could not be restored. The NEW binary is still installed and does not run. The previous binary is at ${exe}.prev. To restore it by hand, run: ${plain ? "" : "sudo "}mv -f ${exe}.prev ${exe}`,
      1,
    );
  }

  throw new ExitError(
    `the update failed: the new binary did not answer --version with a claude-rc version line within ${VERSION_TIMEOUT_MS / 1000} seconds. The previous binary was restored`,
    1,
  );
}

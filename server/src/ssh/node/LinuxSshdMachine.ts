import { constants, existsSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { runCommand } from "./commands";
import { removeEntry, removeQuietly } from "./files";
import type { CommandResult, SshdMachine } from "./SshdDropin";

// The real machine of the sshd drop-in. The drop-in folder belongs to root, but the writes still never follow a link:
// a link at the drop-in path or a folder that is a link is refused, and the file is written to a temporary file in
// the same folder and renamed into place, so sshd never reads a half-written file.

/** The fallback path of sshd: `sudo` often runs with a PATH that has no `/usr/sbin`. */
const SSHD_FALLBACK = "/usr/sbin/sshd";
/** `sshd -T`, `sshd -t` and `systemctl reload` normally end in well under a second. */
const COMMAND_TIMEOUT_MS = 30_000;
const NEW_FILE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

export interface LinuxSshdMachineOptions {
  /** Runs one command. The default spawns it, and refuses to under test. */
  run?: (cmd: string[]) => Promise<CommandResult>;
  /** The path of the sshd binary. `undefined`: no sshd. */
  findSshd?: () => string | undefined;
  isRoot?: () => boolean;
}

const codeOf = (error: unknown): unknown => (error as NodeJS.ErrnoException | undefined)?.code;

/** A test must never run the real sshd or systemctl: a reload changes the sshd of the machine. */
function defaultRun(cmd: string[]): Promise<CommandResult> {
  if (process.env.NODE_ENV === "test") {
    return Promise.reject(
      new Error(`${cmd[0] ?? "a command"} does not run under test: inject run in LinuxSshdMachine`),
    );
  }

  return runCommand(cmd, COMMAND_TIMEOUT_MS);
}

function defaultFindSshd(): string | undefined {
  return Bun.which("sshd") ?? (existsSync(SSHD_FALLBACK) ? SSHD_FALLBACK : undefined);
}

/** The sshd of a Linux machine with systemd. */
export class LinuxSshdMachine implements SshdMachine {
  private readonly run: (cmd: string[]) => Promise<CommandResult>;
  private readonly findSshd: () => string | undefined;
  private readonly root: () => boolean;

  constructor(options: LinuxSshdMachineOptions = {}) {
    this.run = options.run ?? defaultRun;
    this.findSshd = options.findSshd ?? defaultFindSshd;
    this.root = options.isRoot ?? (() => process.getuid?.() === 0);
  }

  isRoot(): boolean {
    return this.root();
  }

  sshdEffective(account?: string): Promise<CommandResult | undefined> {
    const sshd = this.findSshd();
    if (!sshd) return Promise.resolve(undefined);
    const match = account === undefined ? [] : ["-C", `user=${account},host=localhost,addr=127.0.0.1`];
    return this.run([sshd, "-T", ...match]);
  }

  sshdTest(): Promise<CommandResult> {
    const sshd = this.findSshd();
    if (!sshd) return Promise.resolve({ code: 127, stdout: "", stderr: "sshd is not installed" });
    return this.run([sshd, "-t"]);
  }

  async readFile(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (codeOf(error) === "ENOENT") return undefined;
      throw error;
    }
  }

  /**
   * Makes the folder with mode 755 when it is missing, writes `<path>.tmp-<pid>` with mode 644 and owner root, and
   * renames it to the path. Any failure after the open removes the temporary file.
   */
  async writeFile(path: string, text: string): Promise<void> {
    const folder = dirname(path);
    const made = await mkdir(folder, { recursive: true, mode: 0o755 });
    // mkdir does not complain about a link to a folder, so the check comes after it.
    await this.requireRealFolder(folder);
    // The umask can take bits off the mode of a new folder. An existing folder keeps the mode its admin gave it.
    if (made !== undefined) await chmod(folder, 0o755);
    await this.refuseLinkAt(path);

    const temp = `${path}.tmp-${process.pid}`;
    // A temporary file of a run that crashed. The folder is a real folder, so the unlink cannot leave it.
    await removeEntry(temp);
    const handle: FileHandle = await open(temp, NEW_FILE, 0o644);

    try {
      await handle.writeFile(text);
      await handle.chmod(0o644);
      if (this.root()) await handle.chown(0, 0);
      await handle.sync();
      await handle.close();
      await rename(temp, path);
    } catch (error) {
      await handle.close().catch(() => {});
      await removeQuietly(temp);
      throw error;
    }
  }

  async removeFile(path: string): Promise<void> {
    await this.requireRealFolder(dirname(path));
    await removeEntry(path);
  }

  /** `systemctl reload ssh` (Debian, Ubuntu), then `systemctl reload sshd` (Fedora, Arch). */
  async reloadSshd(): Promise<{ ok: boolean; detail: string }> {
    const ssh = await this.run(["systemctl", "reload", "ssh"]);
    if (ssh.code === 0) return { ok: true, detail: "reloaded ssh" };
    const sshd = await this.run(["systemctl", "reload", "sshd"]);
    if (sshd.code === 0) return { ok: true, detail: "reloaded sshd" };
    return { ok: false, detail: `ssh: ${failure(ssh)}; sshd: ${failure(sshd)}` };
  }

  private async requireRealFolder(folder: string): Promise<void> {
    let info;

    try {
      info = await lstat(folder);
    } catch (error) {
      if (codeOf(error) === "ENOENT") return;
      throw error;
    }

    if (info.isSymbolicLink()) throw new Error(`${folder} is a symbolic link. Nothing was changed.`);
    if (!info.isDirectory()) throw new Error(`${folder} is not a folder. Nothing was changed.`);
  }

  private async refuseLinkAt(path: string): Promise<void> {
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new Error(`${path} is a symbolic link. Nothing was changed.`);
    } catch (error) {
      if (codeOf(error) !== "ENOENT") throw error;
    }
  }
}

function failure(result: CommandResult): string {
  return result.stderr.trim() || `exit code ${result.code}`;
}

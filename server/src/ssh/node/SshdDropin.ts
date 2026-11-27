import { MANAGED_KEY_FILE } from "../constants";

// The sshd drop-in that makes sshd read the dedicated key file `~/.ssh/authorized_keys.claude-rc`. sshd uses the first
// value of a keyword, so the drop-in repeats the list that sshd uses now and adds the file. The name starts with `49-`,
// so it loads before the other drop-ins. All machine access goes through `SshdMachine`, so the tests use a fake.

export const DROPIN_PATH = "/etc/ssh/sshd_config.d/49-claude-rc.conf";
export const MAIN_CONFIG_PATH = "/etc/ssh/sshd_config";
export const DROPIN_MARKER = "# Managed by claude-rc-launcher. Remove it with: sudo claude-rc node sshd remove";
/** The list of sshd when the config sets no `AuthorizedKeysFile`. */
export const DEFAULT_KEY_LIST = [".ssh/authorized_keys", ".ssh/authorized_keys2"];

const DEFAULT_COMMAND = "claude-rc node sshd";
const MANAGED_ENTRY = `.ssh/${MANAGED_KEY_FILE}`;
const INCLUDE_LINE = /^\s*Include\s+\S*sshd_config\.d/im;
const KEY_LIST_LINE = /^authorizedkeysfile\s+(.*)$/im;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The machine with sshd. Each method is one call to the machine. */
export interface SshdMachine {
  isRoot(): boolean;
  /**
   * `sshd -T`, or `sshd -T -C user=<account>,host=localhost,addr=127.0.0.1` for an account. Older OpenSSH needs all
   * three keys. `undefined` means no sshd binary.
   */
  sshdEffective(account?: string): Promise<CommandResult | undefined>;
  /** `sshd -t`. */
  sshdTest(): Promise<CommandResult>;
  /** `undefined` when the file does not exist. */
  readFile(path: string): Promise<string | undefined>;
  writeFile(path: string, text: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  reloadSshd(): Promise<{ ok: boolean; detail: string }>;
}

export type SshdDropinCode =
  | "not-root"
  | "no-sshd"
  | "sshd-failed"
  | "no-include"
  | "unmanaged-file"
  | "keys-off"
  | "test-failed"
  | "not-effective";

/** The drop-in work stopped. `code` tells why. */
export class SshdDropinError extends Error {
  constructor(
    readonly code: SshdDropinCode,
    message: string,
  ) {
    super(message);
    this.name = "SshdDropinError";
  }
}

export interface SshdCheck {
  /** True when the global list of sshd holds the dedicated key file. */
  reads: boolean;
  list: string[];
  dropin: "managed" | "unmanaged" | "absent";
}

export type InstallResult =
  { kind: "unchanged"; list: string[] } | { kind: "installed"; list: string[]; reloaded: boolean; note?: string };

export interface SshdDropinOptions {
  /** The command that the messages name. Default: `claude-rc node sshd`. */
  command?: string;
  dropinPath?: string;
  mainConfigPath?: string;
}

/** The `AuthorizedKeysFile` list of `sshd -T` output. Without such a line, the default list of sshd. */
export function parseKeyList(sshdT: string): string[] {
  const value = KEY_LIST_LINE.exec(sshdT)?.[1]?.trim();
  if (!value) return [...DEFAULT_KEY_LIST];
  return value.split(/\s+/);
}

/** True when the list names `~/.ssh/<keyFile>` as `.ssh/<name>`, `%h/.ssh/<name>` or, with `home`, the full path. */
export function listHolds(list: string[], keyFile: string, home?: string): boolean {
  const forms = [`.ssh/${keyFile}`, `%h/.ssh/${keyFile}`];
  if (home) forms.push(`${home.replace(/\/+$/, "")}/.ssh/${keyFile}`);
  return list.some((entry) => forms.includes(entry));
}

/** The text of the managed drop-in for the list. */
export function dropinText(list: string[]): string {
  return `${DROPIN_MARKER}\nAuthorizedKeysFile ${list.join(" ")}\n`;
}

/** Installs, checks and removes the managed sshd drop-in. */
export class SshdDropin {
  readonly command: string;
  private readonly dropinPath: string;
  private readonly mainConfigPath: string;

  constructor(
    private readonly machine: SshdMachine,
    options: SshdDropinOptions = {},
  ) {
    this.command = options.command ?? DEFAULT_COMMAND;
    this.dropinPath = options.dropinPath ?? DROPIN_PATH;
    this.mainConfigPath = options.mainConfigPath ?? MAIN_CONFIG_PATH;
  }

  /** The global list of sshd and the state of the drop-in. Needs root, because `sshd -T` reads the host keys. */
  async check(): Promise<SshdCheck> {
    this.requireRoot("check");
    const list = await this.effectiveList();
    const text = await this.machine.readFile(this.dropinPath);
    return { reads: listHolds(list, MANAGED_KEY_FILE), list, dropin: dropinState(text) };
  }

  /**
   * Makes sshd read the dedicated key file. The order matters: when sshd reads the file already, the install writes
   * nothing, so a machine that another config prepared keeps its config.
   */
  async install(): Promise<InstallResult> {
    this.requireRoot("install");
    const list = await this.effectiveList();
    if (listHolds(list, MANAGED_KEY_FILE)) return { kind: "unchanged", list };

    if (list.length === 1 && list[0] === "none") {
      throw new SshdDropinError(
        "keys-off",
        "sshd has AuthorizedKeysFile none, so it reads no key file. Nothing was changed.",
      );
    }

    const main = await this.machine.readFile(this.mainConfigPath);

    if (!main || !INCLUDE_LINE.test(main)) {
      throw new SshdDropinError(
        "no-include",
        `${this.mainConfigPath} has no Include line for sshd_config.d, so sshd would not read ${this.dropinPath}. Nothing was changed.`,
      );
    }

    const old = await this.machine.readFile(this.dropinPath);

    if (old !== undefined && dropinState(old) !== "managed") {
      throw new SshdDropinError(
        "unmanaged-file",
        `${this.dropinPath} exists and claude-rc does not manage it. Add ${MANAGED_ENTRY} to its AuthorizedKeysFile line. Nothing was changed.`,
      );
    }

    await this.machine.writeFile(this.dropinPath, dropinText([...list, MANAGED_ENTRY]));
    const test = await this.machine.sshdTest();

    if (test.code !== 0) {
      await this.undo(old);
      throw new SshdDropinError("test-failed", `sshd -t refused the drop-in, so it was undone: ${failure(test)}`);
    }

    const after = await this.machine.sshdEffective();
    const newList = after?.code === 0 ? parseKeyList(after.stdout) : undefined;

    if (!newList || !listHolds(newList, MANAGED_KEY_FILE)) {
      await this.undo(old);
      const shown = newList ? newList.join(" ") : "unknown";
      throw new SshdDropinError(
        "not-effective",
        `sshd does not use the drop-in, so it was undone. Another file sets AuthorizedKeysFile first. sshd reads: ${shown}`,
      );
    }

    const reload = await this.machine.reloadSshd();
    if (reload.ok) return { kind: "installed", list: newList, reloaded: true };

    return {
      kind: "installed",
      list: newList,
      reloaded: false,
      note: `sshd was not reloaded (${reload.detail}). A socket-activated sshd reads the file at the next connection.`,
    };
  }

  /** Removes the drop-in. Only a file with the marker is removed. */
  async remove(): Promise<"removed" | "absent"> {
    this.requireRoot("remove");
    const text = await this.machine.readFile(this.dropinPath);
    if (text === undefined) return "absent";

    if (dropinState(text) !== "managed") {
      throw new SshdDropinError(
        "unmanaged-file",
        `${this.dropinPath} exists and claude-rc does not manage it, so it was not removed.`,
      );
    }

    await this.machine.removeFile(this.dropinPath);
    const test = await this.machine.sshdTest();

    if (test.code !== 0) {
      await this.machine.writeFile(this.dropinPath, text);
      throw new SshdDropinError(
        "test-failed",
        `sshd -t failed without the drop-in, so it was put back: ${failure(test)}`,
      );
    }

    await this.machine.reloadSshd();
    return "removed";
  }

  /** True when sshd reads `~/.ssh/<keyFile>` for the account. A Match block can give the account another list. */
  async readsFor(account: string, home: string, keyFile: string): Promise<boolean> {
    const list = await this.effectiveList(account);
    return listHolds(list, keyFile, home);
  }

  private requireRoot(word: "install" | "check" | "remove"): void {
    if (!this.machine.isRoot()) {
      throw new SshdDropinError("not-root", `the sshd drop-in needs root. Run: sudo ${this.command} ${word}`);
    }
  }

  private async effectiveList(account?: string): Promise<string[]> {
    const result = await this.machine.sshdEffective(account);
    if (!result) throw new SshdDropinError("no-sshd", "sshd is not installed on this machine. Nothing was changed.");
    if (result.code !== 0) throw new SshdDropinError("sshd-failed", `sshd -T failed: ${failure(result)}`);
    return parseKeyList(result.stdout);
  }

  /** Puts back the old managed text, or removes the new file. */
  private async undo(old: string | undefined): Promise<void> {
    if (old === undefined) await this.machine.removeFile(this.dropinPath);
    else await this.machine.writeFile(this.dropinPath, old);
  }
}

function dropinState(text: string | undefined): SshdCheck["dropin"] {
  if (text === undefined) return "absent";
  return text.split("\n")[0]?.trimEnd() === DROPIN_MARKER ? "managed" : "unmanaged";
}

function failure(result: CommandResult): string {
  return result.stderr.trim() || `exit code ${result.code}`;
}

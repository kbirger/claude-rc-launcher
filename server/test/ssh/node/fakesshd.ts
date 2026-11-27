import { DROPIN_PATH, MAIN_CONFIG_PATH } from "../../../src/ssh/node/SshdDropin";
import type { CommandResult, SshdMachine } from "../../../src/ssh/node/SshdDropin";

/** The main config of a usual Debian or Ubuntu machine: it includes the drop-in folder. */
export const MAIN_WITH_INCLUDE = "Include /etc/ssh/sshd_config.d/*.conf\n\nPort 22\n";

/** The answer of `sshd -T` for the files of the fake and an account. `undefined` means no sshd binary. */
export type EffectiveAnswer = (fake: FakeSshd, account?: string) => CommandResult | undefined;

/**
 * A machine with sshd for the tests. It keeps the files in a map and records each call. It never touches the real disk.
 * By default `sshd -T` gives the `AuthorizedKeysFile` line of the drop-in when the drop-in counts, else the base list.
 */
export class FakeSshd implements SshdMachine {
  root = true;
  readonly files = new Map<string, string>([[MAIN_CONFIG_PATH, MAIN_WITH_INCLUDE]]);
  readonly calls: string[] = [];
  /** The list of `sshd -T` without the drop-in. `undefined`: sshd -T prints no AuthorizedKeysFile line. */
  baseList: string[] | undefined = undefined;
  /** False: another file sets AuthorizedKeysFile first, so the drop-in does not count. */
  dropinCounts = true;
  /** The list a Match block gives an account. */
  readonly accountLists = new Map<string, string[]>();
  effective: EffectiveAnswer = (fake, account) => fake.defaultEffective(account);
  testAnswer: CommandResult = { code: 0, stdout: "", stderr: "" };
  reloadAnswer = { ok: true, detail: "reloaded ssh" };

  isRoot(): boolean {
    this.calls.push("isRoot");
    return this.root;
  }

  sshdEffective(account?: string): Promise<CommandResult | undefined> {
    this.calls.push(account === undefined ? "sshdEffective" : `sshdEffective ${account}`);
    return Promise.resolve(this.effective(this, account));
  }

  sshdTest(): Promise<CommandResult> {
    this.calls.push("sshdTest");
    return Promise.resolve(this.testAnswer);
  }

  readFile(path: string): Promise<string | undefined> {
    this.calls.push(`readFile ${path}`);
    return Promise.resolve(this.files.get(path));
  }

  writeFile(path: string, text: string): Promise<void> {
    this.calls.push(`writeFile ${path}`);
    this.files.set(path, text);
    return Promise.resolve();
  }

  removeFile(path: string): Promise<void> {
    this.calls.push(`removeFile ${path}`);
    this.files.delete(path);
    return Promise.resolve();
  }

  reloadSshd(): Promise<{ ok: boolean; detail: string }> {
    this.calls.push("reloadSshd");
    return Promise.resolve(this.reloadAnswer);
  }

  /** The writes and removals, in order. */
  changes(): string[] {
    return this.calls.filter((call) => call.startsWith("writeFile") || call.startsWith("removeFile"));
  }

  /** The default answer of `sshd -T`. */
  defaultEffective(account?: string): CommandResult {
    const list = this.listFor(account);
    const line = list ? `authorizedkeysfile ${list.join(" ")}\n` : "";
    return { code: 0, stdout: `port 22\n${line}passwordauthentication no\n`, stderr: "" };
  }

  private listFor(account?: string): string[] | undefined {
    const matched = account === undefined ? undefined : this.accountLists.get(account);
    if (matched) return matched;
    const dropin = this.files.get(DROPIN_PATH);
    const fromDropin = dropin?.match(/^\s*AuthorizedKeysFile\s+(.+)$/im)?.[1];
    if (this.dropinCounts && fromDropin) return fromDropin.trim().split(/\s+/);
    return this.baseList;
  }
}

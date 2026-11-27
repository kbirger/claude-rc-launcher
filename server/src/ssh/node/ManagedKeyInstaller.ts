import { readFile } from "node:fs/promises";
import { HttpError } from "../../shared/HttpError";
import { MANAGED_KEY_FILE } from "../constants";
import { needsSshdCheck } from "../keyfile";
import { deprovisionScript, provisionScript } from "../provision";
import type { Script } from "../provision";
import type { SystemType } from "../TargetStore";
import { AccountQueue } from "./AccountQueue";
import { SshdDropinError } from "./SshdDropin";

// The hub asks a managed node to add or remove the key line of a target in the `authorized_keys` list of an account.
// The node runs a provisioning script as that account. The routes in `ssh/api/node.ts` check the body, call
// `ManagedKeyInstaller` and map a `ManagedKeyError` to its status.

// The hub waits 10 seconds for a removal. The script itself stops sooner. A removal that waits behind another script of
// the same account can still show `failed` and remove the line later. That is harmless, because the key is deleted already.
export const DEAUTHORIZE_TIMEOUT_MS = 8_000;

/** Runs a provisioning script as the account. `timeoutMs` is `undefined` for the default time limit of the runner. */
export type RunAs = (
  account: string,
  script: Script,
  timeoutMs?: number,
) => Promise<{ code: number; stderr: string; stdout?: string }>;

/**
 * Whether sshd reads `~/.ssh/<keyFile>` for the account. `skipped`: the node cannot ask sshd, because it is not root.
 * `match-block`: the global list holds the file, but a Match block gives the account another list. It throws when
 * sshd cannot answer.
 */
export type SshdReads = (account: string, keyFile: string) => Promise<"passed" | "skipped" | "missing" | "match-block">;

/** The sshd check of an install. `not-needed`: the install uses `authorized_keys`, or is not for a Linux target. */
export type SshdCheckResult = "passed" | "skipped" | "not-needed";

/** A rule of the managed routes refused a request, or the script failed. The routes answer with `status`. */
export class ManagedKeyError extends Error {
  constructor(
    readonly status: 400 | 404 | 500,
    message: string,
  ) {
    super(message);
    this.name = "ManagedKeyError";
  }
}

export interface ManagedKeyDeps {
  runAs: RunAs;
  /** The sshd host key file. */
  hostKeyFile: string;
  /** Asks sshd whether it reads a key file. Only an install of a Linux target into another file than `authorized_keys` asks. */
  sshdReads: SshdReads;
  /** Default: a new queue. */
  queue?: AccountQueue;
}

export interface AuthorizeInput {
  account: string;
  systemType: SystemType;
  /** A checked key line. */
  line: string;
  keyFile?: string;
}

export interface DeauthorizeInput {
  account: string;
  systemType: SystemType;
  /** The checked base64 key blob of the line to remove. */
  key: string;
  /** The id of the target: the comment of the line. */
  id: string;
  keyFile?: string;
}

/** The managed key lines of a node: the host key of its sshd, and the add and the removal of a key line. */
export class ManagedKeyInstaller {
  private readonly queue: AccountQueue;

  constructor(private readonly deps: ManagedKeyDeps) {
    this.queue = deps.queue ?? new AccountQueue();
  }

  /** The first line of the host key file as `<type> <base64>`, without the comment. 404 when it is not Ed25519. */
  async hostKey(): Promise<string> {
    let text: string;

    try {
      text = await readFile(this.deps.hostKeyFile, "utf8");
    } catch {
      throw new ManagedKeyError(404, "sshd has no ed25519 host key");
    }

    const [type, key] = (text.split("\n")[0] ?? "").trim().split(/\s+/);
    if (type !== "ssh-ed25519" || !key) throw new ManagedKeyError(404, "sshd has no ed25519 host key");
    return `${type} ${key}`;
  }

  /**
   * Adds the key line to the list of the account. An install of a Linux target into a key file other than
   * `authorized_keys` first checks that sshd reads that file. The check runs in the queue of the account, before the
   * script, so a failed check writes nothing.
   */
  async authorize(input: AuthorizeInput): Promise<SshdCheckResult> {
    const { account, systemType, line, keyFile } = input;
    const script = provisionScript(systemType, line, systemType === "windows" ? { account } : { keyFile });
    let check: SshdCheckResult = "not-needed";

    await this.run(account, script, undefined, async () => {
      if (keyFile !== undefined && needsSshdCheck(systemType, keyFile)) check = await this.checkSshd(account, keyFile);
    });
    return check;
  }

  /** Removes the key line of a target. The match is by blob and comment, because `from=` can change after the install. */
  async deauthorize(input: DeauthorizeInput): Promise<"removed" | "not-found"> {
    const { account, systemType, key, id, keyFile } = input;
    const script = deprovisionScript(systemType, key, id, systemType === "windows" ? { account } : { keyFile });
    const { stdout } = await this.run(account, script, DEAUTHORIZE_TIMEOUT_MS);
    const result = (stdout ?? "").trim();
    if (result !== "removed" && result !== "not-found") throw new ManagedKeyError(500, "the script gave no result");
    return result;
  }

  /** The check of `authorize`. sshd that does not read the file is a 400. A failed check is a 500, an `HttpError` keeps its status. */
  private async checkSshd(account: string, keyFile: string): Promise<"passed" | "skipped"> {
    let answer: Awaited<ReturnType<SshdReads>>;

    try {
      answer = await this.deps.sshdReads(account, keyFile);
    } catch (error) {
      if (error instanceof HttpError || error instanceof ManagedKeyError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      if (error instanceof SshdDropinError && error.code === "bad-account") throw new ManagedKeyError(400, detail);
      // The check runs before the script, so the key line is not written. The install words do not belong here.
      const reason = detail.replace(/\s*Nothing was changed\.\s*$/, "").replace(/\.$/, "");
      throw new ManagedKeyError(
        500,
        `cannot check that sshd reads ~/.ssh/${keyFile}: ${reason}. The key line was not written.`,
      );
    }

    // The install command changes the global list only, so it cannot help an account with a Match block.
    if (answer === "match-block") {
      throw new ManagedKeyError(
        400,
        `A Match block in the sshd configuration sets another AuthorizedKeysFile list for ${account}. The owner must add .ssh/${keyFile} to the list of that Match block on this machine.`,
      );
    }

    // The install command adds only the managed file to the list of sshd. Another file needs an edit by the owner.
    if (answer === "missing" && keyFile === MANAGED_KEY_FILE) {
      throw new ManagedKeyError(
        400,
        `sshd does not read ~/.ssh/${keyFile} for ${account}. Run on this machine: sudo claude-rc node sshd install`,
      );
    }

    if (answer === "missing") {
      throw new ManagedKeyError(
        400,
        `~/.ssh/${keyFile} is not in the AuthorizedKeysFile list of sshd for ${account}. The owner must add .ssh/${keyFile} to that list on this machine.`,
      );
    }

    return answer;
  }

  /**
   * Runs the script in the queue of the account, after `before` when it is given. A script that fails is a 400 for an
   * unknown profile, else a 500.
   */
  private async run(
    account: string,
    script: Script,
    timeoutMs: number | undefined,
    before?: () => Promise<void>,
  ): Promise<{ code: number; stderr: string; stdout?: string }> {
    const outcome = await this.queue.run(account, async () => {
      await before?.();
      return this.deps.runAs(account, script, timeoutMs);
    });
    const { code } = outcome;
    const failure = outcome.stderr.trim();
    if (code !== 0 && failure.includes("no profile for account")) throw new ManagedKeyError(400, failure);
    if (code !== 0) throw new ManagedKeyError(500, failure || `the script exited with code ${code}`);
    return outcome;
  }
}

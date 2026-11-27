import { readFile } from "node:fs/promises";
import { deprovisionScript, provisionScript } from "../provision";
import type { Script } from "../provision";
import type { SystemType } from "../TargetStore";
import { AccountQueue } from "./AccountQueue";

// The hub asks a managed node to add or remove the key line of a target in the `authorized_keys` list of an account.
// The node runs a provisioning script as that account. The routes in `sshnodeapi.ts` check the body, call
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

  /** Adds the key line to the list of the account. */
  async authorize(input: AuthorizeInput): Promise<void> {
    const { account, systemType, line, keyFile } = input;
    const script = provisionScript(systemType, line, systemType === "windows" ? { account } : { keyFile });
    await this.run(account, script, undefined);
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

  /** Runs the script in the queue of the account. A script that fails is a 400 for an unknown profile, else a 500. */
  private async run(
    account: string,
    script: Script,
    timeoutMs: number | undefined,
  ): Promise<{ code: number; stderr: string; stdout?: string }> {
    const outcome = await this.queue.run(account, () => this.deps.runAs(account, script, timeoutMs));
    const { code } = outcome;
    const failure = outcome.stderr.trim();
    if (code !== 0 && failure.includes("no profile for account")) throw new ManagedKeyError(400, failure);
    if (code !== 0) throw new ManagedKeyError(500, failure || `the script exited with code ${code}`);
    return outcome;
  }
}

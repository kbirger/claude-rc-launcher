import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Flags } from "./args";
import { ExitError } from "./creds";
import type { HubClient } from "./hub";

const SYSTEM_TYPES = ["linux", "windows", "synology", "dropbear"];
// The same rules as the hub. A value that starts with "-" would be read by ssh as an option.
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ADDRESS_RE = /^[A-Za-z0-9_.:][A-Za-z0-9._:-]{0,254}$/;
const ACCOUNT_RE = /^[A-Za-z0-9_.][^\s"',\\]{0,127}$/;
const DEFAULT_PORT = 22;
const POLL_MS = 2000;
const POLL_LIMIT_MS = 10 * 60 * 1000;
const BASE = "/cli/api/ssh";

export const SSH_TARGET_USAGE =
  "usage: claude-rc ssh target add <id> --type <type> --account <user> --node <ids> (--address <host> --identity <file> | --managed <host id>) [--port <n>] [--fingerprint <f>] [--no-test]";

interface Unlock {
  method: "prf" | "passphrase";
  secret: string;
}

interface TargetView {
  state?: string;
  hostKey?: string;
  keyFingerprint?: string;
}

interface HostKeyLine {
  line: string;
  fingerprint: string;
}

export interface SshTargetAddOptions {
  id: string;
  flags: Flags;
  hub: HubClient;
  /** The address of the hub, for the link to the web UI. */
  hubUrl: string;
  readLine: (prompt: string) => Promise<string>;
  /** Asks for a secret and does not show what is typed. */
  readSecret: (prompt: string) => Promise<string>;
  /** Runs a program on this machine with `stdin` as its input. */
  runLocal: (argv: string[], stdin: string) => Promise<{ code: number; stderr: string }>;
  out: (line: string) => void;
  /** Waits between polls. Tests replace it so that they do not wait in real time. */
  sleep?: (ms: number) => Promise<void>;
}

const usage = (reason?: string) => new ExitError(reason ? `${SSH_TARGET_USAGE}\n${reason}` : SSH_TARGET_USAGE, 1);

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Adds an SSH target from the command line, with the steps of the web wizard: create the draft target, make its key,
 * pin the host key, install the key and run the test grant. The private key of `--identity` stays on this machine: only
 * `ssh` reads it, and its path never goes to the hub. A step that fails stops the command with exit code 1. The hub
 * keeps the draft target.
 */
export async function sshTargetAdd(options: SshTargetAddOptions): Promise<void> {
  const { id, flags, hub, out } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const isManaged = flags.managed !== undefined;
  const type = flags.type;
  const account = flags.account;
  const address = flags.address;
  const identity = flags.identity;
  const sshAddress = address ?? "";
  // An absolute path cannot start with a dash, so ssh never reads it as an option.
  const keyFile = identity ? path.resolve(identity) : "";

  if (isManaged && identity !== undefined) throw usage("--managed does not take --identity");
  if (identity === "") throw usage("--identity is empty");
  if (!ID_RE.test(id)) throw usage("the target id is not valid");
  if (type === undefined || account === undefined || flags.node === undefined) throw usage();
  if (!isManaged && (address === undefined || identity === undefined)) throw usage();
  if (!SYSTEM_TYPES.includes(type)) throw usage(`--type must be one of ${SYSTEM_TYPES.join(", ")}`);
  if (!ACCOUNT_RE.test(account)) throw usage("--account is not valid");
  if (address !== undefined && !ADDRESS_RE.test(address)) throw usage("--address is not valid");
  if (flags.managed !== undefined && !ID_RE.test(flags.managed)) throw usage("--managed is not a host id");
  const nodes = flags.node.split(",");
  if (nodes.length === 0 || !nodes.every((node) => ID_RE.test(node))) throw usage("--node must list host ids");
  const port = flags.port === undefined ? DEFAULT_PORT : Number(flags.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw usage("--port must be a number from 1 to 65535");
  const node = nodes[0] ?? "";
  const target = `${BASE}/targets/${encodeURIComponent(id)}`;
  const link = `${options.hubUrl.replace(/\/+$/, "")}/ssh?target=${encodeURIComponent(id)}`;
  let created = false;

  /** Runs one step. A failure names the step and says that the target stays a draft. */
  const step = async <Value>(name: string, action: () => Promise<Value>): Promise<Value> => {
    try {
      return await action();
    } catch (error) {
      const stay = created ? `. The target ${id} stays in draft on the hub` : "";
      throw new ExitError(`${name} failed: ${messageOf(error)}${stay}`, 1);
    }
  };

  /** Polls the target until `done` holds. It stops after 10 minutes. */
  const waitFor = async (what: string, done: (view: TargetView) => boolean): Promise<TargetView> => {
    for (let waited = 0; waited <= POLL_LIMIT_MS; waited += POLL_MS) {
      const view = await hub.request<TargetView>("GET", target);
      if (done(view)) return view;
      await sleep(POLL_MS);
    }

    throw new Error(`${what} did not happen in 10 minutes`);
  };

  const status = await step("reading the SSH status", () =>
    hub.request<{ setUp?: boolean; method?: "prf" | "passphrase" }>("GET", `${BASE}/status`),
  );
  if (!status.setUp || !status.method) throw new ExitError("SSH access is not set up on the hub", 1);
  const method = status.method;

  await step("creating the target", () =>
    hub.request("POST", `${BASE}/targets`, {
      id,
      systemType: type,
      account,
      nodes,
      ...(address !== undefined ? { address } : {}),
      ...(flags.port !== undefined || !isManaged ? { port } : {}),
      ...(flags.managed !== undefined ? { managedHost: flags.managed } : {}),
    }),
  );
  created = true;
  out(`target ${id} created`);

  // The key.
  let unlock: Unlock | undefined;

  if (method === "passphrase") {
    const typed = await step("reading the passphrase", () => options.readSecret("Passphrase for the SSH keys: "));
    if (!typed)
      throw new ExitError(
        `reading the passphrase failed: no passphrase. The target ${id} stays in draft on the hub`,
        1,
      );
    unlock = { method, secret: Buffer.from(typed, "utf8").toString("base64url") };
    const secret = unlock;
    const made = await step("creating the key", () =>
      hub.request<{ fingerprint: string }>("POST", `${target}/key`, { unlock: secret }),
    );
    out(`key created (${made.fingerprint})`);
  } else {
    out(`open ${link} to unlock with your passkey`);
    const view = await step("waiting for the key", () => waitFor("the key", (item) => !!item.keyFingerprint));
    out(`key created (${view.keyFingerprint ?? ""})`);
  }

  // The host key.
  let hostKey: string;

  if (isManaged) {
    const found = await step("pinning the host key", () =>
      hub.request<{ keys: HostKeyLine[] }>("POST", `${target}/pin-managed`),
    );
    hostKey = found.keys[0]?.line ?? "";
    out("host key pinned");
  } else {
    const scanned = await step("scanning the host key", () =>
      hub.request<{ keys: HostKeyLine[] }>("POST", `${target}/scan`, { node }),
    );
    if (scanned.keys.length === 0)
      throw new ExitError(`scanning the host key failed: no key found. The target ${id} stays in draft on the hub`, 1);
    let chosen: HostKeyLine;

    if (flags.fingerprint !== undefined) {
      const wanted = scanned.keys.find((item) => item.fingerprint === flags.fingerprint);
      if (!wanted)
        throw new ExitError(
          `the host key does not match --fingerprint. Scanned: ${scanned.keys.map((item) => item.fingerprint).join(", ")}. Nothing was pinned. The target ${id} stays in draft on the hub`,
          1,
        );
      chosen = wanted;
    } else {
      chosen = scanned.keys.find((item) => item.line.startsWith("ssh-ed25519 ")) ?? scanned.keys[0];
      for (const item of scanned.keys) out(`host key ${item.fingerprint}`);
      const answer = (await options.readLine("Do they match the target? [y/N] ")).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes")
        throw new ExitError(
          `the host key was not confirmed. Nothing was pinned. The target ${id} stays in draft on the hub`,
          1,
        );
    }

    hostKey = chosen.line;
    await step("pinning the host key", () => hub.request("POST", `${target}/pin`, { hostKey }));
    out("host key pinned");
  }

  // The install.
  if (isManaged) {
    await step("installing the key", () => hub.request("POST", `${target}/authorize`));
  } else {
    await step("installing the key", () => installWithSsh());
  }

  out("key installed");

  async function installWithSsh(): Promise<void> {
    const pinned = (await hub.request<TargetView>("GET", target)).hostKey ?? hostKey;
    const script = await hub.request<{ shell: "sh" | "powershell"; script: string }>("GET", `${target}/provision`);
    const command = script.shell === "powershell" ? "powershell -NoProfile -NonInteractive -Command -" : "sh -s";
    const folder = mkdtempSync(path.join(os.tmpdir(), "claude-rc-ssh-"));

    try {
      const knownHosts = path.join(folder, "known_hosts");
      const name = port === DEFAULT_PORT ? sshAddress : `[${sshAddress}]:${port}`;
      writeFileSync(knownHosts, `${name} ${pinned}\n`, { mode: 0o600 });
      chmodSync(knownHosts, 0o600);
      const result = await options.runLocal(
        [
          "ssh",
          "-i",
          keyFile,
          "-o",
          "IdentitiesOnly=yes",
          "-o",
          `UserKnownHostsFile=${knownHosts}`,
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          "GlobalKnownHostsFile=/dev/null",
          "-p",
          String(port),
          "--",
          `${account}@${sshAddress}`,
          command,
        ],
        script.script,
      );

      if (result.code !== 0) {
        // The text of ssh may name the identity file. The path stays on this machine, so it is not shown.
        const text = result.stderr.replaceAll(keyFile, "<identity>").trim();
        throw new Error(`ssh exited with code ${result.code}${text ? `: ${text}` : ""}`);
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }

  // The test.
  if (flags["no-test"]) return;

  if (method === "passphrase") {
    // Every grant needs a new unlock, and the test grant is a grant.
    const typed = await step("reading the passphrase", () => options.readSecret("Passphrase for the SSH keys: "));
    if (!typed)
      throw new ExitError(
        `reading the passphrase failed: no passphrase. The target ${id} stays in draft on the hub`,
        1,
      );
    const secret: Unlock = { method, secret: Buffer.from(typed, "utf8").toString("base64url") };
    const result = await step("testing the target", () =>
      hub.request<{ ok: boolean; error?: string }>("POST", `${target}/test`, { node, unlock: secret }),
    );
    if (!result.ok)
      throw new ExitError(
        `testing the target failed: ${result.error ?? "the test did not pass"}. The target ${id} stays in draft on the hub`,
        1,
      );
  } else {
    out(`open ${link} to run the test with your passkey`);
    await step("waiting for the test", () => waitFor("the test", (item) => item.state === "ready"));
  }

  out(`test passed: ${id} is ready`);
}

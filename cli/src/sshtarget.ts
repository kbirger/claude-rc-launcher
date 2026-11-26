import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOST_ID_RE } from "../../server/src/hostid";
import { keyFingerprint } from "../../server/src/sshagentproto";
import {
  CONFIRM_NODES_SUFFIX,
  HAS_PROVISIONER_KEY_TEXT,
  NO_PROVISIONER_KEY_TEXT,
  parseAnswer,
} from "../../server/src/sshprovisioner";
import { keyFileProblem } from "../../server/src/sshtargets";
import type { Flags } from "./args";
import { ExitError } from "./creds";
import { HubError } from "./hub";
import type { HubClient } from "./hub";
import { isObject } from "./json";
import { approveMaintenance, asGrant } from "./sshmaintenance";

const SYSTEM_TYPES = ["linux", "windows", "synology", "dropbear"];
// The same rules as the hub. A value that starts with "-" would be read by ssh as an option.
const ADDRESS_RE = /^[A-Za-z0-9_.:][A-Za-z0-9._:-]{0,254}$/;
const ACCOUNT_RE = /^[A-Za-z0-9_.][^\s"',\\]{0,127}$/;
const DEFAULT_PORT = 22;
const POLL_MS = 2000;
const POLL_LIMIT_MS = 10 * 60 * 1000;
const BASE = "/cli/api/ssh";

export const SSH_TARGET_USAGE =
  "usage: claude-rc ssh target add <id> --type <type> --account <user> --node <ids> (--address <host> --identity <file> | --managed <host id>) [--port <n>] [--key-file <name>] [--fingerprint <f>] [--provisioner] [--no-test]\n--managed local needs --address: the LAN address of this machine as the other nodes see it\n--provisioner (an external linux, synology or dropbear target) also installs the provisioner key, so that the hub changes the node list later with one approval. On a dropbear target (Asuswrt-Merlin) the key list is in nvram and the script in /jffs/scripts";

export const SSH_TARGET_UPDATE_USAGE =
  "usage: claude-rc ssh target update <id> --node <id>[,<id>...] [--yes]\n--yes confirms a new list that allows none of the addresses that work now";

export const SSH_TARGET_PROVISIONER_USAGE =
  "usage: claude-rc ssh target provisioner <id> --identity <file> [--fingerprint <f>] [--no-test]\nInstalls the provisioner key on an external linux, synology or dropbear target, or installs it again (also after the source address of the node local changed). If the hub holds a provisioner key already and the unlock method is a passkey, the command uses that key (the repair path). With a passphrase it replaces the key";

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
  runLocal: (argv: string[], stdin: string) => Promise<{ code: number; stderr: string; stdout?: string }>;
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
  if (!HOST_ID_RE.test(id)) throw usage("the target id is not valid");
  if (type === undefined || account === undefined || flags.node === undefined) throw usage();
  if (!isManaged && (address === undefined || identity === undefined)) throw usage();
  if (!SYSTEM_TYPES.includes(type)) throw usage(`--type must be one of ${SYSTEM_TYPES.join(", ")}`);
  if (!ACCOUNT_RE.test(account)) throw usage("--account is not valid");
  if (address !== undefined && !ADDRESS_RE.test(address)) throw usage("--address is not valid");
  if (flags.managed !== undefined && !HOST_ID_RE.test(flags.managed)) throw usage("--managed is not a host id");
  const keyFileName = flags["key-file"];

  if (keyFileName !== undefined) {
    // The same rule as the hub: a managed linux or synology target, and a name that starts with authorized_keys.
    const bad = keyFileProblem(keyFileName, type, isManaged);
    if (bad) throw usage(`--key-file: ${bad}`);
  }

  if (flags.provisioner) {
    if (isManaged) throw usage("--provisioner does not work with --managed: a managed node keeps its own key file");
    if (type === "windows") throw usage("--provisioner does not work with a windows target: the script needs sh");
  }

  const nodes = flags.node.split(",");
  if (nodes.length === 0 || !nodes.every((node) => HOST_ID_RE.test(node))) throw usage("--node must list host ids");
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
      ...(keyFileName !== undefined ? { keyFile: keyFileName } : {}),
    }),
  );
  created = true;
  out(`target ${id} created`);

  // The key.
  if (method === "passphrase") {
    const typed = await step("reading the passphrase", () => options.readSecret("Passphrase for the SSH keys: "));
    if (!typed)
      throw new ExitError(
        `reading the passphrase failed: no passphrase. The target ${id} stays in draft on the hub`,
        1,
      );
    const secret: Unlock = { method, secret: Buffer.from(typed, "utf8").toString("base64url") };
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
    const script = await hub.request<Script>("GET", `${target}/provision`);
    const result = await runSsh(options, {
      keyFile,
      address: sshAddress,
      account: account ?? "",
      port,
      pinned,
      script,
    });
    if (result.code !== 0) throw new Error(sshFailure(result, keyFile));
  }

  const proof = { id, hub, hubUrl: options.hubUrl, method, readSecret: options.readSecret, out, sleep };
  const setUp = {
    ...proof,
    options,
    keyFile,
    link,
    step: step,
    isAdd: true,
  };
  if (flags.provisioner) await setUpProvisioner(setUp, { address: sshAddress, account, port, hostKey });

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
  if (flags.provisioner) await proveProvisioner(proof);
}

type StepRunner = <Value>(name: string, action: () => Promise<Value>) => Promise<Value>;

interface Script {
  shell: "sh" | "powershell";
  script: string;
}

/** The text of a failed ssh run. The text of ssh can name the identity file: the path stays on this machine. */
function sshFailure(result: { code: number; stderr: string }, keyFile: string): string {
  const text = result.stderr.replaceAll(keyFile, "<identity>").trim();
  return `ssh exited with code ${result.code}${text ? `: ${text}` : ""}`;
}

/**
 * Runs a script on the target through ssh with the identity of the owner and the pinned host key. The known hosts file
 * is a temporary file with mode 600 that goes away after the run.
 */
async function runSsh(
  options: Pick<SshTargetAddOptions, "runLocal">,
  run: { keyFile: string; address: string; account: string; port: number; pinned: string; script: Script },
): Promise<{ code: number; stderr: string; stdout?: string }> {
  const command = run.script.shell === "powershell" ? "powershell -NoProfile -NonInteractive -Command -" : "sh -s";
  const folder = mkdtempSync(path.join(os.tmpdir(), "claude-rc-ssh-"));

  try {
    const knownHosts = path.join(folder, "known_hosts");
    const name = run.port === DEFAULT_PORT ? run.address : `[${run.address}]:${run.port}`;
    writeFileSync(knownHosts, `${name} ${run.pinned}\n`, { mode: 0o600 });
    chmodSync(knownHosts, 0o600);
    return await options.runLocal(
      [
        "ssh",
        "-i",
        run.keyFile,
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        `UserKnownHostsFile=${knownHosts}`,
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "GlobalKnownHostsFile=/dev/null",
        "-p",
        String(run.port),
        "--",
        `${run.account}@${run.address}`,
        command,
      ],
      run.script.script,
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

interface ProofContext {
  id: string;
  hub: HubClient;
  hubUrl: string;
  method: "prf" | "passphrase";
  readSecret: (prompt: string) => Promise<string>;
  out: (line: string) => void;
  sleep: ((ms: number) => Promise<void>) | undefined;
}

interface SetUpContext extends ProofContext {
  options: Pick<SshTargetAddOptions, "runLocal">;
  keyFile: string;
  /** The link to the page of the target on the hub. */
  link: string;
  step: StepRunner;
  /** True in `add`: a failure there also means that the test did not run. */
  isAdd: boolean;
}

const unlockOf = (typed: string): Unlock => ({
  method: "passphrase",
  secret: Buffer.from(typed, "utf8").toString("base64url"),
});

/**
 * The provisioner key and its install on the target, with the key of the owner. The key comes first: with a passphrase
 * the hub makes it here, with a passkey the owner makes it on the web page and this command waits for it. A key that
 * exists already is replaced (a passphrase) or used (a passkey: the repair path, kept on purpose, because a passkey
 * cannot make a second key here without the browser). The install script comes from the hub. Its answer
 * holds the path of the script, which goes back to the hub. The key of the owner never goes to the hub.
 */
async function setUpProvisioner(
  ctx: SetUpContext,
  where: { address: string; account: string; port: number; hostKey: string },
): Promise<void> {
  const { id, hub, out, step } = ctx;
  const target = `${BASE}/targets/${encodeURIComponent(id)}`;
  const repair = `run: claude-rc ssh target provisioner ${id} --identity <file>`;
  const later = ctx.isAdd
    ? `. The test did not run: run it from the web page, or add the target again. To install the provisioner again, ${repair}`
    : `. To install the provisioner again, ${repair}`;

  /** A step after the key exists: a failure here leaves a part-way state, so the text names the repair. */
  const guarded: StepRunner = async (name, action) => {
    try {
      return await step(name, action);
    } catch (error) {
      throw new ExitError(`${messageOf(error)}${later}`, 1);
    }
  };

  let script: Script | undefined;

  if (ctx.method === "passphrase") {
    const typed = await step("reading the passphrase", () => ctx.readSecret("Passphrase for the SSH keys: "));
    if (!typed) throw new ExitError("reading the passphrase failed: no passphrase", 1);
    const made = await step("creating the provisioner key", async () => {
      const body = { unlock: unlockOf(typed) };

      try {
        return await hub.request<{ fingerprint: string }>("POST", `${target}/provisioner-key`, body);
      } catch (error) {
        // The hub checks the passphrase before it answers 409, so a 409 here means that the passphrase is right.
        if (!(error instanceof HubError) || error.status !== 409 || error.message !== HAS_PROVISIONER_KEY_TEXT)
          throw error;
        out("the target has a provisioner key already: it is replaced");
        await hub.request("DELETE", `${target}/provisioner-key`);

        try {
          return await hub.request<{ fingerprint: string }>("POST", `${target}/provisioner-key`, body);
        } catch (again) {
          throw new Error(
            `${messageOf(again)}. The old provisioner key was removed from the hub and no new key was made. To make one, ${repair}`,
          );
        }
      }
    });
    out(`provisioner key created (${made.fingerprint})`);
  } else {
    // The route of the install script answers 409 until the key exists.
    let first = true;
    script = await step("waiting for the provisioner key", async () => {
      for (let waited = 0; waited <= POLL_LIMIT_MS; waited += POLL_MS) {
        try {
          const found = await hub.request<Script>("GET", `${target}/provisioner-install`);
          if (first) out("the hub holds a provisioner key already: it is used");
          return found;
        } catch (error) {
          if (!(error instanceof HubError) || error.status !== 409 || error.message !== NO_PROVISIONER_KEY_TEXT)
            throw error;
        }

        if (first) out(`open ${ctx.link}&provisioner=1 to make the provisioner key with your passkey`);
        first = false;
        await (ctx.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(POLL_MS);
      }

      throw new Error("the provisioner key was not made in 10 minutes");
    });
    out("provisioner key created");
  }

  const toRun =
    script ??
    (await guarded("reading the install script", () => hub.request<Script>("GET", `${target}/provisioner-install`)));
  const installed = await guarded("installing the provisioner", async () => {
    const pinned = (await hub.request<TargetView>("GET", target)).hostKey ?? where.hostKey;
    const result = await runSsh(ctx.options, { keyFile: ctx.keyFile, ...where, pinned, script: toRun });
    if (result.code !== 0) throw new Error(sshFailure(result, ctx.keyFile));
    const answer = parseAnswer(result.stdout ?? "");
    if (answer?.kind !== "installed") throw new Error("the install script gave no valid answer");
    // The router version adds lines with what it found (counts and the Dropbear version, no key), for the manual check.
    const info = (result.stdout ?? "")
      .split("\n")
      .slice(1)
      .filter((line) => line.startsWith("info "))
      .map((line) => line.slice("info ".length));
    return { path: answer.path, info };
  });
  await guarded("storing the provisioner", () =>
    hub.request("POST", `${target}/provisioner-installed`, { script: installed.path }),
  );
  for (const line of installed.info) out(line);
  out(`provisioner installed: ${installed.path}`);
}

/** Proves the chain: the hub runs the maintenance install through the provisioner key, with one approval. */
async function proveProvisioner(ctx: ProofContext): Promise<void> {
  const target = `${BASE}/targets/${encodeURIComponent(ctx.id)}`;
  const repair = `The provisioner is installed. To try the proof again after the request ends, run: claude-rc ssh target provisioner ${ctx.id} --identity <file>`;

  try {
    const reply = await ctx.hub.request<unknown>("POST", `${target}/reinstall`);
    const grant = isObject(reply) ? asGrant(reply.maintenance) : undefined;
    if (!grant) throw new Error("the hub gave no maintenance grant");
    await approveMaintenance(grant, ctx);
  } catch (error) {
    throw new ExitError(`testing the provisioner failed: ${messageOf(error)}. ${repair}`, 1);
  }

  ctx.out(`provisioner works: ${ctx.id} can change its node list with one approval`);
}

/**
 * `claude-rc ssh target provisioner <id> --identity <file>`: installs the provisioner key on an external target that
 * exists, or installs it again. The target needs a pinned host key. The key of the owner stays on this machine.
 */
export async function sshTargetProvisioner(options: SshTargetAddOptions): Promise<void> {
  const { id, flags, hub, out } = options;
  const sleep = options.sleep;
  const fail = (reason: string) => new ExitError(`${SSH_TARGET_PROVISIONER_USAGE}\n${reason}`, 1);
  if (!HOST_ID_RE.test(id)) throw fail("the target id is not valid");
  for (const name of ["type", "address", "account", "node", "managed", "key-file", "port", "provisioner"] as const)
    if (flags[name] !== undefined) throw fail(`--${name} is not used by this command`);
  if (flags.identity === undefined || flags.identity === "") throw new ExitError(SSH_TARGET_PROVISIONER_USAGE, 1);
  const keyFile = path.resolve(flags.identity);
  const target = `${BASE}/targets/${encodeURIComponent(id)}`;

  const step: StepRunner = async (name, action) => {
    try {
      return await action();
    } catch (error) {
      throw new ExitError(`${name} failed: ${messageOf(error)}`, 1);
    }
  };

  const status = await step("reading the SSH status", () =>
    hub.request<{ setUp?: boolean; method?: "prf" | "passphrase" }>("GET", `${BASE}/status`),
  );
  if (!status.setUp || !status.method) throw new ExitError("SSH access is not set up on the hub", 1);
  const view = await step("reading the target", () =>
    hub.request<
      TargetView & { address?: string; account?: string; port?: number; systemType?: string; managedHost?: string }
    >("GET", target),
  );

  if (view.managedHost !== undefined) throw new ExitError("a managed target has no provisioner key", 1);
  if (view.systemType === "windows")
    throw new ExitError("a windows target has no provisioner key: the script needs sh", 1);
  if (!view.keyFingerprint)
    throw new ExitError(`the target ${id} has no key yet: finish its add first (make and install the key)`, 1);
  if (!view.hostKey)
    throw new ExitError(
      `the target ${id} has no pinned host key: pin its host key first (add the target again, or use the web page)`,
      1,
    );
  const { address, account } = view;
  const port = view.port ?? DEFAULT_PORT;
  if (address === undefined || !ADDRESS_RE.test(address) || account === undefined || !ACCOUNT_RE.test(account))
    throw new ExitError("the hub gave no valid address and account for the target", 1);

  if (flags.fingerprint !== undefined) {
    const blob = view.hostKey.split(" ")[1] ?? "";
    const actual = keyFingerprint(new Uint8Array(Buffer.from(blob, "base64")));
    if (actual !== flags.fingerprint)
      throw new ExitError(
        `the pinned host key does not match --fingerprint (it is ${actual}). Nothing was installed`,
        1,
      );
  }

  const proof = { id, hub, hubUrl: options.hubUrl, method: status.method, readSecret: options.readSecret, out, sleep };
  const link = `${options.hubUrl.replace(/\/+$/, "")}/ssh?target=${encodeURIComponent(id)}`;
  await setUpProvisioner(
    { ...proof, options, keyFile, link, step, isAdd: false },
    { address, account, port, hostKey: view.hostKey },
  );
  if (flags["no-test"]) return;
  await proveProvisioner(proof);
}

export interface SshTargetUpdateOptions {
  id: string;
  flags: Flags;
  hub: HubClient;
  /** The address of the hub, for the link to the web UI. */
  hubUrl: string;
  /** Asks for a secret and does not show what is typed. */
  readSecret: (prompt: string) => Promise<string>;
  out: (line: string) => void;
  /** Waits between polls. Tests replace it so that they do not wait in real time. */
  sleep?: (ms: number) => Promise<void>;
}

interface UpdatedTarget {
  nodes?: string[];
  managedHost?: string;
  installLine?: string;
  lineUpdated?: boolean;
  pushed?: boolean;
  systemType?: string;
  keyFingerprint?: string;
}

/** A Dropbear line has no address limit, so a change of the nodes does not change it. */
const ROUTER_SAME_LINE = "the key line on the router stays the same, because Dropbear does not limit a key by address";

const updateUsage = (reason: string) => new ExitError(`${SSH_TARGET_UPDATE_USAGE}\n${reason}`, 1);

/**
 * `claude-rc ssh target update <id> --node <ids> [--yes]`: replaces the list of nodes of a target. The hub answers in
 * one of two shapes. For a target with a provisioner it answers 202 with a maintenance grant: nothing has changed yet,
 * the owner approves the grant, and the hub then changes the key line on the machine and stores the list. This command
 * waits for that approve (a passphrase typed here, or a passkey on the web page) and prints the result. For every other
 * target the answer is the target: an external target gets the new key line to install by hand, and for a managed
 * target the hub has changed the line already. `--yes` confirms a list that allows none of the addresses that work now.
 */
export async function sshTargetUpdate(options: SshTargetUpdateOptions): Promise<void> {
  const { id, flags, hub, out } = options;
  if (!HOST_ID_RE.test(id)) throw updateUsage("the target id is not valid");
  if (flags.node === undefined) throw new ExitError(SSH_TARGET_UPDATE_USAGE, 1);
  const nodes = flags.node.split(",");
  if (!nodes.every((node) => HOST_ID_RE.test(node))) throw updateUsage("--node must list host ids");
  const repeated = nodes.find((node, index) => nodes.indexOf(node) !== index);
  if (repeated !== undefined) throw updateUsage(`the node id "${repeated}" is named more than once in --node`);

  // The unlock method is read before the change, so a failure there leaves nothing waiting on the hub. Only a 202 needs it.
  let method: "prf" | "passphrase" | undefined;

  try {
    const status = await hub.request<{ method?: "prf" | "passphrase" }>("GET", `${BASE}/status`);
    method = status.method === "prf" || status.method === "passphrase" ? status.method : undefined;
  } catch (error) {
    throw new ExitError(`reading the SSH status failed: ${messageOf(error)}`, 1);
  }

  let reply: unknown;

  try {
    reply = await hub.request<unknown>("PATCH", `${BASE}/targets/${encodeURIComponent(id)}`, {
      nodes,
      ...(flags.yes ? { confirm: true } : {}),
    });
  } catch (error) {
    if (error instanceof HubError && error.status === 409 && error.message.endsWith(CONFIRM_NODES_SUFFIX))
      throw new ExitError(
        `updating the target failed: ${error.message.slice(0, -CONFIRM_NODES_SUFFIX.length)}. Nothing was changed. To go on, run the command again with --yes`,
        1,
      );
    throw new ExitError(`updating the target failed: ${messageOf(error)}`, 1);
  }

  const grant = isObject(reply) ? asGrant(reply.maintenance) : undefined;

  if (grant) {
    out(`target ${id}: the change waits for the approval of the owner. Nothing has changed yet`);

    try {
      if (method === undefined) throw new Error("SSH access is not set up");
      const done = await approveMaintenance(grant, {
        hub,
        hubUrl: options.hubUrl,
        method,
        readSecret: options.readSecret,
        out,
        ...(options.sleep ? { sleep: options.sleep } : {}),
      });
      out(`target ${id} nodes: ${(done.target?.nodes ?? done.maintenance?.toNodes ?? nodes).join(", ")}`);
      // A polled grant (passkey) carries no target: read the system type from the hub.
      const systemType =
        done.target?.systemType ??
        (await hub
          .request<{ systemType?: string }>("GET", `${BASE}/targets/${encodeURIComponent(id)}`)
          .then((view) => view.systemType)
          .catch(() => undefined));
      out(systemType === "dropbear" ? ROUTER_SAME_LINE : "the key line on the machine was updated");
      if (done.pushed === false)
        out("some nodes could not be told about the change. They get it when they connect again");
    } catch (error) {
      throw new ExitError(`updating the target failed: ${messageOf(error)}`, 1);
    }

    return;
  }

  const updated = (isObject(reply) ? reply : {}) as UpdatedTarget;
  out(`target ${id} nodes: ${(updated.nodes ?? nodes).join(", ")}`);
  if (updated.pushed === false)
    out("some nodes could not be told about the change. They get it when they connect again");

  if (updated.installLine !== undefined) {
    out("The key line of the target changed. On the target machine, replace the old line that ends with");
    out(`claude-rc:${id} with this line:`);
    out(updated.installLine);
  } else if (updated.lineUpdated === true) out("the key line on the machine was updated");
  else if (updated.systemType === "dropbear" && updated.keyFingerprint !== undefined) out(ROUTER_SAME_LINE);
  else if (updated.managedHost !== undefined) out("the target has no key yet, so it has no key line on the machine");
}

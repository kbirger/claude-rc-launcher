import { X509Certificate } from "node:crypto";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import UNIT_TEXT from "../../deploy/claude-rc-launcher.service" with { type: "text" };
import type { Flags } from "./args";
import { ExitError } from "./creds";
import type { HubClient } from "./hub";
import { HOST_ID_RE } from "../../server/src/hostid";
import { downloadAsset, installWithBackup, restorePrevious, ReleaseError, sha256, type ReleaseIo } from "../../server/src/release";
import { nodeFlags, renderNodeConfig, urlHost, requireHubKeys } from "./nodecmd";

/** The same file as `deploy/claude-rc-launcher.service`, compiled into the CLI. */
export const UNIT: string = UNIT_TEXT;

const NAME = "claude-rc-launcher";
const BIN = `/usr/local/bin/${NAME}`;
const CONFIG_DIR = "/etc/claude-rc-launcher";
const CONFIG = `${CONFIG_DIR}/config.toml`;
const UNIT_PATH = `/etc/systemd/system/${NAME}.service`;
const STATE_DIR = "/var/lib/claude-rc-launcher";
const CERT = `${STATE_DIR}/node-cert.pem`;
const HEALTH_WAIT_MS = 30_000;
const STAY_ACTIVE_MS = 2_000;

type Result = { code: number; stdout: string; stderr: string };

/** Everything that touches the machine, so that tests can run the whole flow without root or systemd. */
export interface Sys {
  platform: string;
  arch: string;
  /** The path of the running executable. */
  execPath?: string;
  isRoot(): boolean;
  hasCommand(name: string): boolean;
  localAddresses(): string[];
  exists(path: string): boolean;
  /** Whether the current user can create and replace files in this directory. */
  writable?(dir: string): boolean;
  /** Runs a command without sudo. A command that runs longer than `timeoutMs` is killed and counts as a failure. */
  run(args: string[], opts?: { timeoutMs?: number }): { code: number; stdout: string; stderr?: string };
  /** Runs a command with sudo (without it, for root). Input goes to stdin. */
  sudo(args: string[], input?: string | Uint8Array): Result;
  readFile(path: string): Uint8Array;
  writeTemp(name: string, data: Uint8Array): string;
  removeTemp(path: string): void;
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export const realSys: Sys = {
  platform: process.platform,
  arch: process.arch,
  execPath: process.execPath,
  isRoot: () => process.getuid?.() === 0,
  hasCommand: (n) => Bun.which(n) !== null,
  localAddresses: () => Object.values(os.networkInterfaces()).flatMap((l) => (l ?? []).map((a) => a.address)),
  exists: (p) => existsSync(p),
  writable(dir) {
    try {
      accessSync(dir, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
  run(args, opts) {
    const r = spawnSync(args[0]!, args.slice(1), { encoding: "utf8", ...(opts?.timeoutMs ? { timeout: opts.timeoutMs, killSignal: "SIGKILL" as const } : {}) });
    return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.error ? r.error.message : (r.stderr ?? "") };
  },
  sudo(args, input) {
    const argv = process.getuid?.() === 0 ? args : ["sudo", ...args];
    const r = spawnSync(argv[0]!, argv.slice(1), {
      ...(input !== undefined ? { input } : {}),
      encoding: "utf8",
      stdio: [input !== undefined ? "pipe" : "inherit", "pipe", "inherit"],
    });
    if (r.error) return { code: 127, stdout: "", stderr: r.error.message };
    return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: "" };
  },
  readFile: (p) => readFileSync(p),
  writeTemp(name, data) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "claude-rc-setup-"));
    const file = path.join(dir, name);
    writeFileSync(file, data, { mode: 0o600 });
    return file;
  },
  removeTemp(p) {
    const dir = path.dirname(p);
    if (path.basename(dir).startsWith("claude-rc-setup-")) rmSync(dir, { recursive: true, force: true });
  },
  fetch: globalThis.fetch,
  sleep: (ms) => Bun.sleep(ms),
  now: () => Date.now(),
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
export { sha256 };

/** The release code's view of `Sys`: every command runs through sudo. */
const sudoIo = (sys: Sys): ReleaseIo => ({
  fetch: sys.fetch,
  run: (args) => {
    const r = sys.sudo(args);
    return { code: r.code, stdout: r.stdout, stderr: r.stderr };
  },
  writeTemp: sys.writeTemp,
  removeTemp: sys.removeTemp,
});

export const releaseCpu = (sys: Sys) => (sys.arch === "x64" ? "x64" : sys.arch === "arm64" ? "arm64" : undefined);

/**
 * The binary for `node setup`, `node update` and `update`: the `--binary` file, or the release asset (for example
 * `claude-rc-linux-x64`) after its SHA256SUMS check.
 */
export async function obtainBinary(sys: Sys, flags: Flags, asset: string, out: (s: string) => void): Promise<Uint8Array> {
  if (flags.binary) return sys.readFile(flags.binary);
  out(`downloading ${asset} (${flags.release ?? "latest release"})`);
  try {
    return await downloadAsset(sys, asset, flags.release);
  } catch (e) {
    if (e instanceof ReleaseError) throw new ExitError(e.message, 1);
    throw e;
  }
}

/**
 * `claude-rc node setup`: installs this machine as a node and registers it with the hub. Nothing on the machine
 * changes until the checks, the hub's answer and the download have all succeeded.
 */
export async function nodeSetup(o: { flags: Flags; hubUrl: string; hub: HubClient; out: (s: string) => void; sys?: Sys }): Promise<void> {
  const sys = o.sys ?? realSys;
  const { flags, out } = o;
  const usage = "usage: claude-rc node setup --listen <address> [--hub <url>] [--name <n>] [--id <id>] [--port <n>] [--names <a,b>] [--roots </a,/b>] [--service-user <user>] [--url <https-url>] [--binary <file>] [--release <tag>] [--force]";
  const nf = nodeFlags(flags, usage, urlHost(flags.url));
  const wildcard = nf.listen === "0.0.0.0" || nf.listen === "::";

  // 1. Checks
  if (sys.platform !== "linux") throw new ExitError(`node setup works on Linux with systemd only (this is ${sys.platform})`, 1);
  const cpu = releaseCpu(sys);
  if (!cpu) throw new ExitError(`unsupported CPU architecture: ${sys.arch}. Use --binary with a build for this machine`, 1);
  if (!sys.hasCommand("systemctl")) throw new ExitError("systemctl was not found. The node runs as a systemd service", 1);
  if (wildcard && !flags.url) throw new ExitError("--url is required when --listen is a wildcard address: the https URL that the hub will use for this node", 1);
  if (!wildcard && !sys.localAddresses().includes(nf.listen)) {
    throw new ExitError(`${nf.listen} is not an address of this machine (its IPv4 addresses: ${sys.localAddresses().filter((a) => !a.includes(":")).slice(0, 8).join(", ")})`, 1);
  }
  const url = flags.url ?? `https://${nf.listen}:${nf.port}`;
  let origin: URL;
  try {
    origin = new URL(url);
  } catch {
    throw new ExitError(`--url is not a valid URL: ${url}`, 1);
  }
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash || origin.username) {
    throw new ExitError(`--url must be an https:// origin without a path (for example https://10.0.0.5:8443): ${url}`, 1);
  }
  if (nf.serviceUser && sys.run(["id", "-u", nf.serviceUser]).code !== 0) throw new ExitError(`the user ${nf.serviceUser} does not exist on this machine`, 1);
  const id = flags.id ?? slug(flags.name ?? os.hostname());
  if (!HOST_ID_RE.test(id) || id === "local") throw new ExitError(`the host id ${JSON.stringify(id)} is not valid: use --id with lower-case letters, digits and hyphens (up to 32)`, 1);

  const present = [sys.exists(CONFIG) && CONFIG, sys.exists(UNIT_PATH) && UNIT_PATH].filter(Boolean) as string[];
  const active = sys.run(["systemctl", "is-active", NAME]).code === 0;
  if ((present.length || active) && !flags.force) {
    const what = [...present, ...(active ? [`a running ${NAME} service`] : [])].join(", ");
    throw new ExitError(`this machine is already set up (${what}). Use --force to replace it. Old files are kept as .bak`, 1);
  }

  // 2. The hub's values
  const enrollment = requireHubKeys(await o.hub.request<unknown>("GET", "/cli/api/node-enrollment"));

  // 3. The server binary
  const binary = await obtainBinary(sys, flags, `${NAME}-linux-${cpu}`, out);
  const config = renderNodeConfig({ hub: o.hubUrl, enrollment, ...nf });

  // 4. Install
  const sudo = (args: string[], what: string, input?: string | Uint8Array) => {
    const r = sys.sudo(args, input);
    if (r.code !== 0) throw new ExitError(`${what} failed (${args[0]} exit ${r.code})${r.stderr ? `: ${r.stderr.trim()}` : ""}`, 1);
    return r;
  };
  const tmp = sys.writeTemp(NAME, binary);
  try {
    sudo(["install", "-m", "755", tmp, `${BIN}.new`], "installing the binary");
    sudo(["mv", "-f", `${BIN}.new`, BIN], "installing the binary");
  } finally {
    sys.removeTemp(tmp);
  }
  sudo(["mkdir", "-p", CONFIG_DIR], "creating the configuration directory");
  for (const [file, text] of [[CONFIG, config], [UNIT_PATH, UNIT]] as const) {
    if (sys.exists(file)) sudo(["cp", "-p", file, `${file}.bak`], `backing up ${file}`);
    sudo(["tee", file], `writing ${file}`, text);
  }
  out(`installed ${BIN}, ${CONFIG} and ${UNIT_PATH}`);
  if (nf.serviceUser && !sys.exists(`/home/${nf.serviceUser}/.local/bin/claude`)) {
    out(`warning: /home/${nf.serviceUser}/.local/bin/claude was not found. Instances run as ${nf.serviceUser}, so claude must be installed for that user`);
  }

  // 5. Start and wait
  sudo(["systemctl", "daemon-reload"], "systemctl daemon-reload");
  sudo(["systemctl", "enable", "--now", NAME], "starting the service");
  if (active) sudo(["systemctl", "restart", NAME], "restarting the service");
  let pem = "";
  const deadline = sys.now() + HEALTH_WAIT_MS;
  for (let healthy = false; !healthy; ) {
    if (sys.now() >= deadline) {
      const log = sys.sudo(["journalctl", "-u", NAME, "-n", "15", "--no-pager"]).stdout.trim();
      throw new ExitError(`the node did not become healthy within ${HEALTH_WAIT_MS / 1000} seconds. Last log lines:\n${log}`, 1);
    }
    const r = sys.sudo(["cat", CERT]);
    if (r.code === 0 && r.stdout.includes("BEGIN CERTIFICATE")) {
      pem = r.stdout;
      try {
        healthy = (await sys.fetch(`${origin.origin}/healthz`, { tls: { ca: pem }, signal: AbortSignal.timeout(3000) } as RequestInit)).ok;
      } catch {
        /* not up yet */
      }
    }
    if (!healthy) await sys.sleep(500);
  }

  // 6. Register: the fingerprint comes from the node's own certificate file
  const fingerprint = `sha256:${sha256(new X509Certificate(pem).raw)}`;
  try {
    await o.hub.request("POST", "/cli/api/hosts", { id, ...(flags.name ? { name: flags.name } : {}), url, fingerprint });
  } catch (e) {
    if (!(e instanceof ExitError)) throw e;
    throw new ExitError(
      `${e.message}. The node is installed and running at ${url}. After fixing the cause, register it with: claude-rc host add ${id} --url ${url} --fingerprint ${fingerprint}`,
      e.code,
    );
  }

  // 7. Summary
  out(`registered host ${id} at ${url}`);
  out(`  fingerprint: ${fingerprint}`);
  out(`  config:      ${CONFIG}`);
  out(`To remove it: claude-rc host remove ${id}   and on this machine: sudo systemctl disable --now ${NAME}`);
}

/**
 * `claude-rc node update`: replaces the server binary of an installed node and restarts the service. The previous
 * binary is kept as `.prev` and comes back if the service does not stay active. The config, the unit, the
 * certificate and the registration are not touched, and the hub is not called.
 */
export async function nodeUpdate(o: { flags: Flags; out: (s: string) => void; sys?: Sys }): Promise<void> {
  const sys = o.sys ?? realSys;
  const { flags, out } = o;

  // 1. Checks
  if (sys.platform !== "linux") throw new ExitError(`node update works on Linux with systemd only (this is ${sys.platform})`, 1);
  if (!sys.hasCommand("systemctl")) throw new ExitError("systemctl was not found. The node runs as a systemd service", 1);
  if (flags.binary && flags.release) throw new ExitError("--binary and --release cannot be used together: --binary installs a file, --release downloads one", 1);
  const cpu = releaseCpu(sys);
  if (!cpu && !flags.binary) throw new ExitError(`unsupported CPU architecture: ${sys.arch}. Use --binary with a build for this machine`, 1);
  if (!sys.exists(BIN) || !sys.exists(UNIT_PATH)) throw new ExitError(`this machine is not set up as a node (${BIN} or ${UNIT_PATH} is missing). Run "claude-rc node setup" first`, 1);

  // 2. The new binary
  const binary = await obtainBinary(sys, flags, `${NAME}-linux-${cpu}`, out);
  if (sha256(binary) === sha256(sys.readFile(BIN))) return out("already up to date");

  // 3. Install
  try {
    installWithBackup(sudoIo(sys), BIN, binary);
  } catch (e) {
    if (e instanceof ReleaseError) throw new ExitError(e.message, 1);
    throw e;
  }

  // 4. Restart and wait for the service to stay active
  const isActive = () => sys.run(["systemctl", "is-active", NAME]).code === 0;
  let healthy = false;
  if (sys.sudo(["systemctl", "restart", NAME]).code === 0) {
    const deadline = sys.now() + HEALTH_WAIT_MS;
    while (!healthy && sys.now() < deadline) {
      if (isActive()) {
        await sys.sleep(STAY_ACTIVE_MS);
        healthy = isActive();
      } else {
        await sys.sleep(500);
      }
    }
  }
  if (healthy) return out(`updated ${BIN} (the previous binary is kept as ${BIN}.prev) and restarted ${NAME}`);

  // 5. Roll back
  const log = () => {
    const text = sys.sudo(["journalctl", "-u", NAME, "-n", "15", "--no-pager"]).stdout.trim();
    if (text) out(text);
  };
  if (!restorePrevious(sudoIo(sys), BIN)) {
    log();
    throw new ExitError(
      `the update failed and the previous binary could not be restored. The NEW binary is still installed and ${NAME} may be down or crash-looping. The previous binary is at ${BIN}.prev. To restore it by hand, run: sudo mv -f ${BIN}.prev ${BIN} && sudo systemctl restart ${NAME}`,
      1,
    );
  }
  const restarted = sys.sudo(["systemctl", "restart", NAME]).code === 0;
  log();
  throw new ExitError(
    restarted
      ? `the update failed: ${NAME} did not become active and stay active within ${HEALTH_WAIT_MS / 1000} seconds. The previous binary was restored and the service was restarted`
      : `the update failed: ${NAME} did not become active and stay active within ${HEALTH_WAIT_MS / 1000} seconds. The previous binary is back in place at ${BIN}, but the service did not restart. Last log lines are above`,
    1,
  );
}

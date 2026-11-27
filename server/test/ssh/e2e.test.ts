/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- the answer bodies are loose JSON that the tests check */
// End to end proof of SSH delegation with a real sshd: the hub (in process), the local broker and agent, and the `ssh`
// client of a session. Every path that the test writes is below one folder that `mkdtemp` made, and `HOME` of every child
// process is a folder inside it, so the real `~/.ssh` and every real `authorized_keys` stay untouched.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mintSessionCookie } from "../../src/auth/oidc";
import type { OidcClient } from "../../src/auth/oidc";
import type { Config } from "../../src/config/parse";
import { startHub } from "../../src/hubmain";
import type { Instance } from "../../src/instances/InstanceService";
import { DEFAULT_ROLES } from "../../src/roles";
import { GrantStore } from "../../src/ssh/hub/GrantStore";
import { SshKeyStore } from "../../src/ssh/hub/SshKeyStore";
import { createLocalSsh } from "../../src/ssh/node/wiring";
import { linuxInstallScript } from "../../src/ssh/provisioner/key";
import { SshService } from "../../src/ssh/hub/SshService";
import { TargetStore } from "../../src/ssh/TargetStore";
import { newRecovery, openWithRecovery } from "../../src/ssh/hub/wrap";
import { NodeEvents } from "../../src/hosts/NodeEvents";
import { noSkill } from "../support";

const INSTANCE_ID = "0123456789ab";
const TARGET = "lab";
const PASSPHRASE = "correct horse";
const unlock = { method: "passphrase", secret: Buffer.from(PASSPHRASE).toString("base64url") };
const wrongUnlock = { method: "passphrase", secret: Buffer.from("wrong horse").toString("base64url") };
const stubOidc: OidcClient = {
  authorizationUrl: () => Promise.resolve("https://idp/authorize"),
  exchange: () => Promise.resolve({ sub: "u1", name: "Ann" }),
};
const user = { sub: "u1", name: "Ann", username: "kir", role: "admin" as const };

const sshdPath =
  Bun.which("sshd") ?? ["/usr/sbin/sshd", "/usr/local/sbin/sshd"].find((candidate) => existsSync(candidate));
const keygenPath = Bun.which("ssh-keygen");
const sshPath = Bun.which("ssh");

/** Narrows a tool path that `skipIf` already checked. */
function need(value: string | null | undefined): string {
  if (value == null) throw new Error("tool missing");

  return value;
}

const missing = !sshdPath || !keygenPath || !sshPath;

let root = "";
let home = "";
let sshd: Bun.Subprocess | undefined;
let sshdPort = 0;
let hubStop: (() => void) | undefined;
let logMute: { mockRestore: () => void } | undefined;

/** Asks the OS for a free port and gives it back. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

async function until(check: () => boolean | Promise<boolean>, what: string, rounds = 200): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    if (await check()) return;
    await Bun.sleep(30);
  }

  throw new Error(`timed out: ${what}`);
}

const canConnect = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });

/** Runs a command with the temporary HOME and no agent. It returns the exit code and the output. */
async function run(command: string[]): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(command, {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: out + err };
}

/** Starts sshd in the foreground with a configuration, a host key and an `authorized_keys` file in the temporary folder. */
async function startSshd(authorizedKeys: string): Promise<string> {
  const keyFile = path.join(root, "sshd", "host_ed25519");
  mkdirSync(path.dirname(keyFile), { recursive: true });
  const made = await run([need(keygenPath), "-q", "-t", "ed25519", "-N", "", "-f", keyFile]);
  if (made.code !== 0) throw new Error(`ssh-keygen failed: ${made.output}`);
  sshdPort = await freePort();
  const configFile = path.join(root, "sshd", "sshd_config");
  writeFileSync(
    configFile,
    [
      `Port ${sshdPort}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${keyFile}`,
      `PidFile ${path.join(root, "sshd", "sshd.pid")}`,
      `AuthorizedKeysFile ${authorizedKeys}`,
      "StrictModes no",
      "UsePAM no",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "PubkeyAuthentication yes",
      "PermitRootLogin yes",
      "LogLevel ERROR",
      "",
    ].join("\n"),
  );
  sshd = Bun.spawn([need(sshdPath), "-D", "-e", "-f", configFile], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await until(() => canConnect(sshdPort), "sshd listens");
  // `<type> <base64>`, without the comment.
  return readFileSync(`${keyFile}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ");
}

/** Sends one line to a control socket and returns the first answer. It answers when the request settles. */
function talk(socketPath: string, line: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let received = "";
    Bun.connect({
      unix: socketPath,
      socket: {
        open: (socket) => {
          socket.write(line);
        },
        data: (socket, chunk) => {
          received += Buffer.from(chunk).toString("utf8");

          if (received.includes("\n")) {
            resolve(JSON.parse(received.split("\n")[0] ?? "{}") as Record<string, any>);
            socket.end();
          }
        },
        close: () => {
          reject(new Error("closed without an answer"));
        },
        error: () => {},
      },
    }).catch(reject);
  });
}

/** The default public keys of the account that runs the test (`~/.ssh/id_*.pub` of its passwd home), read only. */
function ownDefaultKeys(): string {
  const folder = path.join(os.userInfo().homedir, ".ssh");
  const names = ["id_ed25519.pub", "id_ecdsa.pub", "id_rsa.pub"];
  return names
    .map((name) => path.join(folder, name))
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, "utf8").trim() + "\n")
    .join("");
}

/** Every file below a folder. */
function filesBelow(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesBelow(full);
    return entry.isFile() ? [full] : [];
  });
}

afterAll(async () => {
  hubStop?.();
  logMute?.mockRestore();
  sshd?.kill();
  await sshd?.exited;
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("SSH delegation with a real sshd", () => {
  beforeAll(() => {
    // The hub writes audit lines with console.log: they would fill the test output.
    logMute = spyOn(console, "log").mockImplementation(() => {});
  });

  test.skipIf(missing)(
    "a session signs through the local agent while a grant is active and fails after revoke",
    async () => {
      root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "rc-ssh-e2e-")));
      home = path.join(root, "home");
      mkdirSync(home);
      const authorizedKeys = path.join(root, "sshd", "authorized_keys");
      const hostKey = await startSshd(authorizedKeys);
      writeFileSync(authorizedKeys, "");

      const sshDir = path.join(root, "run-ssh");
      const instance: Instance = {
        id: INSTANCE_ID,
        path: "/p",
        name: "one",
        state: "active",
        startedAt: null,
        settings: { createSession: true, spawnMode: "same-dir", sshRequests: true },
      };
      const fake = {
        list: () => Promise.resolve([instance]),
        stop: () => Promise.resolve(),
        trustFilter: () => Promise.resolve(() => false),
      } as never;
      const stateDir = path.join(root, "state");
      const cfg = {
        scope: "user",
        unitDir: path.join(root, "units"),
        serviceUser: "root",
        serviceHome: home,
        servicePath: "/bin",
        claudeBin: "/bin/claude",
        claudeRcArgs: [],
        namePrefix: "",
        mode: "hub",
        stateDir,
        name: "hub",
        port: 0,
        host: "127.0.0.1",
        publicUrl: "https://rc.example.com",
        roots: [root],
        userAuth: {
          mode: "oidc",
          sessionSecret: "s3cret-s3cret-s3cret",
          oidc: { issuer: "https://idp", clientId: "c", clientSecret: "s", allowInsecure: false },
          roles: { ...DEFAULT_ROLES, defaultRole: "admin" },
        },
        hosts: [],
      } as unknown as Config;
      const hub = await startHub(cfg, { instances: fake, oidc: stubOidc, sshDir, deploySkill: noSkill });

      hubStop = () => {
        hub.stop();
      };

      const cookie = await mintSessionCookie(cfg, user, Date.now() + 3600_000);

      const call = async (method: string, route: string, body?: unknown) => {
        const response = await fetch(`http://127.0.0.1:${hub.port}/api/ssh${route}`, {
          method,
          headers: { cookie, "content-type": "application/json" },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : null };
      };

      const grants = async () => (await call("GET", "/grants")).body as Record<string, any>[];

      // Setup, node, target, key, host key pin, install line, test.
      const setup = await call("POST", "/setup", { method: "passphrase" });
      expect(setup.status).toBe(200);
      const recoveryCode = String(setup.body.recoveryCode);
      expect((await call("PUT", "/nodes/local", { enabled: true, sourceAddress: "127.0.0.1" })).status).toBe(200);
      const added = await call("POST", "/targets", {
        id: TARGET,
        account: os.userInfo().username,
        address: "127.0.0.1",
        port: sshdPort,
        systemType: "linux",
        nodes: ["local"],
      });
      expect(added.status).toBe(201);
      const key = await call("POST", `/targets/${TARGET}/key`, { unlock });
      expect(key.status).toBe(200);
      expect((await call("POST", `/targets/${TARGET}/pin`, { hostKey })).status).toBe(200);

      // The own default keys of the account that runs the probe are authorized, but the install line is missing: the
      // test must fail, because the probe offers only the key of the grant. The keys are only read, never written.
      writeFileSync(authorizedKeys, ownDefaultKeys());
      const withoutLine = await call("POST", `/targets/${TARGET}/test`, { node: "local", unlock });
      expect(withoutLine.status).toBe(200);
      expect(withoutLine.body.ok).toBe(false);
      expect((await call("GET", `/targets/${TARGET}`)).body.state).toBe("draft");

      writeFileSync(authorizedKeys, `${String(key.body.installLine)}\n`);
      const tested = await call("POST", `/targets/${TARGET}/test`, { node: "local", unlock });
      expect(tested.status).toBe(200);
      expect(tested.body).toMatchObject({ ok: true });
      expect((await call("GET", `/targets/${TARGET}`)).body.state).toBe("ready");

      // A session asks through the control socket and waits for the owner.
      const controlSocket = path.join(sshDir, INSTANCE_ID, "control.sock");
      await until(() => existsSync(controlSocket), "control socket");
      let settled = false;
      const answer = talk(controlSocket, `{"op":"request","targetId":"${TARGET}","reason":"e2e"}\n`);
      void answer.then(
        () => (settled = true),
        () => (settled = true),
      );
      await until(async () => (await grants()).some((item) => item.state === "pending"), "pending grant");
      expect(settled).toBe(false);
      const [pending] = (await grants()).filter((item) => item.state === "pending");
      expect(pending).toMatchObject({ nodeId: "local", targetId: TARGET, state: "pending", reason: "e2e" });

      const approved = await call("POST", `/grants/${pending.id}/approve`, { unlock, minutes: 5 });
      expect(approved.status).toBe(200);
      expect(approved.body.state).toBe("active");
      const reply = await answer;
      expect(reply.ok).toBe(true);
      const agentSocket = reply.socket as string;
      const sshConfig = reply.config as string;
      expect(existsSync(agentSocket)).toBe(true);
      expect(statSync(sshConfig).isFile()).toBe(true);

      // The ssh client of the session signs through the agent.
      const ssh = () =>
        run([need(sshPath), "-F", sshConfig, "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", TARGET, "true"]);
      const first = await ssh();
      expect(first.output).toBe("");
      expect(first.code).toBe(0);

      // ssh finds the default keys through the passwd home, not $HOME, so the test cannot plant one. Its debug output
      // lists every key that it will try: only the public key file of the grant may be there.
      const verbose = await run([
        need(sshPath),
        "-v",
        "-F",
        sshConfig,
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        TARGET,
        "true",
      ]);
      expect(verbose.code).toBe(0);
      const attempts = verbose.output.split("\n").filter((line) => line.includes("Will attempt key:"));
      expect(attempts.length).toBeGreaterThan(0);
      for (const line of attempts) expect(line).toContain(sshConfig.replace(/\.config$/, ".pub"));

      // Revoke ends it: the socket is gone and the next sign-in fails.
      expect((await call("POST", `/grants/${pending.id}/revoke`)).status).toBe(200);
      await until(() => !existsSync(agentSocket), "agent socket removed");
      const second = await ssh();
      expect(second.code).not.toBe(0);

      // A second request with a wrong passphrase is refused and the grant stays pending.
      const again = talk(controlSocket, `{"op":"request","targetId":"${TARGET}"}\n`);
      again.catch(() => {});
      await until(async () => (await grants()).some((item) => item.state === "pending"), "second pending grant");
      const [next] = (await grants()).filter((item) => item.state === "pending");
      const refused = await call("POST", `/grants/${next.id}/approve`, { unlock: wrongUnlock, minutes: 5 });
      expect(refused.status).toBe(403);
      expect((await grants()).find((item) => item.id === next.id)?.state).toBe("pending");

      // No file of the run holds the private key seed in clear.
      const keysFile = path.join(stateDir, "ssh", "keys.json");
      const record = JSON.parse(readFileSync(keysFile, "utf8")).keys[TARGET];
      const seed = Buffer.from(openWithRecovery(recoveryCode, String(record.recovery), TARGET));
      expect(seed.length).toBe(32);
      const forms = [seed.toString("hex"), seed.toString("base64"), seed.toString("base64url")];

      for (const file of filesBelow(root)) {
        const raw = readFileSync(file);
        const text = raw.toString("latin1");
        for (const form of forms) expect({ file, found: text.includes(form) }).toEqual({ file, found: false });
        expect({ file, found: raw.includes(seed) }).toEqual({ file, found: false });
      }
    },
    30_000,
  );
});

describe("SSH maintenance with a real sshd", () => {
  let mRoot = "";
  let mSshd: Bun.Subprocess | undefined;
  let stopLocal: (() => Promise<void>) | undefined;

  afterAll(async () => {
    await stopLocal?.();
    mSshd?.kill();
    await mSshd?.exited;
    if (mRoot) rmSync(mRoot, { recursive: true, force: true });
  });

  // The account HOME is a temporary folder: sshd sets it with `SetEnv`, so the script on the "target" writes
  // `<temp>/.ssh/authorized_keys` and `<temp>/.claude-rc`, never the real home of the account. A probe key proves it
  // before the script is installed.
  test.skipIf(missing)(
    "a maintenance sources run changes from= in authorized_keys, and uninstall removes both lines",
    async () => {
      mRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "rc-ssh-maint-e2e-")));
      const mHome = path.join(mRoot, "home");
      const sshFolder = path.join(mHome, ".ssh");
      mkdirSync(sshFolder, { recursive: true });
      const authorizedKeys = path.join(sshFolder, "authorized_keys");
      const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: mHome };

      const exec = async (command: string[], stdin?: string) => {
        const child = Bun.spawn(command, {
          env,
          stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
          stdout: "pipe",
          stderr: "pipe",
        });
        const [out, err, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        return { code, out, err };
      };

      // sshd with its host key, the key file in the temporary home, and HOME set to that home.
      const hostKeyFile = path.join(mRoot, "sshd", "host_ed25519");
      mkdirSync(path.dirname(hostKeyFile), { recursive: true });
      expect((await exec([need(keygenPath), "-q", "-t", "ed25519", "-N", "", "-f", hostKeyFile])).code).toBe(0);
      const port = await freePort();
      const sshdConfig = path.join(mRoot, "sshd", "sshd_config");
      writeFileSync(
        sshdConfig,
        [
          `Port ${port}`,
          "ListenAddress 127.0.0.1",
          `HostKey ${hostKeyFile}`,
          `PidFile ${path.join(mRoot, "sshd", "sshd.pid")}`,
          `AuthorizedKeysFile ${authorizedKeys}`,
          `SetEnv HOME=${mHome}`,
          "StrictModes no",
          "UsePAM no",
          "PasswordAuthentication no",
          "KbdInteractiveAuthentication no",
          "PubkeyAuthentication yes",
          "PermitRootLogin yes",
          "LogLevel ERROR",
          "",
        ].join("\n"),
      );
      mSshd = Bun.spawn([need(sshdPath), "-D", "-e", "-f", sshdConfig], {
        env,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      await until(() => canConnect(port), "sshd listens");
      const hostKey = readFileSync(`${hostKeyFile}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ");
      const account = os.userInfo().username;

      // The probe: a forced command that prints HOME. Anything but the temporary home stops the test here.
      const probeKey = path.join(mRoot, "probe");
      expect((await exec([need(keygenPath), "-q", "-t", "ed25519", "-N", "", "-f", probeKey])).code).toBe(0);
      writeFileSync(
        authorizedKeys,
        `command="printf '%s' \\"$HOME\\"",restrict ${readFileSync(`${probeKey}.pub`, "utf8").trim()}\n`,
      );
      const probe = await exec([
        need(sshPath),
        "-F",
        "/dev/null",
        "-i",
        probeKey,
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        `UserKnownHostsFile=${path.join(mRoot, "probe_known_hosts")}`,
        "-p",
        String(port),
        `${account}@127.0.0.1`,
        "x",
      ]);
      if (probe.out !== mHome) throw new Error(`sshd does not set HOME to the temporary home: ${probe.out}`);

      // The hub side: the stores, the grant store, the host `local` in process, and the service with the real runner.
      const stateDir = path.join(mRoot, "state");
      const sshDir = path.join(mRoot, "run-ssh");
      const keys = new SshKeyStore(path.join(stateDir, "keys.json"));
      const targets = new TargetStore(path.join(stateDir, "targets.json"));
      const audit: string[] = [];
      const cfg = {
        scope: "user",
        unitDir: path.join(mRoot, "units"),
        serviceUser: "root",
        serviceHome: mHome,
        servicePath: "/bin",
        claudeBin: "/bin/claude",
        claudeRcArgs: [],
        namePrefix: "",
        mode: "hub",
        stateDir,
        name: "hub",
        port: 0,
        host: "127.0.0.1",
        publicUrl: "https://rc.example.com",
        roots: [mRoot],
        hosts: [],
        installSkill: false,
      } as unknown as Config;
      const instances = {
        list: () => Promise.resolve([]),
        stop: () => Promise.resolve(),
        trustFilter: () => Promise.resolve(() => false),
      } as never;
      const events = new NodeEvents();
      const local = createLocalSsh({ cfg, instances, events, dir: sshDir, deploySkill: noSkill });
      stopLocal = () => local.stop();
      const hook: { service?: SshService } = {};
      const grants = new GrantStore({
        audit: (line) => audit.push(line),
        onEnd: (grant) => hook.service?.onGrantEnd(grant),
      });
      const service = new SshService({
        keys,
        targets,
        grants,
        client: (hostId) => (hostId === "local" ? local.client : undefined),
        audit: (line) => audit.push(line),
      });
      hook.service = service;
      const off = events.subscribe((event) => {
        const { type, ...data } = event;
        if (type === "ssh.sign") service.onNodeEvent("local", type, data);
      });

      try {
        const secret = { method: "passphrase" as const, secret: new TextEncoder().encode(PASSPHRASE) };
        await keys.setup({ method: "passphrase", recoveryPublicKey: newRecovery().publicKey });
        await targets.add({ id: TARGET, address: "127.0.0.1", port, account, systemType: "linux", nodes: ["local"] });
        await targets.setNodeAccess("local", { enabled: true, sourceAddress: "127.0.0.1" });
        await targets.setNodeAccess("node2", { enabled: true, sourceAddress: "10.9.9.9" });
        await targets.setHostKey(TARGET, hostKey);
        await targets.setState(TARGET, "ready");
        const main = await keys.create(TARGET, secret);
        const provisioner = await keys.create(TARGET, secret, "provisioner");

        // The owner's install: an owner line, the main line, then the install script in the temporary home.
        const ownerLine =
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOwnerOwnerOwnerOwnerOwnerOwnerOwnerOwnerOwn owner@laptop";
        writeFileSync(authorizedKeys, `${ownerLine}\nfrom="127.0.0.1",restrict ${main.publicLine}\n`);
        const install = linuxInstallScript({
          targetId: TARGET,
          mainPublicLine: main.publicLine,
          provisionerPublicLine: provisioner.publicLine,
          localSource: "127.0.0.1",
          sources: ["127.0.0.1"],
        });
        const installed = await exec(["sh", "-s"], install.script);
        expect(installed.code).toBe(0);
        const scriptPath = path.join(mHome, ".claude-rc", `provisioner-${TARGET}.sh`);
        expect(installed.out.trim()).toBe(`ok installed ${scriptPath}`);
        await targets.setProvisioner(TARGET, {
          fingerprint: provisioner.fingerprint,
          script: scriptPath,
          source: "127.0.0.1",
        });

        // sources: the new list reaches the main line, and the provisioner line stays.
        const change = service.requestMaintenance({
          targetId: TARGET,
          action: "sources",
          toNodes: ["local", "node2"],
          by: "kir",
        });
        const changed = await service.approve(change.id, "kir", secret);
        expect(changed.maintenance).toMatchObject({ result: "done" });
        expect(changed).toMatchObject({ state: "ended", endReason: "done" });
        const afterChange = readFileSync(authorizedKeys, "utf8");
        expect(afterChange).toContain(`from="127.0.0.1,10.9.9.9",restrict ${main.publicLine}\n`);
        expect(afterChange).not.toContain(`from="127.0.0.1",restrict ${main.publicLine}`);
        expect(afterChange).toContain(`claude-rc-provisioner:${TARGET}\n`);
        expect(afterChange.startsWith(`${ownerLine}\n`)).toBe(true);
        // The grant files and the agent socket of the grant go away.
        const grantFolder = path.join(sshDir, "maintenance");
        await until(() => !existsSync(grantFolder) || readdirSync(grantFolder).length === 0, "grant files removed");

        // uninstall: both lines go, the script and its state file too, and the owner line keeps its bytes.
        const retire = service.requestMaintenance({ targetId: TARGET, action: "uninstall", by: "kir" });
        const retired = await service.approve(retire.id, "kir", secret);
        expect(retired.maintenance).toMatchObject({ result: "done" });
        expect(readFileSync(authorizedKeys, "utf8")).toBe(`${ownerLine}\n`);
        expect(existsSync(scriptPath)).toBe(false);
        expect(existsSync(path.join(mHome, ".claude-rc", `provisioner-${TARGET}.from`))).toBe(false);
        await until(() => !existsSync(grantFolder) || readdirSync(grantFolder).length === 0, "grant files removed");

        // The audit lines name the target, the action and the result only.
        const text = audit.join("\n");
        expect(text).toContain("event=run command=sources code=0 answer=sources");
        expect(text).toContain("event=run command=uninstall code=0 answer=uninstall");
        expect(text).not.toContain("10.9.9.9");
        // A restore-failed line holds a fixed word and the exit code only, never the text of ssh.
        for (const line of audit.filter((item) => item.includes("event=restore-failed")))
          expect(line).toMatch(/ event=restore-failed code=\S+$/);
        // The real ssh signs once for each run, so the sign cap of a grant (sources 3, uninstall 1) never stops a run.
        const signed = (id: string) =>
          audit.filter((line) => line.includes(`grant=${id} `) && line.includes(" event=signed ")).length;
        expect(signed(change.id)).toBe(2);
        expect(signed(retire.id)).toBe(1);
        expect(audit.some((line) => line.includes("event=sign-refused"))).toBe(false);
        expect(text).not.toContain(provisioner.publicLine.split(" ")[1]);
      } finally {
        off();
      }
    },
    60_000,
  );
});

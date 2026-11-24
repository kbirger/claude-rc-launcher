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
import { mintSessionCookie } from "../src/auth";
import type { OidcClient } from "../src/auth";
import type { Config } from "../src/config";
import { startHub } from "../src/hubmain";
import type { Instance } from "../src/instances";
import { DEFAULT_ROLES } from "../src/roles";
import { openWithRecovery } from "../src/sshwrap";
import { noSkill } from "./support";

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

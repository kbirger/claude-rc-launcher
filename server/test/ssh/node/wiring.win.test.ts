import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sshRequest, sshTargets } from "../../../../cli/src/sshcmd";
import { onError } from "../../../src/app";
import type { Config } from "../../../src/config/parse";
import { NodeEvents } from "../../../src/hosts/NodeEvents";
import type { NodeEvent } from "../../../src/hosts/NodeEvents";
import type { Instance, Instances } from "../../../src/instances/InstanceService";
import { sshNodeApi } from "../../../src/ssh/api/node";
import type { SshNodeOptions } from "../../../src/ssh/node/types";
import { createNodeSsh } from "../../../src/ssh/node/wiring";
import { WinSshBridge } from "../../../src/win/sshbridge";
import type { SshClientCheck } from "../../../src/win/sshclient";
import { defined } from "../../support";

const cfg = { mode: "node", name: "win", roots: ["C:\\srv"], scope: "system", serviceUser: "svc" } as unknown as Config;
const ID1 = "0123456789ab";
const ID2 = "abcdef012345";
const REAL = process.platform === "win32";
const SYSTEM32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
const SSH_ADD = join(SYSTEM32, "OpenSSH", "ssh-add.exe");
const FAKE_SSH = "C:\\Windows\\System32\\OpenSSH\\ssh.exe";
const PIPE_START = "\\\\.\\pipe\\";

let root: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rc-winwire-"));
  dir = join(root, "ssh");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const instance = (id: string, sshRequests: boolean): Instance => ({
  id,
  path: `C:\\srv\\${id}`,
  name: id,
  state: "active",
  startedAt: null,
  settings: { createSession: true, spawnMode: "same-dir", sshRequests },
});

function fakeInstances(list: Instance[]): Instances {
  return { list: () => Promise.resolve(list) } as unknown as Instances;
}

function keyBlob(): { publicKey: string; line: string } {
  const { publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const name = Buffer.from("ssh-ed25519");
  const length = (size: number) => Buffer.from([0, 0, 0, size]);
  const blob = Buffer.concat([length(name.length), name, length(raw.length), raw]);
  return { publicKey: blob.toString("base64"), line: `ssh-ed25519 ${blob.toString("base64")}` };
}

/** Runs ssh-add -L against a pipe. It must be async: the agent runs in this process, and a blocking call would stop it. */
async function listKeys(pipe: string): Promise<string> {
  const proc = Bun.spawn([SSH_ADD, "-L"], {
    env: { ...process.env, SSH_AUTH_SOCK: pipe },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return out + err;
}

function apiOf(options: SshNodeOptions | undefined): Hono {
  const app = sshNodeApi(defined(options));
  app.onError(onError);
  return app;
}

const good = (): Promise<SshClientCheck> =>
  Promise.resolve({ ok: true, sshPath: FAKE_SSH, sshAddPath: SSH_ADD, version: "9.5" } as SshClientCheck);

const off = (reason: string) => (): Promise<SshClientCheck> => Promise.resolve({ ok: false, reason } as SshClientCheck);

function grantBody(grantId: string, requestId?: string) {
  const key = keyBlob();

  return {
    key,
    body: JSON.stringify({
      grantId,
      ...(requestId ? { requestId } : {}),
      instanceId: ID1,
      targetId: "nas",
      publicKey: key.publicKey,
      address: "10.0.0.2",
      port: 22,
      account: "root",
      hostKey: key.line,
      endsAt: Date.now() + 60_000,
    }),
  };
}

describe.skipIf(!REAL)("a Windows node with SSH requests, on real pipes and real icacls in a temp folder", () => {
  function make(client: () => Promise<SshClientCheck>) {
    const bridge = new WinSshBridge();
    const events = new NodeEvents();
    const node = createNodeSsh({
      cfg,
      instances: fakeInstances([instance(ID1, true), instance(ID2, false)]),
      events,
      dir,
      platform: "win32",
      bridge,
      winClient: client,
      log: () => {},
    });
    return { bridge, events, node };
  }

  test("a request goes from the CLI, through the control pipe, to a grant with an agent pipe", async () => {
    const { bridge, events, node } = make(good);
    await node.start();

    try {
      expect(await bridge.refusal()).toBeUndefined();
      const env = defined(bridge.env)(ID1);
      expect(env.CLAUDE_RC_SSH_CONTROL.startsWith(`${PIPE_START}claude-rc-control-`)).toBe(true);
      const control = env.CLAUDE_RC_SSH_CONTROL;
      const token = env.CLAUDE_RC_SSH_TOKEN;
      defined(node.ssh).broker.setTargets([{ id: "nas", account: "root", address: "10.0.0.2" }]);

      const lines: string[] = [];
      await sshTargets({ control, token, out: (line) => lines.push(line) });
      expect(lines).toEqual(["nas  root@10.0.0.2"]);

      const requested = new Promise<NodeEvent>((resolve) => {
        const stop = events.subscribe((event) => {
          if (event.type === "ssh.request") {
            stop();
            resolve(event);
          }
        });
      });
      const out: string[] = [];
      const done = sshRequest({ control, token, targetId: "nas", out: (line) => out.push(line) });
      const event = await requested;
      if (event.type !== "ssh.request") throw new Error("not a request");
      expect(event.instanceId).toBe(ID1);

      const { key, body } = grantBody("g1", event.requestId);
      const api = apiOf(node.ssh);
      const response = await api.request("/grants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(200);
      await done;

      const sshLine = defined(out.find((line) => line.includes(" -F ")));
      expect(sshLine.startsWith(`"${FAKE_SSH}" -F `)).toBe(true);
      const answer = (await response.json()) as { socket: string; config: string };
      expect(answer.socket.startsWith(`${PIPE_START}claude-rc-agent-`)).toBe(true);
      const config = readFileSync(answer.config, "utf8");
      expect(config).toContain("IdentityAgent //./pipe/claude-rc-agent-");
      expect(config).toContain("GlobalKnownHostsFile /dev/null");

      // The agent on the pipe lists the key of the grant.
      const listed = await listKeys(answer.socket);
      expect(listed).toContain(key.line);

      // A removal deletes the files and closes the pipe.
      const gone = await api.request("/grants/g1", { method: "DELETE" });
      expect(gone.status).toBe(204);
      expect(existsSync(answer.config)).toBe(false);
      expect(readdirSync(join(dir, ID1))).toEqual([]);
      const after = await listKeys(answer.socket);
      expect(after).not.toContain(key.line);
    } finally {
      await node.stop();
    }
  });

  test("a client that fails the check stops a grant with the plain reason", async () => {
    let usable = true;
    const { node } = make(() => (usable ? good() : off("The SSH client is too old")()));
    await node.start();

    try {
      usable = false;
      const api = apiOf(node.ssh);
      const response = await api.request("/grants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: grantBody("g2").body,
      });
      expect(response.status).toBe(409);
      expect(await response.text()).toContain("The SSH client is too old");
    } finally {
      await node.stop();
    }
  });

  test("the setting is refused and not offered without a usable client", async () => {
    const { bridge, node } = make(off("No SSH client is installed"));
    await node.start();

    try {
      expect(await bridge.refusal()).toBe("No SSH client is installed");
      expect(await defined(node.sshUsable)()).toBe(false);
    } finally {
      await node.stop();
    }
  });

  test("a new token for an instance ends the old one", async () => {
    const { bridge, node } = make(good);
    await node.start();

    try {
      const first = defined(bridge.env)(ID1);
      const second = defined(bridge.env)(ID1);
      expect(second.CLAUDE_RC_SSH_TOKEN).not.toBe(first.CLAUDE_RC_SSH_TOKEN);
      await expect(
        sshTargets({ control: first.CLAUDE_RC_SSH_CONTROL, token: first.CLAUDE_RC_SSH_TOKEN, out: () => {} }),
      ).rejects.toThrow();
      await sshTargets({ control: second.CLAUDE_RC_SSH_CONTROL, token: second.CLAUDE_RC_SSH_TOKEN, out: () => {} });
    } finally {
      await node.stop();
    }
  });

  test("the skill goes to the home of the service user only when the client works", async () => {
    for (const [client, expected] of [
      [good, 1],
      [off("No SSH client is installed"), 0],
    ] as const) {
      const deployed: string[] = [];
      const node = createNodeSsh({
        cfg: { ...cfg, serviceHome: "C:/Users/svc", servicePath: "" } as Config,
        instances: fakeInstances([]),
        events: new NodeEvents(),
        dir,
        platform: "win32",
        bridge: new WinSshBridge(),
        winClient: client,
        deploySkill: (user) => {
          deployed.push(user.home);
          return Promise.resolve("written");
        },
        log: () => {},
      });
      await node.start();
      await node.stop();
      expect(deployed).toHaveLength(expected);
    }
  });

  test("a failed start offers no setting and hands out no variables", async () => {
    const bridge = new WinSshBridge();
    const node = createNodeSsh({
      cfg,
      instances: fakeInstances([instance(ID1, true)]),
      events: new NodeEvents(),
      dir,
      platform: "win32",
      bridge,
      winClient: good,
      winTransports: {
        control: () => ({ listen: () => Promise.reject(new Error("pipe busy")) }),
        agent: () => ({ listen: () => Promise.reject(new Error("pipe busy")) }),
      },
      log: () => {},
    });
    await node.start();
    expect(bridge.env).toBeUndefined();
    expect(await defined(node.sshUsable)()).toBe(false);
    expect(await bridge.refusal()).toBe("SSH requests are not ready on this node");
    await node.stop();
  });
});

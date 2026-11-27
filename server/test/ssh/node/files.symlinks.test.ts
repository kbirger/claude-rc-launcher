// A session that runs as the instance user owns the folder of its instance. The node runs as root and writes into that
// folder, so every write, chmod and chown there must not follow a link that the session planted. Every path of these
// tests is below a folder that `mkdtemp` made: the victim file is a file of the test, never a real system file.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicKeyBlob } from "../../../src/ssh/agentproto";
import { createPrivateFile, writeNewFile } from "../../../src/ssh/node/files";
import { SshBroker, sshNodeApi } from "../../../src/ssh/api/node";
import { SshControl } from "../../../src/ssh/node/SshControl";
import { NodeEvents } from "../../../src/hosts/NodeEvents";
import { rejection } from "../../support";

const BLOB = publicKeyBlob(new Uint8Array(32).fill(7));
const PUBLIC_KEY = Buffer.from(BLOB).toString("base64");
const HOST_KEY = `ssh-ed25519 ${Buffer.from(publicKeyBlob(new Uint8Array(32).fill(3))).toString("base64")}`;
const VICTIM_TEXT = "root:x:0:0:root:/root:/bin/bash\n";
const OWNER = { uid: 4242, gid: 4343 };

let root: string;
let dir: string;
let victim: string;
let chowns: string[];

const chown = (path: string) => {
  chowns.push(path);
  return Promise.resolve();
};

function grantBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    grantId: "g1",
    instanceId: "inst1",
    targetId: "web1",
    publicKey: PUBLIC_KEY,
    address: "10.0.0.5",
    port: 22,
    account: "deploy",
    hostKey: HOST_KEY,
    endsAt: 1_900_000_000_000,
    ...overrides,
  };
}

async function victimUnchanged(): Promise<void> {
  expect(await readFile(victim, "utf8")).toBe(VICTIM_TEXT);
  const info = await stat(victim);
  expect(info.mode & 0o777).toBe(0o644);
  expect(info.uid).toBe(process.getuid?.() ?? info.uid);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rc-ssh-links-"));
  dir = join(root, "ssh");
  await mkdir(join(root, "elsewhere"));
  victim = join(root, "elsewhere", "victim");
  await writeFile(victim, VICTIM_TEXT, { mode: 0o644 });
  chowns = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("POST /grants never follows a link in the instance folder", () => {
  function router() {
    const events = new NodeEvents();
    return sshNodeApi({
      dir,
      events,
      broker: new SshBroker({ events }),
      chown,
      resolveUser: () => OWNER,
      probe: () => Promise.resolve({ code: 0, stderr: "" }),
    });
  }

  const post = (app: ReturnType<typeof router>, body: Record<string, unknown>) =>
    app.request("/grants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  for (const suffix of [".known_hosts", ".config", ".pub", ".sock"]) {
    test(`a link planted at <grantId>${suffix} leaves the victim unchanged`, async () => {
      const app = router();
      await mkdir(join(dir, "inst1"), { recursive: true, mode: 0o700 });
      const planted = join(dir, "inst1", `g1${suffix}`);
      await symlink(victim, planted);

      const response = await post(app, grantBody());
      expect(response.status).toBe(200);
      await victimUnchanged();
      expect((await lstat(planted)).isSymbolicLink()).toBe(false);
      expect((await lstat(planted)).mode & 0o777).toBe(0o600);
      await app.request("/reset", { method: "POST" });
    });
  }

  test("the socket is chowned in the staging folder, which has mode 700 and is never chowned", async () => {
    const app = router();
    expect((await post(app, grantBody())).status).toBe(200);
    const stage = join(dir, ".stage");
    expect((await stat(stage)).mode & 0o777).toBe(0o700);
    expect(chowns).not.toContain(stage);
    expect(chowns).not.toContain(dir);
    // The socket is never chowned by its path in the instance folder. (The files are chowned through the open file:
    // the recorder of the test gets their path instead.)
    expect(chowns).not.toContain(join(dir, "inst1", "g1.sock"));
    expect(chowns).toContain(join(dir, "inst1"));
    expect(chowns.some((path) => path.startsWith(`${stage}/`) && path.endsWith(".sock"))).toBe(true);
    expect(await readdir(stage)).toEqual([]);
    const socket = await lstat(join(dir, "inst1", "g1.sock"));
    expect(socket.isSocket()).toBe(true);
    expect(socket.mode & 0o777).toBe(0o600);
    await app.request("/reset", { method: "POST" });
  });

  test("the .pub file holds the public key line with mode 600, and DELETE and reset remove it", async () => {
    const app = router();
    expect((await post(app, grantBody())).status).toBe(200);
    const pub = join(dir, "inst1", "g1.pub");
    expect(await readFile(pub, "utf8")).toBe(`ssh-ed25519 ${PUBLIC_KEY}\n`);
    expect((await stat(pub)).mode & 0o777).toBe(0o600);
    expect((await app.request("/grants/g1", { method: "DELETE" })).status).toBe(204);
    expect(await Bun.file(pub).exists()).toBe(false);

    expect((await post(app, grantBody({ grantId: "g2" }))).status).toBe(200);
    expect(await Bun.file(join(dir, "inst1", "g2.pub")).exists()).toBe(true);
    expect((await app.request("/reset", { method: "POST" })).status).toBe(204);
    expect(await Bun.file(join(dir, "inst1", "g2.pub")).exists()).toBe(false);
  });
});

describe("the safe file helpers", () => {
  test("createPrivateFile replaces a planted link with a new file of mode 600", async () => {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "x.config");
    await symlink(victim, path);
    await createPrivateFile(path, "text\n", OWNER, chown);
    await victimUnchanged();
    expect(await readFile(path, "utf8")).toBe("text\n");
    expect((await lstat(path)).isSymbolicLink()).toBe(false);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("a link that comes back between the unlink and the open is a clean 409 and the victim stays", async () => {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "x.config");
    await symlink(victim, path);
    const error = await rejection(writeNewFile(path, "text\n"));
    expect(error.message).toContain("appeared");
    expect((error as Error & { status?: number }).status).toBe(409);
    await victimUnchanged();
  });
});

describe("the control socket never follows a link in the instance folder", () => {
  function control(overrides: Partial<ConstructorParameters<typeof SshControl>[0]> = {}) {
    return new SshControl({
      dir,
      instanceId: "inst1",
      ...OWNER,
      chown,
      targets: () => [],
      request: () => Promise.reject(new Error("no")),
      ...overrides,
    });
  }

  test("a link planted at control.sock leaves the victim unchanged and the socket has mode 600", async () => {
    await mkdir(join(dir, "inst1"), { recursive: true, mode: 0o700 });
    const planted = join(dir, "inst1", "control.sock");
    await symlink(victim, planted);
    const opened = control();
    expect(await opened.start()).toBe(planted);
    await victimUnchanged();
    const socket = await lstat(planted);
    expect(socket.isSocket()).toBe(true);
    expect(socket.mode & 0o777).toBe(0o600);
    await opened.stop();
    expect(await Bun.file(planted).exists()).toBe(false);
  });

  test("the socket is chowned in the staging folder, which has mode 700 and is never chowned", async () => {
    const opened = control();
    await opened.start();
    const stage = join(dir, ".stage");
    expect((await stat(stage)).mode & 0o777).toBe(0o700);
    expect(chowns).not.toContain(stage);
    expect(chowns.filter((path) => path.startsWith(join(dir, "inst1")))).toEqual([join(dir, "inst1")]);
    expect(chowns.some((path) => path.startsWith(`${stage}/`) && path.endsWith(".sock"))).toBe(true);
    expect(await readdir(stage)).toEqual([]);
    await opened.stop();
  });

  test("a failed chown after listen leaves no listener and no file, and a new start works", async () => {
    let fail = true;
    const opened = control({
      chown: (path) => {
        chowns.push(path);
        return path.endsWith(".sock") && fail ? Promise.reject(new Error("chown broke")) : Promise.resolve();
      },
    });
    expect((await rejection(opened.start())).message).toBe("chown broke");
    expect(await readdir(join(dir, ".stage"))).toEqual([]);
    expect(await Bun.file(join(dir, "inst1", "control.sock")).exists()).toBe(false);
    fail = false;
    expect(await opened.start()).toBe(join(dir, "inst1", "control.sock"));
    await opened.stop();
  });
});

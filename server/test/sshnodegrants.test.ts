import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SOCKET_PATH } from "../src/sshfiles";
import { LinuxGrantPlatform, WindowsGrantPlatform } from "../src/sshgrantplatform";
import type { ClientStatus, GrantPlatform, GrantSetup, Owner } from "../src/sshgrantplatform";
import type { GrantAgentOptions } from "../src/sshnodeagent";
import type { AccessResult } from "../src/sshnodeapi";
import { NO_WAITING_REQUEST, NodeGrantError, NodeGrantManager } from "../src/sshnodegrants";
import type { GrantBroker, GrantRequest } from "../src/sshnodegrants";
import { PendingSigns } from "../src/sshnodesigns";
import { NodeEvents } from "../src/hosts/NodeEvents";
import type { NodeEvent } from "../src/hosts/NodeEvents";

const BLOB = new Uint8Array(51).fill(1);
const HOST_KEY = "ssh-ed25519 AAAA";

function request(overrides: Partial<GrantRequest> = {}): GrantRequest {
  return {
    grantId: "g1",
    instanceId: "inst1",
    targetId: "web1",
    publicBlob: BLOB,
    address: "10.0.0.5",
    port: 22,
    account: "deploy",
    hostKey: HOST_KEY,
    endsAt: 1_900_000_000_000,
    ...overrides,
  };
}

/** A platform that makes plain folders and records what it was asked. */
class FakePlatform implements GrantPlatform {
  windows = false;
  fits = true;
  setup: GrantSetup = { ok: true };
  failWriteOf: string | undefined;
  prepared: string[] = [];

  socketFits(): boolean {
    return this.fits;
  }

  clientStatus(): Promise<ClientStatus> {
    return Promise.resolve({ ssh: false, reason: "no client" });
  }

  async prepare(folder: string): Promise<GrantSetup> {
    this.prepared.push(folder);
    if (this.setup.ok) await mkdir(folder, { recursive: true });
    return this.setup;
  }

  transport(): undefined {
    return undefined;
  }

  async writePrivate(path: string, text: string, _owner?: Owner): Promise<void> {
    if (this.failWriteOf && path.endsWith(this.failWriteOf)) throw new Error("disk full");
    await writeFile(path, text);
  }
}

/** An agent that makes its socket file as a plain file. */
class FakeAgent {
  stopped = false;
  constructor(
    readonly options: GrantAgentOptions,
    private readonly failStart: boolean,
  ) {}

  async start(): Promise<string> {
    if (this.failStart) throw new Error("no socket");
    const socket = join(this.options.dir, `${this.options.grantId}.sock`);
    await writeFile(socket, "");
    return socket;
  }

  stop(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }
}

class FakeBroker implements GrantBroker {
  waiting = new Set<string>();
  activated: { requestId: string; result: AccessResult }[] = [];
  /** The request ends while the agent starts. */
  endOnActivate = false;

  isWaiting(requestId: string): boolean {
    return this.waiting.has(requestId);
  }

  activate(requestId: string, result: AccessResult): boolean {
    if (this.endOnActivate) return false;
    this.activated.push({ requestId, result });
    return true;
  }
}

let dir: string;
let platform: FakePlatform;
let broker: FakeBroker;
let events: NodeEvents;
let seen: NodeEvent[];
let agents: FakeAgent[];
let failStart: boolean;
let probed: { config: string; targetId: string }[];

function manager(signTimeoutMs = 1000): NodeGrantManager {
  return new NodeGrantManager({
    dir,
    broker,
    signs: new PendingSigns(events, signTimeoutMs),
    platform,
    probe: (config, targetId) => {
      probed.push({ config, targetId });
      return Promise.resolve({ code: 0, stderr: "" });
    },
    signTimeoutMs,
    createAgent: (options) => {
      const agent = new FakeAgent(options, failStart);
      agents.push(agent);
      return agent;
    },
  });
}

async function status(work: Promise<unknown>): Promise<{ status: number; message: string }> {
  const error = await work.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(NodeGrantError);
  return { status: (error as NodeGrantError).status, message: (error as NodeGrantError).message };
}

async function refusal(work: Promise<unknown> | undefined): Promise<Error> {
  try {
    await work;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }

  throw new Error("the work was not refused");
}

/** The sign event of the first sign request, after the agent asked. */
function signIdOf(index = 0): string {
  const event = seen.filter((item) => item.type === "ssh.sign")[index] as { signId: string } | undefined;
  if (!event) throw new Error("no sign event");
  return event.signId;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nodegrants-"));
  platform = new FakePlatform();
  broker = new FakeBroker();
  events = new NodeEvents();
  seen = [];
  events.subscribe((event) => seen.push(event));
  agents = [];
  failStart = false;
  probed = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("NodeGrantManager.open", () => {
  test("starts the agent and writes the three files in the folder of the instance", async () => {
    const result = await manager().open(request());
    const folder = join(dir, "inst1");

    expect(result).toEqual({
      socket: join(folder, "g1.sock"),
      config: join(folder, "g1.config"),
      endsAt: 1_900_000_000_000,
    });
    expect((await readdir(folder)).sort()).toEqual(["g1.config", "g1.known_hosts", "g1.pub", "g1.sock"]);
    expect(agents[0]?.options.comment).toBe("claude-rc:web1");
    expect(agents[0]?.options.topDir).toBe(dir);
  });

  test("a socket path that does not fit is a 400 before any other check", async () => {
    platform.fits = false;
    const grants = manager();

    expect(await status(grants.open(request({ requestId: "gone" })))).toEqual({
      status: 400,
      message: `the socket path is longer than ${MAX_SOCKET_PATH} bytes`,
    });
    expect(platform.prepared).toEqual([]);
  });

  test("a second grant with the same id is a 409", async () => {
    const grants = manager();
    await grants.open(request());

    expect(await status(grants.open(request()))).toEqual({ status: 409, message: "a grant with that id exists" });
  });

  test("an answer to a request that no longer waits is a 409 and starts nothing", async () => {
    expect(await status(manager().open(request({ requestId: "r1" })))).toEqual({
      status: 409,
      message: NO_WAITING_REQUEST,
    });
    expect(platform.prepared).toEqual([]);
    expect(agents).toEqual([]);
  });

  test("a platform that refuses is a 409 with its reason, and no agent starts", async () => {
    platform.setup = { ok: false, reason: "no ssh.exe" };

    expect(await status(manager().open(request()))).toEqual({ status: 409, message: "no ssh.exe" });
    expect(agents).toEqual([]);
  });

  test("a failed start removes the grant and throws the error on", async () => {
    failStart = true;
    const grants = manager();

    expect((await refusal(grants.open(request()))).message).toBe("no socket");
    expect(agents[0]?.stopped).toBe(true);

    failStart = false;
    // The id is free again.
    await grants.open(request());
  });

  test("a failed write removes the files that were written", async () => {
    platform.failWriteOf = ".config";
    const grants = manager();

    expect((await refusal(grants.open(request()))).message).toBe("disk full");
    expect(agents[0]?.stopped).toBe(true);
    expect(await readdir(join(dir, "inst1"))).toEqual([]);
  });

  test("a request that ends while the agent starts is a 409, and the grant is removed", async () => {
    broker.waiting.add("r1");
    broker.endOnActivate = true;

    expect(await status(manager().open(request({ requestId: "r1" })))).toEqual({
      status: 409,
      message: NO_WAITING_REQUEST,
    });
    expect(agents[0]?.stopped).toBe(true);
    expect(await readdir(join(dir, "inst1"))).toEqual([]);
  });

  test("a waiting request is activated with the result", async () => {
    broker.waiting.add("r1");
    const result = await manager().open(request({ requestId: "r1" }));

    expect(broker.activated).toEqual([{ requestId: "r1", result }]);
  });

  test("the result names the ssh program of a platform that has one", async () => {
    platform.setup = { ok: true, sshPath: "C:\\ssh.exe" };
    expect((await manager().open(request())).ssh).toBe("C:\\ssh.exe");
  });
});

describe("NodeGrantManager signs", () => {
  test("a sign request that gets no answer fails", async () => {
    await manager(20).open(request());
    const signing = agents[0]?.options.forwardSign(new Uint8Array(1), new Uint8Array(1), 0);

    expect((await refusal(signing)).message).toBe("no signature from the hub");
  });

  test("settleSign is a 404 for an unknown id before it checks the signature", () => {
    const grants = manager();
    expect(() => {
      grants.settleSign("nope", { signature: new Uint8Array(3) });
    }).toThrow(new NodeGrantError(404, "no such sign request"));
  });

  test("settleSign is a 400 for a signature that is not 64 bytes, and the request still waits", async () => {
    const grants = manager();
    await grants.open(request());
    const signing = agents[0]?.options.forwardSign(new Uint8Array(1), new Uint8Array(1), 0);

    expect(() => {
      grants.settleSign(signIdOf(), { signature: new Uint8Array(3) });
    }).toThrow("signature must be 64 bytes in base64");
    grants.settleSign(signIdOf(), { signature: new Uint8Array(64).fill(9) });
    expect(await signing).toEqual(new Uint8Array(64).fill(9));
  });

  test("settleSign with an error fails the request with that reason", async () => {
    const grants = manager();
    await grants.open(request());
    const signing = agents[0]?.options.forwardSign(new Uint8Array(1), new Uint8Array(1), 0);

    grants.settleSign(signIdOf(), { error: "locked" });
    expect((await refusal(signing)).message).toBe("locked");
  });

  test("close fails the sign requests of that grant only", async () => {
    const grants = manager();
    await grants.open(request());
    await grants.open(request({ grantId: "g2" }));
    const first = agents[0]?.options.forwardSign(new Uint8Array(1), new Uint8Array(1), 0);
    const second = agents[1]?.options.forwardSign(new Uint8Array(1), new Uint8Array(1), 0);

    const firstFails = refusal(first);
    await grants.close("g1");
    expect((await firstFails).message).toBe("the grant ended");
    grants.settleSign(signIdOf(1), { signature: new Uint8Array(64) });
    expect(await second).toEqual(new Uint8Array(64));
  });

  test("reset fails every sign request with the reset reason and ends every grant", async () => {
    const grants = manager();
    await grants.open(request());
    await grants.open(request({ grantId: "g2", instanceId: "inst2" }));
    const signing = agents[0]?.options.forwardSign(new Uint8Array(1), new Uint8Array(1), 0);

    const signingFails = refusal(signing);
    await grants.reset();
    expect((await signingFails).message).toBe("the node was reset");
    expect(agents.every((agent) => agent.stopped)).toBe(true);
    expect(await readdir(join(dir, "inst1"))).toEqual([]);
    expect(await readdir(join(dir, "inst2"))).toEqual([]);
  });
});

describe("NodeGrantManager.probe and status", () => {
  test("probe runs with the config file of the grant, and is a 404 for an unknown grant", async () => {
    const grants = manager();
    await grants.open(request());

    expect(await grants.probe("g1")).toEqual({ code: 0, stderr: "" });
    expect(probed).toEqual([{ config: join(dir, "inst1", "g1.config"), targetId: "web1" }]);
    expect(await status(grants.probe("g2"))).toEqual({ status: 404, message: "no such grant" });
  });

  test("status makes the top folder with mode 711 and adds the reason of the platform", async () => {
    expect(await manager().status()).toEqual({ ssh: false, dir: true, reason: "no client" });
    expect((await stat(dir)).mode & 0o777).toBe(0o711);
  });
});

describe("grant platforms", () => {
  test("Linux resolves the owner, makes the folders with modes 711 and 700 and chowns the instance folder", async () => {
    const chowned: string[] = [];
    const linux = new LinuxGrantPlatform({
      dir,
      resolveUser: () => ({ uid: 1001, gid: 1002 }),
      chown: (path, uid, gid) => {
        chowned.push(`${path} ${uid}:${gid}`);
        return Promise.resolve();
      },
    });
    const folder = join(dir, "inst1");

    expect(await linux.prepare(folder, "inst1")).toEqual({ ok: true, owner: { uid: 1001, gid: 1002 } });
    expect((await stat(dir)).mode & 0o777).toBe(0o711);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    expect(chowned).toEqual([`${folder} 1001:1002`]);
  });

  test("Linux refuses a socket path over the limit", () => {
    const linux = new LinuxGrantPlatform({ dir });
    expect(linux.socketFits(join(dir, "a.sock"))).toBe(true);
    expect(linux.socketFits(join(dir, "x".repeat(200)))).toBe(false);
  });

  test("Windows checks the client before it sets any access list", async () => {
    const icacls: string[][] = [];
    const windows = new WindowsGrantPlatform("C:\\grants", {
      sid: "S-1-5-21-1",
      checkClient: () => Promise.resolve({ ok: false, reason: "no ssh.exe" }),
      agentTransport: () => {
        throw new Error("not used");
      },
      runIcacls: (args) => {
        icacls.push(args);
        return Promise.resolve({ code: 0, output: "" });
      },
    });

    expect(await windows.prepare("C:\\grants\\inst1")).toEqual({ ok: false, reason: "no ssh.exe" });
    expect(icacls).toEqual([]);
    expect(windows.socketFits()).toBe(true);
    expect(await windows.clientStatus()).toEqual({ ssh: false, reason: "no ssh.exe" });
  });
});

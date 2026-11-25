import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeApp, onError } from "../src/app";
import type { Config } from "../src/config";
import type { Instances } from "../src/instances";
import {
  FrameReader,
  failureAnswer,
  identitiesAnswer,
  keyFingerprint,
  publicKeyBlob,
  signAnswer,
} from "../src/sshagentproto";
import { SshBroker, grantConfig, knownHostsLine, sshNodeApi, unsupportedSshApi } from "../src/sshnodeapi";
import type { SshNodeOptions } from "../src/sshnodeapi";
import { HOST_KEY_RE } from "../src/sshtargets";
import { NodeEvents } from "../src/updateevents";
import type { NodeEvent } from "../src/updateevents";

function noop(): void {
  // The test ignores socket errors.
}

const cfg = { mode: "node", name: "pi", roots: ["/srv"] } as unknown as Config;
const instances = { list: () => Promise.resolve([]) } as unknown as Instances;

const auth: MiddlewareHandler = async (context, next) => {
  if (context.req.header("authorization") !== "Bearer ok") return context.json({ error: "unauthorized" }, 401);
  await next();
};

const headers = { authorization: "Bearer ok", "content-type": "application/json" };

const RAW_KEY = new Uint8Array(32).fill(7);
const BLOB = publicKeyBlob(RAW_KEY);
const PUBLIC_KEY = Buffer.from(BLOB).toString("base64");
const HOST_KEY = `ssh-ed25519 ${Buffer.from(publicKeyBlob(new Uint8Array(32).fill(3))).toString("base64")}`;
const SIGNATURE = new Uint8Array(64).fill(9);

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

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

function join32(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;

  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }

  return out;
}

function str(bytes: Uint8Array): Uint8Array {
  return join32(u32(bytes.length), bytes);
}

function framed(...parts: Uint8Array[]): Uint8Array {
  const payload = join32(...parts);
  return join32(u32(payload.length), payload);
}

/** Sends one request to a socket and returns the payload of the answer. */
async function ask(path: string, request: Uint8Array): Promise<Uint8Array> {
  const reader = new FrameReader();

  return new Promise<Uint8Array>((resolve, reject) => {
    void Bun.connect({
      unix: path,
      socket: {
        open(socket) {
          socket.write(request);
        },
        data(socket, chunk) {
          const [payload] = reader.push(new Uint8Array(chunk));

          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- an empty list gives undefined
          if (payload) {
            resolve(payload);
            socket.end();
          }
        },
        close() {
          reject(new Error("closed without an answer"));
        },
        error: noop,
      },
    });
  });
}

const IDENTITIES_REQUEST = framed(Uint8Array.of(11));
const signRequest = (data: Uint8Array) => framed(Uint8Array.of(13), str(BLOB), str(data), u32(0));
const payloadOf = (answer: Uint8Array) => answer.slice(4);

let dir: string;
let events: NodeEvents;
let seen: NodeEvent[];
let broker: SshBroker;
let app: ReturnType<typeof createNodeApp>;
let probes: { config: string; targetId: string }[];
let extra: Partial<SshNodeOptions>;

function build(): void {
  app = createNodeApp({
    cfg,
    instances,
    auth,
    events,
    ssh: { dir, events, broker, signTimeoutMs: 300, ...extra },
  });
}

const call = (method: string, path: string, body?: unknown) =>
  app.request(`/api/ssh${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function createGrant(overrides: Record<string, unknown> = {}): Promise<{ socket: string; config: string }> {
  const response = await call("POST", "/grants", grantBody(overrides));
  expect(response.status).toBe(200);
  return (await response.json()) as { socket: string; config: string };
}

const nextSign = (): Promise<Extract<NodeEvent, { type: "ssh.sign" }>> =>
  new Promise((resolve) => {
    const found = seen.find((event) => event.type === "ssh.sign");

    if (found?.type === "ssh.sign") {
      resolve(found);
      return;
    }

    const off = events.subscribe((event) => {
      if (event.type !== "ssh.sign") return;
      off();
      resolve(event);
    });
  });

const realLog = console.log;

beforeEach(async () => {
  // The node app writes an audit line for each write request.
  console.log = noop;
  dir = join(await mkdtemp(join(tmpdir(), "sshapi-")), "ssh");
  events = new NodeEvents();
  seen = [];
  events.subscribe((event) => seen.push(event));
  broker = new SshBroker({ events });
  probes = [];
  extra = {
    probe: (config, targetId) => {
      probes.push({ config, targetId });
      return Promise.resolve({ code: 255, stderr: "Permission denied" });
    },
    keyscan: () => Promise.resolve([HOST_KEY]),
  };
  build();
});

afterEach(async () => {
  await call("POST", "/reset");
  console.log = realLog;
  await rm(join(dir, ".."), { recursive: true, force: true });
});

describe("ssh node routes", () => {
  test("the routes sit behind the node auth", async () => {
    const response = await app.request("/api/ssh/status");
    expect(response.status).toBe(401);
  });

  test("GET /status tells about the ssh program and the folder", async () => {
    const body = (await (await call("GET", "/status")).json()) as { ssh: boolean; dir: boolean };
    expect(typeof body.ssh).toBe("boolean");
    expect(body.dir).toBe(true);
  });

  test("POST /grants returns a socket path that answers identities", async () => {
    const { socket } = await createGrant();
    expect(socket).toBe(join(dir, "inst1", "g1.sock"));
    expect(await ask(socket, IDENTITIES_REQUEST)).toEqual(
      payloadOf(identitiesAnswer([{ blob: BLOB, comment: "claude-rc:web1" }])),
    );
  });

  test("POST /grants writes a config with the lines above and StrictHostKeyChecking yes", async () => {
    const { socket, config } = await createGrant();
    expect(config).toBe(join(dir, "inst1", "g1.config"));
    const text = await readFile(config, "utf8");
    expect(text).toContain("StrictHostKeyChecking yes\n");
    expect(text.trimEnd().split("\n")).toEqual([
      "Host web1",
      "HostName 10.0.0.5",
      "Port 22",
      "User deploy",
      `IdentityAgent ${socket}`,
      `IdentityFile ${join(dir, "inst1", "g1.pub")}`,
      "IdentitiesOnly yes",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      `UserKnownHostsFile ${join(dir, "inst1", "g1.known_hosts")}`,
      "GlobalKnownHostsFile /dev/null",
      "StrictHostKeyChecking yes",
      "ControlMaster no",
      "ControlPath none",
    ]);
    expect(await readFile(join(dir, "inst1", "g1.known_hosts"), "utf8")).toBe(`10.0.0.5 ${HOST_KEY}\n`);
  });

  test("a known_hosts line for a port other than 22 uses the [host]:port form", async () => {
    await createGrant({ port: 2222 });
    expect(await readFile(join(dir, "inst1", "g1.known_hosts"), "utf8")).toBe(`[10.0.0.5]:2222 ${HOST_KEY}\n`);
    expect(knownHostsLine("h", 22, "k")).toBe("h k\n");
    expect(
      grantConfig({
        targetId: "t",
        address: "a",
        port: 1,
        account: "u",
        socket: "/s",
        identity: "/i",
        knownHosts: "/k",
      }),
    ).toContain("Port 1\n");
  });

  test("the folder has mode 700 and the files and the socket have mode 600", async () => {
    await createGrant();
    expect((await stat(join(dir, "inst1"))).mode & 0o777).toBe(0o700);
    expect((await stat(dir)).mode & 0o777).toBe(0o711);

    for (const name of ["g1.config", "g1.known_hosts", "g1.sock"])
      expect((await stat(join(dir, "inst1", name))).mode & 0o777).toBe(0o600);
  });

  test("DELETE /grants removes the socket and both files", async () => {
    const { socket, config } = await createGrant();
    const knownHosts = join(dir, "inst1", "g1.known_hosts");
    expect((await call("DELETE", "/grants/g1")).status).toBe(204);

    for (const path of [socket, config, knownHosts]) expect(await exists(path)).toBe(false);
    expect((await call("DELETE", "/grants/g1")).status).toBe(204);
  });

  test("DELETE /grants with an unsafe id is refused", async () => {
    expect((await call("DELETE", "/grants/..%2Fx")).status).toBe(400);
  });

  test("a second grant with the same id gives 409", async () => {
    await createGrant();
    expect((await call("POST", "/grants", grantBody())).status).toBe(409);
  });

  test("a sign request emits one ssh.sign event and waits for sign-result", async () => {
    const { socket } = await createGrant();
    const data = new Uint8Array([1, 2, 3, 4]);
    const answer = ask(socket, signRequest(data));
    const event = await nextSign();
    expect(seen.filter((item) => item.type === "ssh.sign")).toHaveLength(1);
    expect(event.grantId).toBe("g1");
    expect(event.keyBlob).toBe(PUBLIC_KEY);
    expect(event.data).toBe(Buffer.from(data).toString("base64"));
    expect(event.flags).toBe(0);

    const result = await call("POST", "/sign-result", {
      signId: event.signId,
      signature: Buffer.from(SIGNATURE).toString("base64"),
    });
    expect(result.status).toBe(204);
    expect(await answer).toEqual(payloadOf(signAnswer(SIGNATURE)));
  });

  test("sign-result with an error gives the ssh client a failure", async () => {
    const { socket } = await createGrant();
    const answer = ask(socket, signRequest(new Uint8Array([1])));
    const event = await nextSign();
    await call("POST", "/sign-result", { signId: event.signId, error: "denied" });
    expect(await answer).toEqual(payloadOf(failureAnswer()));
  });

  test("a sign request that gets no result fails after the timeout", async () => {
    const { socket } = await createGrant();
    expect(await ask(socket, signRequest(new Uint8Array([1])))).toEqual(payloadOf(failureAnswer()));
    const event = await nextSign();
    // The wait is over: the late result finds nothing.
    const late = await call("POST", "/sign-result", {
      signId: event.signId,
      signature: Buffer.from(SIGNATURE).toString("base64"),
    });
    expect(late.status).toBe(404);
  });

  test("an unknown signId in sign-result gives 404", async () => {
    expect((await call("POST", "/sign-result", { signId: "nope", error: "x" })).status).toBe(404);
  });

  test("a signature of the wrong length gives 400 and leaves the request waiting", async () => {
    const { socket } = await createGrant();
    const answer = ask(socket, signRequest(new Uint8Array([1])));
    const event = await nextSign();
    const bad = await call("POST", "/sign-result", { signId: event.signId, signature: "AAAA" });
    expect(bad.status).toBe(400);
    await call("POST", "/sign-result", { signId: event.signId, error: "x" });
    expect(await answer).toEqual(payloadOf(failureAnswer()));
  });

  test("reset stops every agent", async () => {
    const first = await createGrant();
    const second = await createGrant({ grantId: "g2" });
    expect((await call("POST", "/reset")).status).toBe(204);

    for (const path of [first.socket, second.socket, first.config, second.config])
      expect(await exists(path)).toBe(false);
  });

  test("POST /grants with a requestId resolves the waiting broker request", async () => {
    const waiting = broker.request({ instanceId: "inst1", targetId: "web1", minutes: 5, reason: "deploy" });
    const request = seen.find((event) => event.type === "ssh.request");
    expect(request).toMatchObject({ instanceId: "inst1", targetId: "web1", minutes: 5, reason: "deploy" });
    const { requestId } = request as { requestId: string };
    const created = await createGrant({ requestId });
    expect(await waiting).toEqual({ socket: created.socket, config: created.config, endsAt: 1_900_000_000_000 });
  });

  test("POST /grants with a requestId that no request waits for gives 409 and starts no agent", async () => {
    const response = await call("POST", "/grants", grantBody({ requestId: "gone" }));
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe("no request waits for this answer");
    expect(await exists(join(dir, "inst1", "g1.sock"))).toBe(false);
    expect(await exists(join(dir, "inst1", "g1.config"))).toBe(false);
  });

  test("a request that ends while the agent starts gives 409 and the grant is removed", async () => {
    const waiting = broker.request({ instanceId: "inst1", targetId: "web1" });
    waiting.catch(noop);
    const { requestId } = seen.find((event) => event.type === "ssh.request") as { requestId: string };
    // The request ends between the check and the answer (a timeout, for example).
    broker.activate = () => false;
    const response = await call("POST", "/grants", grantBody({ requestId }));
    expect(response.status).toBe(409);
    for (const suffix of [".sock", ".config", ".known_hosts", ".pub"])
      expect(await exists(join(dir, "inst1", `g1${suffix}`))).toBe(false);
    expect((await call("POST", "/grants", grantBody())).status).toBe(200);
  });

  test("POST /requests/:id/reject makes the waiting request fail with the reason", async () => {
    const waiting = broker.request({ instanceId: "inst1", targetId: "web1" });
    const caught = waiting.catch((error: unknown) => error);
    const { requestId } = seen.find((event) => event.type === "ssh.request") as { requestId: string };
    expect((await call("POST", `/requests/${requestId}/reject`, { reason: "not now" })).status).toBe(204);
    expect(((await caught) as Error).message).toBe("not now");
  });

  test("a broker request with no answer fails after requestTimeoutMs", async () => {
    const quick = new SshBroker({ events, requestTimeoutMs: 20 });
    const error = await quick.request({ instanceId: "inst1", targetId: "web1" }).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe("no answer from the hub");
  });

  test("PUT /targets sets the list that broker.targets returns", async () => {
    const targets = [{ id: "web1", account: "deploy", address: "10.0.0.5" }];
    expect((await call("PUT", "/targets", { targets })).status).toBe(204);
    expect(broker.targets()).toEqual(targets);
    expect((await call("PUT", "/targets", { targets: [{ id: "Bad Id", account: "a", address: "b" }] })).status).toBe(
      400,
    );
  });

  test("POST /grants/:id/probe returns the exit code and the stderr of the probe", async () => {
    const { config } = await createGrant();
    const response = await call("POST", "/grants/g1/probe", {});
    expect(await response.json()).toEqual({ code: 255, stderr: "Permission denied" });
    expect(probes).toEqual([{ config, targetId: "web1" }]);
    expect((await call("POST", "/grants/none/probe", {})).status).toBe(404);
  });

  test("scan returns the fingerprint of each key line", async () => {
    const response = await call("POST", "/scan", { address: "10.0.0.5", port: 22 });
    const [, key] = HOST_KEY.split(" ");
    expect(await response.json()).toEqual({
      keys: [{ line: HOST_KEY, fingerprint: keyFingerprint(new Uint8Array(Buffer.from(key, "base64"))) }],
    });
    expect((await call("POST", "/scan", { address: "-oProxyCommand=x", port: 22 })).status).toBe(400);
    expect((await call("POST", "/scan", { address: "h", port: 0 })).status).toBe(400);
  });

  test("a Windows node answers 501", async () => {
    // The Windows node passes no `ssh` option to createNodeApp, so every route under /ssh is the unsupported router.
    const windows = createNodeApp({ cfg, instances, auth });
    const response = await windows.request("/api/ssh/status", { headers });
    expect(response.status).toBe(501);
    const post = await windows.request("/api/ssh/grants", { method: "POST", headers, body: "{}" });
    expect(post.status).toBe(501);
    const direct = unsupportedSshApi().onError(onError);
    expect((await direct.request("/grants/x", { method: "DELETE" })).status).toBe(501);
  });
});

describe("ssh node routes: one folder for each instance", () => {
  test("two grants for two instances get two folders with mode 700, and the top folder is never chowned", async () => {
    const chowned: string[] = [];
    extra = {
      ...extra,
      chown: (path) => {
        chowned.push(path);
        return Promise.resolve();
      },
      resolveUser: (instanceId) => (instanceId === "alice" ? { uid: 1001, gid: 1001 } : { uid: 1002, gid: 1002 }),
    };
    build();
    const first = await createGrant({ grantId: "ga", instanceId: "alice" });
    const second = await createGrant({ grantId: "gb", instanceId: "bob" });
    expect(first.socket).toBe(join(dir, "alice", "ga.sock"));
    expect(second.socket).toBe(join(dir, "bob", "gb.sock"));
    expect((await stat(join(dir, "alice"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, "bob"))).mode & 0o777).toBe(0o700);
    expect(chowned).toContain(join(dir, "alice"));
    expect(chowned).toContain(join(dir, "bob"));
    expect(chowned).not.toContain(dir);
  });

  test("DELETE removes the files of the right folder only", async () => {
    const first = await createGrant({ grantId: "ga", instanceId: "alice" });
    const second = await createGrant({ grantId: "gb", instanceId: "bob" });
    await call("DELETE", "/grants/ga");
    expect(await exists(first.config)).toBe(false);
    expect(await exists(first.socket)).toBe(false);
    expect(await exists(second.config)).toBe(true);
    expect(await exists(join(dir, "alice"))).toBe(true);
    await call("POST", "/reset");
    expect(await exists(second.config)).toBe(false);
    expect(await exists(join(dir, "bob"))).toBe(true);
  });

  test("an instance id that is a path gives 400", async () => {
    expect((await call("POST", "/grants", grantBody({ instanceId: ".." }))).status).toBe(400);
  });
});

describe("ssh node routes: validation", () => {
  test("a socket path longer than 100 bytes gives 400", async () => {
    const longDir = join(dir, "d".repeat(75));
    app = createNodeApp({ cfg, instances, auth, ssh: { dir: longDir, events, broker } });
    const refused = await call("POST", "/grants", grantBody());
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain("100 bytes");
    expect(await exists(longDir)).toBe(false);
    build();
  });

  const fields = ["grantId", "requestId", "instanceId", "targetId", "address", "account", "hostKey"];

  for (const field of fields) {
    test(`a newline in ${field} gives 400 and writes no file`, async () => {
      const value = field === "hostKey" ? `${HOST_KEY}\nattacker ${HOST_KEY}` : "a\nStrictHostKeyChecking no";
      const response = await call("POST", "/grants", grantBody({ [field]: value }));
      expect(response.status).toBe(400);
      expect(await exists(join(dir, "inst1", "g1.config"))).toBe(false);
      expect(await exists(join(dir, "inst1", "g1.known_hosts"))).toBe(false);
    });
  }

  test("a host key that the hub can pin is accepted: the hub and the node share one pattern", async () => {
    const hostKey = `Sk_Ssh-Ed25519@OpenSSH.com ${HOST_KEY.split(" ")[1] ?? ""}`;
    expect(HOST_KEY_RE.test(hostKey)).toBe(true);
    expect((await call("POST", "/grants", grantBody({ hostKey }))).status).toBe(200);
    expect(
      (await call("POST", "/grants", grantBody({ grantId: "g2", hostKey: `${"a".repeat(65)} AAAA` }))).status,
    ).toBe(400);
  });

  test("a NUL in a text field gives 400", async () => {
    for (const field of ["address", "account", "hostKey"])
      expect((await call("POST", "/grants", grantBody({ [field]: "a\0b" }))).status).toBe(400);
  });

  test("a bad target id, port, key or time gives 400", async () => {
    for (const overrides of [
      { targetId: "Web 1" },
      { targetId: "-web" },
      { port: 0 },
      { port: 65536 },
      { port: "22" },
      { port: 22.5 },
      { publicKey: "AAAA" },
      { publicKey: 5 },
      { endsAt: "soon" },
      { address: "-oProxyCommand=x" },
      { address: "a b" },
      { grantId: "../x" },
    ])
      expect((await call("POST", "/grants", grantBody(overrides))).status).toBe(400);
  });

  test("a body that is not JSON gives 400 and a request without the JSON type gives 415", async () => {
    const bad = await app.request("/api/ssh/grants", { method: "POST", headers, body: "{" });
    expect(bad.status).toBe(400);
    const plain = await app.request("/api/ssh/grants", {
      method: "POST",
      headers: { authorization: "Bearer ok" },
      body: "{}",
    });
    expect(plain.status).toBe(415);
  });
});

describe("sshNodeApi alone", () => {
  test("the router is usable without createNodeApp", async () => {
    const router = sshNodeApi({ dir, events, broker });
    const response = await router.request("/status");
    expect(response.status).toBe(200);
  });
});

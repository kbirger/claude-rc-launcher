import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FrameReader,
  MAX_FRAME,
  failureAnswer,
  identitiesAnswer,
  publicKeyBlob,
  publicKeyLine,
  signAnswer,
} from "../src/sshagentproto";
import { GrantAgent } from "../src/sshnodeagent";

function noop(): void {
  // The test ignores socket errors.
}

const RAW_KEY = new Uint8Array(32).fill(7);
const BLOB = publicKeyBlob(RAW_KEY);
const COMMENT = "claude-rc:web1";
const SIGNATURE = new Uint8Array(64).fill(9);

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

function signRequest(blob: Uint8Array, data: Uint8Array, flags = 0): Uint8Array {
  return framed(Uint8Array.of(13), str(blob), str(data), u32(flags));
}

const IDENTITIES_REQUEST = framed(Uint8Array.of(11));

interface Client {
  /** Resolves with the next complete frame payload, or null when the connection closes first. */
  next(): Promise<Uint8Array | null>;
  send(bytes: Uint8Array): void;
  end(): void;
  closed: Promise<void>;
}

async function connect(path: string): Promise<Client> {
  const reader = new FrameReader();
  const frames: Uint8Array[] = [];
  const waiting: ((value: Uint8Array | null) => void)[] = [];
  let isClosed = false;

  let onClosed: () => void = () => {};

  const closed = new Promise<void>((resolve) => {
    onClosed = resolve;
  });

  const socket = await Bun.connect({
    unix: path,
    socket: {
      data(_socket, chunk) {
        for (const payload of reader.push(new Uint8Array(chunk))) {
          const waiter = waiting.shift();
          if (waiter) waiter(payload);
          else frames.push(payload);
        }
      },
      close() {
        isClosed = true;
        for (const waiter of waiting.splice(0)) waiter(null);
        onClosed();
      },
      error: noop,
    },
  });

  return {
    next() {
      const ready = frames.shift();
      if (ready) return Promise.resolve(ready);
      if (isClosed) return Promise.resolve(null);
      return new Promise((resolve) => waiting.push(resolve));
    },
    send(bytes) {
      socket.write(bytes);
    },
    end() {
      socket.end();
    },
    closed,
  };
}

function payloadOf(answer: Uint8Array): Uint8Array {
  return answer.slice(4);
}

let dir: string;
let agent: GrantAgent | undefined;
let calls: { keyBlob: Uint8Array; data: Uint8Array; flags: number }[];

function makeAgent(
  forwardSign: (keyBlob: Uint8Array, data: Uint8Array, flags: number) => Promise<Uint8Array>,
  signTimeoutMs?: number,
): GrantAgent {
  agent = new GrantAgent({ dir, grantId: "g1", publicBlob: BLOB, comment: COMMENT, forwardSign, signTimeoutMs });
  return agent;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sshnodeagent-"));
  calls = [];
});

afterEach(async () => {
  await agent?.stop();
  agent = undefined;
  await rm(dir, { recursive: true, force: true });
});

const okSign = (keyBlob: Uint8Array, data: Uint8Array, flags: number) => {
  calls.push({ keyBlob, data, flags });
  return Promise.resolve(SIGNATURE);
};

describe("GrantAgent", () => {
  test("identities returns the one public key and its comment", async () => {
    const path = await makeAgent(okSign).start();
    const client = await connect(path);
    client.send(IDENTITIES_REQUEST);
    expect(await client.next()).toEqual(payloadOf(identitiesAnswer([{ blob: BLOB, comment: COMMENT }])));
    client.end();
  });

  test("sign calls forwardSign and returns the signature", async () => {
    const path = await makeAgent(okSign).start();
    const client = await connect(path);
    const data = new Uint8Array([1, 2, 3, 4]);
    client.send(signRequest(BLOB, data, 0));
    expect(await client.next()).toEqual(payloadOf(signAnswer(SIGNATURE)));
    expect(calls).toHaveLength(1);
    expect(calls[0].keyBlob).toEqual(BLOB);
    expect(calls[0].data).toEqual(data);
    expect(calls[0].flags).toBe(0);
    client.end();
  });

  test("sign for another key blob gets a failure", async () => {
    const path = await makeAgent(okSign).start();
    const client = await connect(path);
    client.send(signRequest(publicKeyBlob(new Uint8Array(32).fill(8)), new Uint8Array([1])));
    expect(await client.next()).toEqual(payloadOf(failureAnswer()));
    expect(calls).toHaveLength(0);
    client.end();
  });

  test("sign gets a failure when forwardSign rejects", async () => {
    const path = await makeAgent(() => Promise.reject(new Error("hub said no"))).start();
    const client = await connect(path);
    client.send(signRequest(BLOB, new Uint8Array([1])));
    expect(await client.next()).toEqual(payloadOf(failureAnswer()));
    // The agent still serves.
    client.send(IDENTITIES_REQUEST);
    expect(await client.next()).toEqual(payloadOf(identitiesAnswer([{ blob: BLOB, comment: COMMENT }])));
    client.end();
  });

  test("sign gets a failure after signTimeoutMs", async () => {
    const path = await makeAgent(() => new Promise<Uint8Array>(() => {}), 50).start();
    const client = await connect(path);
    client.send(signRequest(BLOB, new Uint8Array([1])));
    expect(await client.next()).toEqual(payloadOf(failureAnswer()));
    client.end();
  });

  test("any other request type gets a failure", async () => {
    const path = await makeAgent(okSign).start();
    const client = await connect(path);
    client.send(framed(Uint8Array.of(17), str(new Uint8Array([1, 2]))));
    expect(await client.next()).toEqual(payloadOf(failureAnswer()));
    client.end();
  });

  test("a frame over MAX_FRAME closes that connection and a second client still works", async () => {
    const path = await makeAgent(okSign).start();
    const bad = await connect(path);
    bad.send(u32(MAX_FRAME + 1));
    await bad.closed;
    const good = await connect(path);
    good.send(IDENTITIES_REQUEST);
    expect(await good.next()).toEqual(payloadOf(identitiesAnswer([{ blob: BLOB, comment: COMMENT }])));
    good.end();
  });

  test("a cut frame then a close does not crash the agent", async () => {
    const path = await makeAgent(okSign).start();
    const cut = await connect(path);
    cut.send(join32(u32(100), new Uint8Array([13, 0, 0])));
    cut.end();
    await cut.closed;
    const good = await connect(path);
    good.send(IDENTITIES_REQUEST);
    expect(await good.next()).toEqual(payloadOf(identitiesAnswer([{ blob: BLOB, comment: COMMENT }])));
    good.end();
  });

  test("a malformed sign request closes only that connection", async () => {
    const path = await makeAgent(okSign).start();
    const bad = await connect(path);
    bad.send(framed(Uint8Array.of(13), u32(500)));
    await bad.closed;
    const good = await connect(path);
    good.send(IDENTITIES_REQUEST);
    expect(await good.next()).toEqual(payloadOf(identitiesAnswer([{ blob: BLOB, comment: COMMENT }])));
    good.end();
  });

  test("the socket file has mode 600", async () => {
    const path = await makeAgent(okSign).start();
    expect(path).toBe(join(dir, "g1.sock"));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("a failed start leaves no listener and no socket file", async () => {
    const failing = new GrantAgent({
      dir,
      grantId: "g2",
      publicBlob: BLOB,
      comment: COMMENT,
      forwardSign: okSign,
      uid: 2 ** 32,
      gid: 2 ** 32,
    });
    const path = join(dir, "g2.sock");
    const failed = await failing.start().then(
      () => false,
      () => true,
    );
    expect(failed).toBe(true);
    expect(await Bun.file(path).exists()).toBe(false);
    const refused = await connect(path).then(
      () => false,
      () => true,
    );
    expect(refused).toBe(true);
  });

  test("stop removes the socket file and refuses new connections", async () => {
    const running = makeAgent(okSign);
    const path = await running.start();
    await running.stop();
    expect(await Bun.file(path).exists()).toBe(false);
    const refused = await connect(path).then(
      () => false,
      () => true,
    );
    expect(refused).toBe(true);
  });
});

const hasSshAdd = spawnSync("ssh-add", ["-h"]).error === undefined;

describe("with the real OpenSSH client", () => {
  test.skipIf(!hasSshAdd)("ssh-add -L reads the key", async () => {
    const path = await makeAgent(okSign).start();
    const proc = Bun.spawn(["ssh-add", "-L"], {
      env: { ...process.env, SSH_AUTH_SOCK: path },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out.trim()).toBe(publicKeyLine(RAW_KEY, COMMENT));
  });
});

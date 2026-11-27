import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { join } from "node:path";
import { failureAnswer, identitiesAnswer, publicKeyBlob, publicKeyLine, signAnswer } from "../../src/ssh/agentproto";
import { FrameReader } from "../../src/ssh/FrameReader";
import { GrantAgent } from "../../src/ssh/node/GrantAgent";
import type { AgentTransport, ConnectionHandler, RawConnection } from "../../src/ssh/node/GrantAgent";
import { assertPipeName, currentUserSid, newPipeName, pipeSddl, pipeTransport, restrictPipe } from "../../src/win/pipe";

const onWindows = process.platform === "win32";
const windowsTest = test.skipIf(!onWindows);

const RAW_KEY = new Uint8Array(32).fill(7);
const BLOB = publicKeyBlob(RAW_KEY);
const SIGNATURE = new Uint8Array(64).fill(9);
const SID = "S-1-5-21-1-2-3-1001";

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;

  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }

  return out;
}

const framed = (...parts: Uint8Array[]) => {
  const payload = cat(...parts);
  return cat(u32(payload.length), payload);
};
const str = (bytes: Uint8Array) => cat(u32(bytes.length), bytes);
const IDENTITIES_REQUEST = framed(Uint8Array.of(11));
const signRequest = (data: Uint8Array) => framed(Uint8Array.of(13), str(BLOB), str(data), u32(0));

function agentOn(transport: AgentTransport, forwardSign = () => Promise.resolve(SIGNATURE)): GrantAgent {
  return new GrantAgent({
    dir: "unused",
    topDir: "unused",
    grantId: "g1",
    publicBlob: BLOB,
    comment: "claude-rc:test",
    forwardSign,
    transport,
  });
}

/** A transport with no operating system: the test pushes bytes in and reads the answers. */
function fakeTransport() {
  const answers: Uint8Array[] = [];
  let stopped = false;
  let handler: ConnectionHandler | undefined;
  let ended = false;
  const transport: AgentTransport = {
    listen: (accept) => {
      const connection: RawConnection = {
        write: (bytes) => void answers.push(bytes),
        end: () => {
          ended = true;
        },
      };
      handler = accept(connection);
      return Promise.resolve({
        path: "fake-endpoint",
        stop: () => {
          stopped = true;
          return Promise.resolve();
        },
      });
    },
  };

  return {
    transport,
    answers,
    send: (bytes: Uint8Array) => handler?.data(bytes),
    isStopped: () => stopped,
    isEnded: () => ended,
  };
}

describe("pipe names", () => {
  test("a new name has the pipe prefix, the kind and 32 hex digits", () => {
    expect(newPipeName("agent")).toMatch(/^\\\\\.\\pipe\\claude-rc-agent-[0-9a-f]{32}$/);
  });

  test("two names are never equal", () => {
    expect(newPipeName("agent")).not.toBe(newPipeName("agent"));
  });

  test("a bad kind is refused", () => {
    expect(() => newPipeName("a b")).toThrow();
  });

  test.each([
    ["no prefix", "claude-rc-x"],
    ["a folder", "\\\\.\\pipe\\a\\b"],
    ["a space", "\\\\.\\pipe\\a b"],
    ["the Windows ssh-agent", "\\\\.\\pipe\\openssh-ssh-agent"],
    ["the Windows ssh-agent in capitals", "\\\\.\\pipe\\x-OpenSSH-ssh-agent"],
    ["empty", "\\\\.\\pipe\\"],
    ["a dot", "\\\\.\\pipe\\."],
    ["two dots", "\\\\.\\pipe\\.."],
  ])("%s is refused", (_label, name) => {
    expect(() => assertPipeName(name)).toThrow();
  });

  test("the access list names SYSTEM and the user, with no inheritance", () => {
    expect(pipeSddl(SID)).toBe(`D:P(A;;GA;;;SY)(A;;GA;;;${SID})`);
  });

  test.each(["", "S-1", "S-1-5-21)(A;;GA;;;WD", "x S-1-5-1-2"])("the SID %p is refused", (sid) => {
    expect(() => pipeSddl(sid)).toThrow();
  });
});

describe("the agent on a transport", () => {
  test("a list request gets the one key of the grant", async () => {
    const fake = fakeTransport();
    const agent = agentOn(fake.transport);
    expect(await agent.start()).toBe("fake-endpoint");
    fake.send(IDENTITIES_REQUEST);
    await Bun.sleep(20);
    expect(fake.answers[0]).toEqual(identitiesAnswer([{ blob: BLOB, comment: "claude-rc:test" }]));
    await agent.stop();
  });

  test("a sign request goes to forwardSign and the signature comes back", async () => {
    const fake = fakeTransport();
    const agent = agentOn(fake.transport);
    await agent.start();
    fake.send(signRequest(Uint8Array.of(1, 2, 3)));
    await Bun.sleep(20);
    expect(fake.answers[0]).toEqual(signAnswer(SIGNATURE));
    await agent.stop();
  });

  test("a failed sign gives a failure answer", async () => {
    const fake = fakeTransport();
    const agent = agentOn(fake.transport, () => Promise.reject(new Error("hub says no")));
    await agent.start();
    fake.send(signRequest(Uint8Array.of(1)));
    await Bun.sleep(20);
    expect(fake.answers[0]).toEqual(failureAnswer());
    await agent.stop();
  });

  test("a frame over the limit ends that connection", async () => {
    const fake = fakeTransport();
    const agent = agentOn(fake.transport);
    await agent.start();
    fake.send(u32(10_000_000));
    expect(fake.isEnded()).toBe(true);
    await agent.stop();
  });

  test("stop closes the transport and a second start is refused while running", async () => {
    const fake = fakeTransport();
    const agent = agentOn(fake.transport);
    await agent.start();
    await expect(agent.start()).rejects.toThrow("already started");
    await agent.stop();
    expect(fake.isStopped()).toBe(true);
  });
});

/** A client that sends one request on a pipe and returns the first answer payload. */
function ask(path: string, request: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FrameReader();
    const socket = connect(path);
    socket.on("error", reject);
    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk: Buffer) => {
      const [first] = reader.push(new Uint8Array(chunk));
      if (first) {
        socket.destroy();
        resolve(first);
      }
    });
  });
}

describe("the agent on a real named pipe", () => {
  const stops: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
  });

  windowsTest("sets the access list before it gives the name, and serves a list request", async () => {
    const name = newPipeName("agent");
    const calls: string[] = [];
    const agent = agentOn(
      pipeTransport({
        name,
        sid: SID,
        restrict: (pipe, sid) => {
          calls.push(`${pipe} ${sid}`);
          return Promise.resolve();
        },
      }),
    );
    stops.push(() => agent.stop());
    expect(await agent.start()).toBe(name);
    expect(calls).toEqual([`${name} ${SID}`]);
    const answer = await ask(name, IDENTITIES_REQUEST);
    expect(answer[0]).toBe(12);
  });

  windowsTest("a sign request over the pipe returns the signature", async () => {
    const name = newPipeName("agent");
    const agent = agentOn(pipeTransport({ name, restrict: () => Promise.resolve() }));
    stops.push(() => agent.stop());
    await agent.start();
    const answer = await ask(name, signRequest(Uint8Array.of(5, 6)));
    expect(parseResponseCode(answer)).toBe(14);
  });

  windowsTest("a connection before the access list is set is closed and gets no answer", async () => {
    const name = newPipeName("agent");
    let early: Promise<string> | undefined;
    const agent = agentOn(
      pipeTransport({
        name,
        sid: SID,
        restrict: async () => {
          early = new Promise((resolve) => {
            const socket = connect(name);
            socket.on("error", () => resolve("error"));
            socket.on("data", () => resolve("answer"));
            socket.on("close", () => resolve("closed"));
            socket.on("connect", () => socket.write(IDENTITIES_REQUEST));
          });
          expect(await early).not.toBe("answer");
        },
      }),
    );
    stops.push(() => agent.stop());
    await agent.start();
    expect(await early).not.toBe("answer");
    // After the start, a connection works.
    expect((await ask(name, IDENTITIES_REQUEST))[0]).toBe(12);
  });

  windowsTest("a failed access list closes the pipe and fails the start", async () => {
    const name = newPipeName("agent");
    const agent = agentOn(pipeTransport({ name, restrict: () => Promise.reject(new Error("no access list")) }));
    await expect(agent.start()).rejects.toThrow("no access list");
    await expect(ask(name, IDENTITIES_REQUEST)).rejects.toThrow();
  });

  windowsTest("stop removes the pipe", async () => {
    const name = newPipeName("agent");
    const agent = agentOn(pipeTransport({ name, restrict: () => Promise.resolve() }));
    await agent.start();
    await agent.stop();
    await expect(ask(name, IDENTITIES_REQUEST)).rejects.toThrow();
  });

  windowsTest("the real access list is SYSTEM and the user only", async () => {
    const name = newPipeName("agent");
    const sid = currentUserSid();
    const agent = agentOn(pipeTransport({ name, sid }));
    stops.push(() => agent.stop());
    await agent.start();
    const sddl = await readSddl(name);
    expect(sddl).toContain("(A;;FA;;;SY)");
    expect(sddl).toContain(`(A;;FA;;;${sid})`);
    expect(sddl).not.toContain(";;;WD)");
    expect(sddl).not.toContain(";;;AN)");
    expect(sddl).not.toContain(";;;BA)");
    // The same user still gets in.
    expect((await ask(name, IDENTITIES_REQUEST))[0]).toBe(12);
  });

  windowsTest("restrictPipe throws for a pipe that does not exist", async () => {
    await expect(restrictPipe(newPipeName("agent"), currentUserSid())).rejects.toThrow("Windows error");
  });

  windowsTest("ssh-add reads the key of the grant through the pipe", async () => {
    const name = newPipeName("agent");
    const agent = agentOn(pipeTransport({ name }));
    stops.push(() => agent.stop());
    await agent.start();
    // The full path matters: the ssh-add of Git for Windows comes first on the PATH and cannot use a named pipe.
    const sshAdd = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH", "ssh-add.exe");
    const proc = Bun.spawn([sshAdd, "-L"], { env: { ...process.env, SSH_AUTH_SOCK: name }, stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out.trim()).toBe(publicKeyLine(RAW_KEY, "claude-rc:test"));
  });
});

function parseResponseCode(payload: Uint8Array): number {
  return payload[0]!;
}

/** Reads the access list of a pipe by name as SDDL text, through advapi32. */
async function readSddl(pipeName: string): Promise<string> {
  const { dlopen, ptr, read } = await import("bun:ffi");
  const adv = dlopen("advapi32.dll", {
    GetNamedSecurityInfoW: { args: ["ptr", "u32", "u32", "ptr", "ptr", "ptr", "ptr", "ptr"], returns: "u32" },
    ConvertSecurityDescriptorToStringSecurityDescriptorW: {
      args: ["u64", "u32", "u32", "ptr", "ptr"],
      returns: "i32",
    },
  }).symbols;
  const sd = new BigUint64Array(1);
  const wide = (text: string) => Buffer.from(text + "\0", "utf16le");
  expect(adv.GetNamedSecurityInfoW(ptr(wide(pipeName)), 1, 4, null, null, null, null, ptr(sd))).toBe(0);
  const out = new BigUint64Array(1);
  expect(adv.ConvertSecurityDescriptorToStringSecurityDescriptorW(sd[0]!, 1, 4, ptr(out), null)).toBe(1);
  // The text is UTF-16. Read until the two zero bytes.
  const base = Number(out[0]);
  let text = "";

  for (let at = 0; ; at += 2) {
    const unit = read.u16(base as never, at);
    if (unit === 0) break;
    text += String.fromCharCode(unit);
  }

  return text;
}

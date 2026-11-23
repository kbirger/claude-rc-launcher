import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SshControl } from "../src/sshnodecontrol";
import { rejection } from "./support";

const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

async function setup(overrides: Partial<ConstructorParameters<typeof SshControl>[0]> = {}) {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "rc-ctl-")), "ssh");
  const calls: unknown[] = [];
  const chowns: [string, number, number][] = [];
  const control = new SshControl({
    dir,
    instanceId: "inst-1",
    targets: () => [{ id: "nas", account: "root", address: "10.0.0.5" }],
    request: (input) => {
      calls.push(input);
      return Promise.resolve({ socket: "/s", config: "/c", endsAt: 9 });
    },
    chown: (target, uid, gid) => {
      chowns.push([target, uid, gid]);
      return Promise.resolve();
    },
    ...overrides,
  });
  const socketPath = await control.start();
  stops.push(async () => {
    await control.stop();
    rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  return { control, socketPath, calls, dir, chowns };
}

/** Connects, sends each text, and collects the received text until `lines` lines came or the socket closed. */
async function talk(socketPath: string, texts: string[], lines: number) {
  let received = "";
  let closed = false;

  let wake: () => void = () => {};

  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      open: (connection) => {
        for (const text of texts) connection.write(text);
      },
      data: (_connection, chunk) => {
        received += Buffer.from(chunk).toString("utf8");
        if (received.split("\n").length - 1 >= lines) wake();
      },
      close: () => {
        closed = true;
        wake();
      },
      error: () => {},
    },
  });
  await new Promise<void>((resolve) => {
    wake = resolve;
    setTimeout(resolve, 3000);
    if (closed || received.split("\n").length - 1 >= lines) resolve();
  });
  const parsed = received
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  return { parsed, closed: () => closed, socket };
}

describe("SshControl", () => {
  test("targets lists names, accounts and addresses and no key", async () => {
    const { socketPath, dir, chowns } = await setup({ uid: 1234, gid: 1234 });
    const answer = await talk(socketPath, ['{"op":"targets"}\n'], 1);
    expect(answer.parsed).toEqual([{ ok: true, targets: [{ id: "nas", account: "root", address: "10.0.0.5" }] }]);
    expect(JSON.stringify(answer.parsed)).not.toContain("key");
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(dir, "inst-1")).mode & 0o777).toBe(0o700);
    expect(chowns).toEqual([
      [path.join(dir, "inst-1"), 1234, 1234],
      [socketPath, 1234, 1234],
    ]);
  });

  test("request passes the instance id of the socket that was used", async () => {
    const { socketPath, calls } = await setup();
    const answer = await talk(
      socketPath,
      ['{"op":"request","targetId":"nas","minutes":5,"reason":"why","instanceId":"other"}\n'],
      1,
    );
    expect(answer.parsed).toEqual([{ ok: true, socket: "/s", config: "/c", endsAt: 9 }]);
    expect(calls).toEqual([{ instanceId: "inst-1", targetId: "nas", minutes: 5, reason: "why" }]);
  });

  test("a bad JSON line gets ok false and the socket stays open", async () => {
    const { socketPath } = await setup();
    const answer = await talk(socketPath, ["not json\n", "[1]\n", '{"op":"targets"}\n'], 3);
    expect(answer.parsed.map((item) => item.ok)).toEqual([false, false, true]);
    expect(answer.closed()).toBe(false);
  });

  test("a request line over 16 KiB closes the connection", async () => {
    const { socketPath } = await setup();
    const answer = await talk(socketPath, [`{"op":"request","targetId":"${"a".repeat(17 * 1024)}"}\n`], 5);
    expect(answer.parsed[0]?.ok).toBe(false);
    await Bun.sleep(50);
    expect(answer.closed()).toBe(true);
    // Another connection still works.
    expect((await talk(socketPath, ['{"op":"targets"}\n'], 1)).parsed[0]?.ok).toBe(true);
  });

  test("stop removes the socket", async () => {
    const { control, socketPath } = await setup();
    expect(existsSync(socketPath)).toBe(true);
    await control.stop();
    expect(existsSync(socketPath)).toBe(false);
  });

  test("a request answers only when the callback settles, and an error becomes ok false", async () => {
    let release: () => void = () => {};

    const { socketPath } = await setup({
      request: () =>
        new Promise((_resolve, reject) => {
          release = () => {
            reject(new Error("refused"));
          };
        }),
    });
    const pending = talk(socketPath, ['{"op":"request","targetId":"nas"}\n'], 1);
    await Bun.sleep(100);
    release();
    expect((await pending).parsed).toEqual([{ ok: false, error: "refused" }]);
  });

  test("an unsafe instance id and a long path are refused", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "rc-ctl-"));
    stops.push(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const make = (instanceId: string, base = dir) =>
      new SshControl({ dir: base, instanceId, targets: () => [], request: () => Promise.reject(new Error("x")) });
    expect((await rejection(make("../x").start())).message).toContain("unsafe instance id");
    expect((await rejection(make("a.b").start())).message).toContain("unsafe instance id");
    expect((await rejection(make("inst", path.join(dir, "d".repeat(100))).start())).message).toContain("too long");
  });
});

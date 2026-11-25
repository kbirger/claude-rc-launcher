import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "../src/index";
import type { Env } from "../src/index";

const cleanups: (() => void)[] = [];
afterAll(() => {
  cleanups.forEach((cleanup) => {
    cleanup();
  });
});

/** A fake node: a socket that answers each line with `answer(line)`. */
function fakeNode(answer: (message: Record<string, unknown>) => unknown) {
  const folder = mkdtempSync(path.join(os.tmpdir(), "rc-sshcmd-"));
  const control = path.join(folder, "control.sock");
  const seen: Record<string, unknown>[] = [];
  const listener = Bun.listen<{ buffer: string }>({
    unix: control,
    socket: {
      open: (socket) => {
        socket.data = { buffer: "" };
      },
      data: (socket, chunk) => {
        socket.data.buffer += Buffer.from(chunk).toString("utf8");
        const end = socket.data.buffer.indexOf("\n");
        if (end === -1) return;
        const message = JSON.parse(socket.data.buffer.slice(0, end)) as Record<string, unknown>;
        seen.push(message);
        socket.write(`${JSON.stringify(answer(message))}\n`);
      },
    },
  });
  cleanups.push(() => {
    listener.stop(true);
    rmSync(folder, { recursive: true, force: true });
  });

  return { control, seen };
}

function run(environ: Record<string, string | undefined>, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const env: Env = {
    // The commands need no login: the credentials file does not exist.
    credsFile: path.join(os.tmpdir(), "rc-sshcmd-no-such-creds.json"),
    open: async () => {},
    readLine: () => Promise.resolve(""),
    environ,
  };

  return main(argv, { out: (line) => out.push(line), err: (line) => err.push(line) }, env).then((code) => ({
    code,
    out,
    err,
  }));
}

describe("claude-rc ssh", () => {
  test("ssh targets prints one line for each target", async () => {
    const node = fakeNode(() => ({
      ok: true,
      targets: [
        { id: "nas", account: "root", address: "10.0.0.5" },
        { id: "pi", account: "pi", address: "10.0.0.6" },
      ],
    }));
    const outcome = await run({ CLAUDE_RC_SSH_CONTROL: node.control }, "ssh", "targets");
    expect(outcome.code).toBe(0);
    expect(outcome.out).toEqual(["nas  root@10.0.0.5", "pi  pi@10.0.0.6"]);
    expect(node.seen).toEqual([{ op: "targets" }]);
  });

  test("ssh request prints the waiting line, approved, the end time, then the paths", async () => {
    const node = fakeNode(() => ({ ok: true, socket: "/run/s/agent.sock", config: "/run/s/g.conf", endsAt: 5 }));
    const outcome = await run(
      { CLAUDE_RC_SSH_CONTROL: node.control },
      "ssh",
      "request",
      "nas",
      "--minutes",
      "30",
      "--reason",
      "fix the backup",
    );
    expect(outcome.code).toBe(0);
    expect(outcome.out).toEqual([
      "waiting for approval",
      "approved",
      `access ends at ${new Date(5).toISOString()}`,
      "socket: /run/s/agent.sock",
      "config: /run/s/g.conf",
      "ssh -F /run/s/g.conf nas",
    ]);
    expect(node.seen).toEqual([{ op: "request", targetId: "nas", minutes: 30, reason: "fix the backup" }]);
  });

  test("ssh request omits the end time line when endsAt is missing, not a number or out of range", async () => {
    for (const endsAt of [undefined, "soon", 8.64e15 + 1, 1e300]) {
      const node = fakeNode(() => ({
        ok: true,
        socket: "/s",
        config: "/c",
        ...(endsAt === undefined ? {} : { endsAt }),
      }));
      const outcome = await run({ CLAUDE_RC_SSH_CONTROL: node.control }, "ssh", "request", "nas");
      expect(outcome.code).toBe(0);
      expect(outcome.out).toEqual(["waiting for approval", "approved", "socket: /s", "config: /c", "ssh -F /c nas"]);
    }
  });

  test("ssh request without the environment variable exits 1 with the message above", async () => {
    const outcome = await run({}, "ssh", "request", "nas");
    expect(outcome.code).toBe(1);
    expect(outcome.err).toEqual(["SSH access is not turned on for this instance"]);
    expect(outcome.out).toEqual([]);
    expect((await run({}, "ssh", "targets")).err).toEqual(["SSH access is not turned on for this instance"]);
  });

  test("ssh request prints the error text when the answer is ok false", async () => {
    const node = fakeNode(() => ({ ok: false, error: "the owner said no" }));
    const outcome = await run({ CLAUDE_RC_SSH_CONTROL: node.control }, "ssh", "request", "nas");
    expect(outcome.code).toBe(1);
    expect(outcome.err).toEqual(["the owner said no"]);
    expect(outcome.out).toEqual(["waiting for approval"]);
  });
});

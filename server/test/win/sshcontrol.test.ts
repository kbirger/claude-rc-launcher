import { describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { sshRequest, sshTargets } from "../../../cli/src/sshcmd";
import type { AgentTransport, ConnectionHandler, RawConnection } from "../../src/ssh/node/GrantAgent";
import { newPipeName, pipeTransport } from "../../src/win/pipe";
import { WinSshControl } from "../../src/win/sshcontrol";

/** A transport with no pipe: the test pushes bytes into each connection and reads what comes back. */
function fakeTransport() {
  const handlers: ConnectionHandler[] = [];
  const sent: string[][] = [];
  const ended: boolean[] = [];
  const transport: AgentTransport = {
    listen: async (accept) => {
      void accept;
      return { path: "\\.\pipe\fake", stop: async () => {} };
    },
  };
  let acceptFn: ((raw: RawConnection) => ConnectionHandler) | undefined;
  const wrapped: AgentTransport = {
    listen: async (accept) => {
      acceptFn = accept;
      return transport.listen(accept);
    },
  };
  const open = () => {
    const index = sent.length;
    sent.push([]);
    ended.push(false);
    const handler = acceptFn!({
      write: (bytes) => void sent[index].push(Buffer.from(bytes).toString("utf8")),
      end: () => void (ended[index] = true),
    });
    handlers.push(handler);
    return {
      send: (text: string) => handler.data(new Uint8Array(Buffer.from(text))),
      sendBytes: (bytes: Uint8Array) => handler.data(new Uint8Array(bytes)),
      sent: () => sent[index].join(""),
      ended: () => ended[index],
    };
  };
  return { transport: wrapped, open };
}

const make = (calls: { instanceId: string; targetId: string }[] = []) => {
  const fake = fakeTransport();
  const control = new WinSshControl({
    transport: fake.transport,
    targets: () => [{ id: "nas", account: "root", address: "10.0.0.2" } as never],
    request: async (input) => {
      calls.push(input);
      return { socket: "s", config: "c", endsAt: 1 } as never;
    },
  });
  return { control, open: fake.open, calls };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("WinSshControl", () => {
  test("a known token gets an answer", async () => {
    const { control, open } = make();
    await control.start();
    const token = control.register("a");
    const c = open();
    c.send(JSON.stringify({ op: "targets", token }) + "\n");
    await tick();
    expect(JSON.parse(c.sent())).toMatchObject({ ok: true });
    expect(c.ended()).toBe(false);
  });

  test("an unknown token closes the connection with no answer", async () => {
    const { control, open } = make();
    await control.start();
    control.register("a");
    const c = open();
    c.send(JSON.stringify({ op: "targets", token: "nope" }) + "\n");
    await tick();
    expect(c.sent()).toBe("");
    expect(c.ended()).toBe(true);
  });

  test("a missing token, bad JSON and a long line close the connection", async () => {
    const { control, open } = make();
    await control.start();
    for (const text of [JSON.stringify({ op: "targets" }) + "\n", "not json\n", "x".repeat(20000)]) {
      const c = open();
      c.send(text);
      await tick();
      expect(c.sent()).toBe("");
      expect(c.ended()).toBe(true);
    }
  });

  test("the instance comes from the token, and instance B cannot use the id of A", async () => {
    const { control, open, calls } = make();
    await control.start();
    control.register("a");
    const tokenB = control.register("b");
    const c = open();
    c.send(JSON.stringify({ op: "request", targetId: "nas", instanceId: "a", token: tokenB }) + "\n");
    await tick();
    expect(calls).toEqual([{ instanceId: "b", targetId: "nas" }]);
  });

  test("unregister and a new register invalidate the old token, and stop clears all", async () => {
    const { control, open } = make();
    await control.start();
    const old = control.register("a");
    const fresh = control.register("a");
    let c = open();
    c.send(JSON.stringify({ op: "targets", token: old }) + "\n");
    await tick();
    expect(c.ended()).toBe(true);
    control.unregister("a");
    c = open();
    c.send(JSON.stringify({ op: "targets", token: fresh }) + "\n");
    await tick();
    expect(c.ended()).toBe(true);
  });

  test("a bad request field gives an error answer and keeps the connection", async () => {
    const { control, open } = make();
    await control.start();
    const token = control.register("a");
    const c = open();
    c.send(JSON.stringify({ op: "request", token }) + "\n");
    await tick();
    expect(JSON.parse(c.sent())).toEqual({ ok: false, error: "targetId is required" });
    expect(c.ended()).toBe(false);
  });
});

describe("WinSshControl review fixes", () => {
  const slow = () => {
    const gate: { open: () => void } = { open: () => {} };
    const calls: { instanceId: string; targetId: string }[] = [];
    const fake = fakeTransport();
    const control = new WinSshControl({
      transport: fake.transport,
      targets: () => [],
      request: async (input) => {
        calls.push(input);
        await new Promise<void>((resolve) => (gate.open = resolve));
        return { socket: "s", config: "c", endsAt: 1 } as never;
      },
    });
    return { control, open: fake.open, calls, gate };
  };

  test("a queued line does not run after its token is removed", async () => {
    const { control, open, calls, gate } = slow();
    await control.start();
    const token = control.register("a");
    const c = open();
    const line = JSON.stringify({ op: "request", targetId: "nas", token }) + "\n";
    c.send(line + line);
    await tick();
    control.unregister("a");
    gate.open();
    await tick();
    expect(calls).toHaveLength(1);
  });

  test("a bad line after good ones cancels the queued requests", async () => {
    const { control, open, calls, gate } = slow();
    await control.start();
    const token = control.register("a");
    const c = open();
    const line = JSON.stringify({ op: "request", targetId: "nas", token }) + "\n";
    c.send(line + line + "garbage\n");
    await tick();
    gate.open();
    await tick();
    expect(c.ended()).toBe(true);
    expect(calls).toHaveLength(0);
    expect(c.sent()).toBe("");
  });

  test("more than four waiting lines close the connection", async () => {
    const { control, open } = slow();
    await control.start();
    const token = control.register("a");
    const c = open();
    const line = JSON.stringify({ op: "request", targetId: "nas", token }) + "\n";
    c.send(line.repeat(5));
    await tick();
    expect(c.ended()).toBe(true);
  });

  test("a multibyte reason split across two chunks arrives whole", async () => {
    const calls: { reason?: string }[] = [];
    const fake = fakeTransport();
    const control = new WinSshControl({
      transport: fake.transport,
      targets: () => [],
      request: async (input) => {
        calls.push(input);
        return { socket: "s", config: "c", endsAt: 1 } as never;
      },
    });
    await control.start();
    const token = control.register("a");
    const bytes = Buffer.from(JSON.stringify({ op: "request", targetId: "nas", reason: "café", token }) + "\n");
    const cut = bytes.indexOf(0xc3) + 1;
    const raw = fake.open();
    raw.sendBytes(bytes.subarray(0, cut));
    raw.sendBytes(bytes.subarray(cut));
    await tick();
    expect(calls[0].reason).toBe("café");
  });
});

describe.skipIf(process.platform !== "win32")("WinSshControl on a real pipe with the CLI", () => {
  test("targets and request work and a wrong token fails", async () => {
    const calls: { instanceId: string; targetId: string }[] = [];
    const control = new WinSshControl({
      transport: pipeTransport({ name: newPipeName("control") }),
      targets: () => [{ id: "nas", account: "root", address: "10.0.0.2" } as never],
      request: async (input) => {
        calls.push(input);
        return { socket: "S", config: "C", endsAt: Date.now() + 60000 } as never;
      },
    });
    const pipe = await control.start();
    try {
      const token = control.register("inst1");
      const lines: string[] = [];
      await sshTargets({ control: pipe, token, out: (l) => lines.push(l) });
      expect(lines).toEqual(["nas  root@10.0.0.2"]);

      const out: string[] = [];
      await sshRequest({ control: pipe, token, targetId: "nas", out: (l) => out.push(l) });
      expect(out).toContain("approved");
      expect(calls).toEqual([{ instanceId: "inst1", targetId: "nas" }]);

      await expect(sshTargets({ control: pipe, token: "wrong", out: () => {} })).rejects.toThrow();
      await expect(sshTargets({ control: pipe, out: () => {} })).rejects.toThrow("not turned on");

      // A raw client with a bad token gets no answer.
      const raw = await new Promise<string>((resolve) => {
        const s = connect(pipe);
        let got = "";
        s.on("connect", () => s.write(JSON.stringify({ op: "targets", token: "bad" }) + "\n"));
        s.on("data", (d) => (got += d.toString()));
        s.on("close", () => resolve(got));
      });
      expect(raw).toBe("");
    } finally {
      await control.stop();
    }
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PushService } from "./webpush";
import type { PushMessage, PushSubscriptionJson, PushTransport } from "./webpush";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "webpush-test-"));
  dirs.push(dir);
  return join(dir, "push");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sub = (n: number | string, path = "token"): PushSubscriptionJson => ({
  endpoint: `https://push.example.com/${path}/${n}`,
  keys: { p256dh: `p256dh-${n}`, auth: `auth-${n}` },
});
const message: PushMessage = { title: "SSH request", body: "node-1 wants access", url: "/ssh", tag: "ssh-1" };

function fake(status: number | ((sub: PushSubscriptionJson) => number) = 201) {
  const calls: { sub: PushSubscriptionJson; payload: string }[] = [];

  const transport: PushTransport = async (s, payload) => {
    calls.push({ sub: s, payload });
    return { status: typeof status === "function" ? status(s) : status };
  };

  return { calls, transport };
}

const make = (dir: string, transport?: PushTransport, audit?: (line: string) => void) =>
  new PushService({ dir, subject: "mailto:admin@example.com", transport, audit });

const stored = (dir: string): { subscriptions?: Record<string, PushSubscriptionJson[]> } =>
  JSON.parse(readFileSync(join(dir, "subscriptions.json"), "utf8")) as never;

describe("PushService", () => {
  test("creates the VAPID pair once and reuses it", async () => {
    const dir = tempDir();
    const first = await make(dir).publicKey();
    expect(first.length).toBeGreaterThan(40);
    expect(await make(dir).publicKey()).toBe(first);
    expect(statSync(join(dir, "vapid.json")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  test("subscribe replaces an entry with the same endpoint", async () => {
    const dir = tempDir();
    const service = make(dir);
    await service.subscribe("alice", sub(1));
    await service.subscribe("alice", { ...sub(1), keys: { p256dh: "new", auth: "new" } });
    const all = Object.values(stored(dir)).flat().flat();
    expect(JSON.stringify(all)).toContain('"new"');
    expect(JSON.stringify(all).match(/token\/1/g)?.length).toBe(1);
  });

  test("subscribe keeps at most 20 entries per user and drops the oldest", async () => {
    const dir = tempDir();
    const service = make(dir);
    for (let n = 0; n < 22; n++) await service.subscribe("alice", sub(n));
    const { calls, transport } = fake();
    await make(dir, transport).send(message);
    const endpoints = calls.map((c) => c.sub.endpoint);
    expect(endpoints).toHaveLength(20);
    expect(endpoints).not.toContain(sub(0).endpoint);
    expect(endpoints).not.toContain(sub(1).endpoint);
    expect(endpoints).toContain(sub(21).endpoint);
  });

  test("subscribe rejects an endpoint that is not https", async () => {
    const service = make(tempDir());
    await expect(service.subscribe("alice", { ...sub(1), endpoint: "http://push.example.com/x" })).rejects.toThrow(
      Error,
    );
    await expect(service.subscribe("alice", { ...sub(1), endpoint: "not a url" })).rejects.toThrow(Error);
  });

  test("unsubscribe removes only an entry of the same user", async () => {
    const dir = tempDir();
    const { calls, transport } = fake();
    const service = make(dir, transport);
    await service.subscribe("alice", sub(1));
    expect(await service.unsubscribe("bob", sub(1).endpoint)).toBe(false);
    await service.send(message);
    expect(calls).toHaveLength(1);
    expect(await service.unsubscribe("alice", sub(1).endpoint)).toBe(true);
    expect(await service.unsubscribe("alice", sub(1).endpoint)).toBe(false);
    await service.send(message);
    expect(calls).toHaveLength(1);
  });

  test("send calls the transport for each entry", async () => {
    const { calls, transport } = fake();
    const service = make(tempDir(), transport);
    await service.subscribe("alice", sub(1));
    await service.subscribe("bob", sub(2));
    await service.send({ ...message, grantId: "g1", close: true });
    expect(calls.map((c) => c.sub.endpoint).sort()).toEqual([sub(1).endpoint, sub(2).endpoint]);
    expect(JSON.parse(calls[0].payload)).toEqual({ ...message, grantId: "g1", close: true });
  });

  test("send deletes an entry on 404 and 410 and keeps it on 500", async () => {
    const dir = tempDir();
    const status: Record<string, number> = { [sub(1).endpoint]: 404, [sub(2).endpoint]: 410, [sub(3).endpoint]: 500 };
    const { calls, transport } = fake((s) => status[s.endpoint] ?? 201);
    const service = make(dir, transport);
    for (const n of [1, 2, 3]) await service.subscribe("alice", sub(n));
    await service.send(message);
    expect(calls).toHaveLength(3);
    calls.length = 0;
    await service.send(message);
    expect(calls.map((c) => c.sub.endpoint)).toEqual([sub(3).endpoint]);
  });

  test("send does not stop when one transport call throws", async () => {
    const calls: string[] = [];

    const transport: PushTransport = async (s) => {
      calls.push(s.endpoint);
      if (s.endpoint === sub(1).endpoint) throw new Error("network down");
      return { status: 201 };
    };

    const service = make(tempDir(), transport);
    await service.subscribe("alice", sub(1));
    await service.subscribe("alice", sub(2));
    await service.send(message);
    expect(calls).toHaveLength(2);
  });

  test("send logs the endpoint host only", async () => {
    const lines: string[] = [];
    const { transport } = fake();
    const service = make(tempDir(), transport, (line) => lines.push(line));
    await service.subscribe("alice", sub("secretpath", "wpush/secrettoken"));
    await service.send(message);
    expect(lines.length).toBeGreaterThan(0);
    const text = lines.join("\n");
    expect(text).toContain("push.example.com");
    expect(text).not.toContain("secrettoken");
    expect(text).not.toContain("secretpath");
    expect(text).not.toContain("p256dh-secretpath");
    expect(text).not.toContain("auth-secretpath");
  });

  test("request pushes use high urgency and close pushes use normal urgency", async () => {
    const dir = tempDir();
    const urgencies: string[] = [];
    const transport: PushTransport = async (_sub, payload, _vapid, options) => {
      urgencies.push(`${JSON.parse(payload).close === true ? "close" : "request"}:${options.urgency}`);
      return { status: 201 };
    };
    const service = make(dir, transport);
    await service.subscribe("alice", sub(1));
    await service.send(message);
    await service.send({ ...message, body: "", close: true });
    expect(urgencies).toEqual(["request:high", "close:normal"]);
  });

  test("a corrupt vapid.json is not overwritten and rejects, then a fixed file works", async () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "vapid.json"), "{not json");
    const lines: string[] = [];
    const service = make(dir, fake().transport, (line) => lines.push(line));
    await expect(service.publicKey()).rejects.toThrow();
    await service.send(message);
    expect(readFileSync(join(dir, "vapid.json"), "utf8")).toBe("{not json");
    expect(lines.some((line) => line.includes("send failed"))).toBe(true);
    writeFileSync(join(dir, "vapid.json"), JSON.stringify({ version: 1, publicKey: "pub", privateKey: "priv" }));
    expect(await service.publicKey()).toBe("pub");
  });

  test("an unreadable vapid.json is not overwritten", async () => {
    if (process.getuid?.() === 0) return; // root can read any file
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "vapid.json"), "{}", { mode: 0o000 });
    chmodSync(join(dir, "vapid.json"), 0o000);
    await expect(make(dir).publicKey()).rejects.toThrow();
  });

  test("an error code is logged with the error name", async () => {
    const dir = tempDir();
    const lines: string[] = [];
    const transport: PushTransport = async () => {
      throw Object.assign(new Error("secret text"), { code: "ECONNRESET" });
    };
    const service = make(dir, transport, (line) => lines.push(line));
    await service.subscribe("alice", sub(1));
    await service.send(message);
    const line = lines.find((item) => item.includes("failed="))!;
    expect(line).toContain("ECONNRESET");
    expect(line).not.toContain("secret text");
  });
});

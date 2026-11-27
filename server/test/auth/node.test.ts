import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadOrCreateHubKey, signProof } from "../../src/auth/hubproof";
import type { HubKey } from "../../src/auth/hubproof";
import { generateSecret, hashSecret, nodeAuth } from "../../src/auth/node";
import type { NodeAuthSettings } from "../../src/auth/node";
import { actStore } from "../../src/roles";

const FP = "sha256:" + "ab".repeat(32);

async function hubKit(now?: () => number) {
  const key: HubKey = await loadOrCreateHubKey(mkdtempSync(path.join(tmpdir(), "hubkey-")));
  const proof = (method: string, pathAndQuery: string, body = "", options: { now?: () => number } = {}) =>
    signProof(key, { method, pathAndQuery, body }, FP, options);
  const settings = (extra: Partial<NodeAuthSettings> = {}): NodeAuthSettings => ({
    hubKeys: [key.publicKey],
    selfFingerprint: FP,
    secretHashes: [],
    ...(now ? { now } : {}),
    ...extra,
  });
  return { key, proof, settings };
}

function app(nodeAuthSettings: NodeAuthSettings) {
  const hono = new Hono();
  hono.use("*", nodeAuth(nodeAuthSettings));
  hono.get("/x", (context) => context.json({ caller: context.get("caller" as never) }));
  hono.post("/echo", async (context) =>
    context.json({ caller: context.get("caller" as never), body: await context.req.json() }),
  );
  return hono;
}

const bearer = (item: string) => ({ authorization: `Bearer ${item}` });

describe("shared secret", () => {
  const secret = generateSecret();
  const other = generateSecret();

  test("generateSecret returns 64 hex chars and its sha256; hashSecret agrees", () => {
    expect(secret.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(secret.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSecret(secret.secret)).toBe(secret.sha256);
    expect(generateSecret().secret).not.toBe(secret.secret);
  });
  test("valid secret -> 200, caller is 'secret'", async () => {
    const response = await app({ hubKeys: [], selfFingerprint: FP, secretHashes: [secret.sha256] }).request("/x", {
      headers: bearer(secret.secret),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ caller: "secret" });
  });
  test("wrong secret -> 401; either of two listed hashes accepted", async () => {
    const hono = app({ hubKeys: [], selfFingerprint: FP, secretHashes: [secret.sha256] });
    expect((await hono.request("/x", { headers: bearer(other.secret) })).status).toBe(401);
    const rot = app({ hubKeys: [], selfFingerprint: FP, secretHashes: [secret.sha256, other.sha256] });
    expect((await rot.request("/x", { headers: bearer(secret.secret) })).status).toBe(200);
    expect((await rot.request("/x", { headers: bearer(other.secret) })).status).toBe(200);
  });
  test("no Authorization, cookie only, Basic, empty bearer -> 401", async () => {
    const hono = app({ hubKeys: [], selfFingerprint: FP, secretHashes: [secret.sha256] });
    expect((await hono.request("/x")).status).toBe(401);
    expect((await hono.request("/x", { headers: { cookie: `session=${secret.secret}` } })).status).toBe(401);
    expect(
      (await hono.request("/x", { headers: { authorization: `Basic ${btoa("u:" + secret.secret)}` } })).status,
    ).toBe(401);
    expect((await hono.request("/x", { headers: { authorization: "Bearer " } })).status).toBe(401);
  });
});

describe("hub proof", () => {
  const hp = (item: string) => ({ authorization: `Hub-Proof ${item}` });

  test("valid proof -> 200 and caller is 'hub'", async () => {
    const key = await hubKit();
    const response = await app(key.settings()).request("/x", { headers: hp(await key.proof("GET", "/x")) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ caller: "hub" });
  });
  test("Bearer <jwt> is treated as a secret and rejected", async () => {
    const key = await hubKit();
    const item = await key.proof("GET", "/x");
    const hono = app(key.settings({ secretHashes: [] }));
    expect((await hono.request("/x", { headers: bearer(item) })).status).toBe(401);
  });
  test("Hub-Proof with no hubKeys configured -> 401", async () => {
    const key = await hubKit();
    const response = await app(key.settings({ hubKeys: [] })).request("/x", {
      headers: hp(await key.proof("GET", "/x")),
    });
    expect(response.status).toBe(401);
  });
  test("a secret under the Hub-Proof scheme -> 401", async () => {
    const secret = generateSecret();
    const key = await hubKit();
    const response = await app(key.settings({ secretHashes: [secret.sha256] })).request("/x", {
      headers: hp(secret.secret),
    });
    expect(response.status).toBe(401);
  });
  test("POST with a JSON body: the handler can still read the body", async () => {
    const key = await hubKit();
    const body = JSON.stringify({ value: 1 });
    const response = await app(key.settings()).request("/echo", {
      method: "POST",
      body,
      headers: { ...hp(await key.proof("POST", "/echo", body)), "content-type": "application/json" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ caller: "hub", body: { value: 1 } });
  });
  test("a tampered body -> 401", async () => {
    const key = await hubKit();
    const response = await app(key.settings()).request("/echo", {
      method: "POST",
      body: '{"a":2}',
      headers: hp(await key.proof("POST", "/echo", '{"a":1}')),
    });
    expect(response.status).toBe(401);
  });
  test("query with a space and an ampersand is accepted", async () => {
    const key = await hubKit();
    const parsedUrl = new URL("http://node/x?path=/a b&x=1");
    const response = await app(key.settings()).request("/x?path=/a b&x=1", {
      headers: hp(await key.proof("GET", parsedUrl.pathname + parsedUrl.search)),
    });
    expect(response.status).toBe(200);
  });
  test("body over 1 MiB -> 413", async () => {
    const key = await hubKit();
    const body = "x".repeat(1024 * 1024 + 1);
    const response = await app(key.settings()).request("/echo", {
      method: "POST",
      body,
      headers: hp(await key.proof("POST", "/echo", body)),
    });
    expect(response.status).toBe(413);
  });
  test("streamed body over 1 MiB with no content-length -> 413 without reading it all", async () => {
    const key = await hubKit();
    let sent = 0;
    const chunk = new Uint8Array(64 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(ctl) {
        if (sent >= 64 * 1024 * 1024) {
          ctl.close();
          return;
        }

        sent += chunk.length;
        ctl.enqueue(chunk);
      },
    });
    const req = new Request("http://node/echo", {
      method: "POST",
      body: stream,
      headers: hp("x"),
      duplex: "half",
    } as RequestInit);
    expect(req.headers.get("content-length")).toBeNull();
    const response = await app(key.settings()).fetch(req);
    expect(response.status).toBe(413);
    expect(sent).toBeLessThan(8 * 1024 * 1024);
  });
  test("clock 10 s off -> 401", async () => {
    const key = await hubKit(() => Date.now() - 10_000);
    const response = await app(key.settings()).request("/x", { headers: hp(await key.proof("GET", "/x")) });
    expect(response.status).toBe(401);
  });
  test("replaying the same proof -> 401", async () => {
    const key = await hubKit();
    const hono = app(key.settings());
    const result = hp(await key.proof("GET", "/x"));
    expect((await hono.request("/x", { headers: result })).status).toBe(200);
    expect((await hono.request("/x", { headers: result })).status).toBe(401);
  });

  describe("rejection log", () => {
    let warn: ReturnType<typeof spyOn>;
    beforeEach(() => {
      warn = spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => warn.mockRestore());
    const lines = () => warn.mock.calls.map((call: unknown[]) => call.join(" "));

    test("clock skew logs one line with the reason and not the token", async () => {
      let clock = Date.now();
      const key = await hubKit(() => clock);
      const item = await key.proof("GET", "/x");
      clock += 3_600_000; // the node clock is an hour ahead of the hub
      const response = await app(key.settings()).request("/x", { headers: hp(item) });
      expect(response.status).toBe(401);
      expect(lines()).toHaveLength(1);
      expect(lines()[0]).toStartWith("hub proof rejected: invalid hub proof: ");
      expect(lines()[0]).toContain("exp");
      expect(lines()[0]).not.toContain(item);
      expect(lines()[0]).not.toContain(item.split(".")[1]);
    });
    test("an unknown key id logs the reason", async () => {
      const key = await hubKit();
      const other = await hubKit();
      const item = await key.proof("GET", "/x");
      const response = await app(key.settings({ hubKeys: [other.key.publicKey] })).request("/x", { headers: hp(item) });
      expect(response.status).toBe(401);
      expect(lines()).toEqual(["hub proof rejected: invalid hub proof: unknown key"]);
    });
    test("the same reason is logged once per 10 s and again after that", async () => {
      let clock = 1_000_000;
      const key = await hubKit(() => clock);
      const other = await hubKit();
      const hono = app(key.settings({ hubKeys: [other.key.publicKey] }));
      const go = async () => (await hono.request("/x", { headers: hp(await key.proof("GET", "/x")) })).status;
      expect(await go()).toBe(401);
      clock += 9_000;
      expect(await go()).toBe(401);
      expect(lines()).toHaveLength(1);
      clock += 1_000;
      expect(await go()).toBe(401);
      expect(lines()).toHaveLength(2);
    });
    test("no log for a request without Hub-Proof, for a wrong secret or for a valid proof", async () => {
      const key = await hubKit();
      const hono = app(key.settings());
      await hono.request("/x");
      await hono.request("/x", { headers: bearer("nope") });
      expect((await hono.request("/x", { headers: hp(await key.proof("GET", "/x")) })).status).toBe(200);
      expect(lines()).toEqual([]);
    });
  });
});

describe("hub proof acting user", () => {
  test("the node sets act from the proof", async () => {
    const key = await hubKit();
    const hono = new Hono();
    hono.use("*", nodeAuth(key.settings()));
    hono.get("/x", (context) => context.json({ act: context.get("act" as never) }));
    const jwt = await actStore.run({ sub: "kir", role: "admin" }, () => key.proof("GET", "/x"));
    const response = await hono.request("/x", { headers: { authorization: `Hub-Proof ${jwt}` } });
    expect(await response.json()).toEqual({ act: { actSub: "kir", actRole: "admin" } });
  });
});

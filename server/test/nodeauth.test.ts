import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { loadOrCreateHubKey, signProof, type HubKey } from "../src/hubproof";
import { generateSecret, hashSecret, nodeAuth, type NodeAuthSettings } from "../src/nodeauth";

const FP = "sha256:" + "ab".repeat(32);

async function hubKit(now?: () => number) {
  const key: HubKey = await loadOrCreateHubKey(mkdtempSync(path.join(tmpdir(), "hubkey-")));
  const proof = (method: string, pathAndQuery: string, body = "", o: { now?: () => number } = {}) =>
    signProof(key, { method, pathAndQuery, body }, FP, o);
  const settings = (extra: Partial<NodeAuthSettings> = {}): NodeAuthSettings => ({
    hubKeys: [key.publicKey],
    selfFingerprint: FP,
    secretHashes: [],
    ...(now ? { now } : {}),
    ...extra,
  });
  return { key, proof, settings };
}

function app(s: NodeAuthSettings) {
  const a = new Hono();
  a.use("*", nodeAuth(s));
  a.get("/x", (c) => c.json({ caller: c.get("caller" as never) }));
  a.post("/echo", async (c) => c.json({ caller: c.get("caller" as never), body: await c.req.json() }));
  return a;
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe("shared secret", () => {
  const s = generateSecret();
  const other = generateSecret();

  test("generateSecret returns 64 hex chars and its sha256; hashSecret agrees", () => {
    expect(s.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSecret(s.secret)).toBe(s.sha256);
    expect(generateSecret().secret).not.toBe(s.secret);
  });
  test("valid secret -> 200, caller is 'secret'", async () => {
    const r = await app({ hubKeys: [], selfFingerprint: FP, secretHashes: [s.sha256] }).request("/x", { headers: bearer(s.secret) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ caller: "secret" });
  });
  test("wrong secret -> 401; either of two listed hashes accepted", async () => {
    const a = app({ hubKeys: [], selfFingerprint: FP, secretHashes: [s.sha256] });
    expect((await a.request("/x", { headers: bearer(other.secret) })).status).toBe(401);
    const rot = app({ hubKeys: [], selfFingerprint: FP, secretHashes: [s.sha256, other.sha256] });
    expect((await rot.request("/x", { headers: bearer(s.secret) })).status).toBe(200);
    expect((await rot.request("/x", { headers: bearer(other.secret) })).status).toBe(200);
  });
  test("no Authorization, cookie only, Basic, empty bearer -> 401", async () => {
    const a = app({ hubKeys: [], selfFingerprint: FP, secretHashes: [s.sha256] });
    expect((await a.request("/x")).status).toBe(401);
    expect((await a.request("/x", { headers: { cookie: `session=${s.secret}` } })).status).toBe(401);
    expect((await a.request("/x", { headers: { authorization: `Basic ${btoa("u:" + s.secret)}` } })).status).toBe(401);
    expect((await a.request("/x", { headers: { authorization: "Bearer " } })).status).toBe(401);
  });
});

describe("hub proof", () => {
  const hp = (t: string) => ({ authorization: `Hub-Proof ${t}` });

  test("valid proof -> 200 and caller is 'hub'", async () => {
    const k = await hubKit();
    const r = await app(k.settings()).request("/x", { headers: hp(await k.proof("GET", "/x")) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ caller: "hub" });
  });
  test("Bearer <jwt> is treated as a secret and rejected", async () => {
    const k = await hubKit();
    const t = await k.proof("GET", "/x");
    const a = app(k.settings({ secretHashes: [] }));
    expect((await a.request("/x", { headers: bearer(t) })).status).toBe(401);
  });
  test("Hub-Proof with no hubKeys configured -> 401", async () => {
    const k = await hubKit();
    const r = await app(k.settings({ hubKeys: [] })).request("/x", { headers: hp(await k.proof("GET", "/x")) });
    expect(r.status).toBe(401);
  });
  test("a secret under the Hub-Proof scheme -> 401", async () => {
    const s = generateSecret();
    const k = await hubKit();
    const r = await app(k.settings({ secretHashes: [s.sha256] })).request("/x", { headers: hp(s.secret) });
    expect(r.status).toBe(401);
  });
  test("POST with a JSON body: the handler can still read the body", async () => {
    const k = await hubKit();
    const body = JSON.stringify({ a: 1 });
    const r = await app(k.settings()).request("/echo", { method: "POST", body, headers: { ...hp(await k.proof("POST", "/echo", body)), "content-type": "application/json" } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ caller: "hub", body: { a: 1 } });
  });
  test("a tampered body -> 401", async () => {
    const k = await hubKit();
    const r = await app(k.settings()).request("/echo", { method: "POST", body: '{"a":2}', headers: hp(await k.proof("POST", "/echo", '{"a":1}')) });
    expect(r.status).toBe(401);
  });
  test("query with a space and an ampersand is accepted", async () => {
    const k = await hubKit();
    const u = new URL("http://node/x?path=/a b&x=1");
    const r = await app(k.settings()).request("/x?path=/a b&x=1", { headers: hp(await k.proof("GET", u.pathname + u.search)) });
    expect(r.status).toBe(200);
  });
  test("body over 1 MiB -> 413", async () => {
    const k = await hubKit();
    const body = "x".repeat(1024 * 1024 + 1);
    const r = await app(k.settings()).request("/echo", { method: "POST", body, headers: hp(await k.proof("POST", "/echo", body)) });
    expect(r.status).toBe(413);
  });
  test("streamed body over 1 MiB with no content-length -> 413 without reading it all", async () => {
    const k = await hubKit();
    let sent = 0;
    const chunk = new Uint8Array(64 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(ctl) {
        if (sent >= 64 * 1024 * 1024) return ctl.close();
        sent += chunk.length;
        ctl.enqueue(chunk);
      },
    });
    const req = new Request("http://node/echo", { method: "POST", body: stream, headers: hp("x"), duplex: "half" } as RequestInit);
    expect(req.headers.get("content-length")).toBeNull();
    const r = await app(k.settings()).fetch(req);
    expect(r.status).toBe(413);
    expect(sent).toBeLessThan(8 * 1024 * 1024);
  });
  test("clock 10 s off -> 401", async () => {
    const k = await hubKit(() => Date.now() - 10_000);
    const r = await app(k.settings()).request("/x", { headers: hp(await k.proof("GET", "/x")) });
    expect(r.status).toBe(401);
  });
  test("replaying the same proof -> 401", async () => {
    const k = await hubKit();
    const a = app(k.settings());
    const h = hp(await k.proof("GET", "/x"));
    expect((await a.request("/x", { headers: h })).status).toBe(200);
    expect((await a.request("/x", { headers: h })).status).toBe(401);
  });

  describe("rejection log", () => {
    let warn: ReturnType<typeof spyOn>;
    beforeEach(() => {
      warn = spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => warn.mockRestore());
    const lines = () => warn.mock.calls.map((c: unknown[]) => c.join(" "));

    test("clock skew logs one line with the reason and not the token", async () => {
      let clock = Date.now();
      const k = await hubKit(() => clock);
      const t = await k.proof("GET", "/x");
      clock += 3_600_000; // the node clock is an hour ahead of the hub
      const r = await app(k.settings()).request("/x", { headers: hp(t) });
      expect(r.status).toBe(401);
      expect(lines()).toHaveLength(1);
      expect(lines()[0]).toStartWith("hub proof rejected: invalid hub proof: ");
      expect(lines()[0]).toContain("exp");
      expect(lines()[0]).not.toContain(t);
      expect(lines()[0]).not.toContain(t.split(".")[1]!);
    });
    test("an unknown key id logs the reason", async () => {
      const k = await hubKit();
      const other = await hubKit();
      const t = await k.proof("GET", "/x");
      const r = await app(k.settings({ hubKeys: [other.key.publicKey] })).request("/x", { headers: hp(t) });
      expect(r.status).toBe(401);
      expect(lines()).toEqual(["hub proof rejected: invalid hub proof: unknown key"]);
    });
    test("the same reason is logged once per 10 s and again after that", async () => {
      let clock = 1_000_000;
      const k = await hubKit(() => clock);
      const other = await hubKit();
      const a = app(k.settings({ hubKeys: [other.key.publicKey] }));
      const go = async () => (await a.request("/x", { headers: hp(await k.proof("GET", "/x")) })).status;
      expect(await go()).toBe(401);
      clock += 9_000;
      expect(await go()).toBe(401);
      expect(lines()).toHaveLength(1);
      clock += 1_000;
      expect(await go()).toBe(401);
      expect(lines()).toHaveLength(2);
    });
    test("no log for a request without Hub-Proof, for a wrong secret or for a valid proof", async () => {
      const k = await hubKit();
      const a = app(k.settings());
      await a.request("/x");
      await a.request("/x", { headers: bearer("nope") });
      expect((await a.request("/x", { headers: hp(await k.proof("GET", "/x")) })).status).toBe(200);
      expect(lines()).toEqual([]);
    });
  });
});

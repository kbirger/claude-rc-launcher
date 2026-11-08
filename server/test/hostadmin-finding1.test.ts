import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { createNodeApp, onError } from "../src/app";
import type { Config } from "../src/config";
import { hostAdminApi } from "../src/hostadmin";
import { createHostClient, hubAuthorizer, type HostConfig } from "../src/hostclient";
import { HostRegistry } from "../src/hostregistry";
import { loadOrCreateHubKey } from "../src/hubproof";
import { nodeAuth } from "../src/nodeauth";
import { ensureNodeCert } from "../src/tls";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "rc-f1-"));
const stops: (() => void)[] = [];
afterAll(() => stops.forEach((s) => s()));

/**
 * Finding 1: `host add` makes a test call to a host whose identity is only a pinned certificate fingerprint.
 * The header that the hub sends to that (possibly hostile) host must not work against any other node.
 */
describe("finding 1: a credential sent to a new host cannot be replayed against a real node", () => {
  test("the Authorization header that host add sends is a Hub-Proof, and a real node answers 401 to it", async () => {
    const hubKey = await loadOrCreateHubKey(tmp());

    // A fake host with its own certificate that records what it receives.
    const fakeCert = await ensureNodeCert({ dir: tmp(), names: ["localhost"] });
    const seen: { auth: string | null; method: string; path: string }[] = [];
    const fake = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      tls: { cert: fakeCert.certPem, key: fakeCert.keyPem },
      fetch: (req) => {
        const u = new URL(req.url);
        seen.push({ auth: req.headers.get("authorization"), method: req.method, path: u.pathname + u.search });
        return Response.json({});
      },
    });
    stops.push(() => fake.stop(true));

    // The real host add flow, with no force, so the hub calls the fake host.
    const makeClient = (h: HostConfig) => createHostClient(h, hubAuthorizer(hubKey, h));
    const registry = await HostRegistry.load({ stateDir: tmp(), hosts: [], clients: new Map(), makeClient });
    const admin = new Hono();
    admin.use("*", async (c, next) => {
      c.set("user" as never, { sub: "u1", name: "Ann", username: "kir" } as never);
      await next();
    });
    admin.route("/hosts", hostAdminApi({ registry, makeClient }));
    admin.onError(onError);
    const log = console.log;
    console.log = () => {};
    let res: Response;
    try {
      res = await admin.request("/hosts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "evil", url: `https://localhost:${fake.port}`, fingerprint: `sha256:${fakeCert.fingerprintSha256}` }),
      });
    } finally {
      console.log = log;
    }
    expect(res.status).toBe(201);
    expect(seen).toHaveLength(1);
    const captured = seen[0]!;
    expect(captured.auth).toStartWith("Hub-Proof ");
    expect(captured.auth).not.toContain("Bearer");

    // A real node, trusting this hub, with its own certificate.
    const nodeCert = await ensureNodeCert({ dir: tmp(), names: ["localhost"] });
    const svc: any = { list: async () => [], start: async () => ({}), stop: async () => {}, logs: async () => "" };
    const nodeApp = createNodeApp({
      cfg: { name: "n", roots: [realpathSync(tmp())] } as unknown as Config,
      instances: svc,
      auth: nodeAuth({ hubKeys: [hubKey.publicKey], selfFingerprint: `sha256:${nodeCert.fingerprintSha256}`, secretHashes: [] }),
    });
    const replay = await nodeApp.request(captured.path, { method: captured.method, headers: { authorization: captured.auth! } });
    expect(replay.status).toBe(401);

    // Control: the same node does accept a proof that the hub signs for it, so the 401 above is about the audience.
    const nodeHost: HostConfig = { id: "real", name: "real", url: "https://localhost:1", ca: nodeCert.certPem, auth: { type: "hub_key" } };
    const proper = await hubAuthorizer(hubKey, nodeHost)({ method: captured.method, pathAndQuery: captured.path, body: "" });
    expect((await nodeApp.request(captured.path, { method: captured.method, headers: { authorization: proper } })).status).toBe(200);
  });
});

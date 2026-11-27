import { Hono } from "hono";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNodeApp, onError } from "../src/app";
import { PeekError, peekCertificate } from "../src/certpeek";
import type { Config } from "../src/config/parse";
import { hostAdminApi } from "../src/hostadmin";
import { createHostClient, secretAuthorizer } from "../src/hostclient";
import type { HostClient, HostConfig } from "../src/hostclient";
import { HostRegistry } from "../src/hostregistry";
import { generateSecret, nodeAuth } from "../src/auth/node";
import { ensureNodeCert } from "../src/tls";
import { defined } from "./support";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "rc-admin-"));
const stops: (() => void)[] = [];
afterAll(() => {
  stops.forEach((stop) => {
    stop();
  });
});

async function startNode() {
  const sec = generateSecret();
  const cert = await ensureNodeCert({ dir: tmp(), names: ["localhost"] });
  const svc: any = {
    list: () => Promise.resolve([]),
    start: () => Promise.resolve({}),
    stop: async () => {},
    logs: () => Promise.resolve(""),
  };
  const app = createNodeApp({
    cfg: { name: "n", roots: [realpathSync(tmp())] } as unknown as Config,
    instances: svc,
    auth: nodeAuth({ hubKeys: [], selfFingerprint: "sha256:test", secretHashes: [sec.sha256] }),
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert: cert.certPem, key: cert.keyPem },
    fetch: app.fetch,
  });
  stops.push(() => server.stop(true));
  return { url: `https://localhost:${server.port}`, cert, secret: sec.secret, stop: () => server.stop(true) };
}

const staticHost: HostConfig = {
  id: "nas",
  name: "NAS",
  url: "https://10.0.0.5:8443",
  ca: "x",
  auth: { type: "hub_key" },
};
const JSON_H = { "content-type": "application/json" };

async function setup(options: { secret?: string; peek?: typeof peekCertificate } = {}) {
  const node = await startNode();
  const stateDir = tmp();
  const makeClient = (hostConfig: HostConfig): HostClient =>
    createHostClient(hostConfig, secretAuthorizer(options.secret ?? node.secret));
  const registry = await HostRegistry.load({
    stateDir,
    hosts: [staticHost],
    clients: new Map([
      [
        "nas",
        {
          stream: () => {
            return Promise.reject(new Error("unused"));
          },
          call: () => Promise.resolve({ status: 200, body: {} }),
        },
      ],
    ]),
    makeClient,
  });
  const app = new Hono();
  app.use("*", async (context, next) => {
    context.set("user" as never, { sub: "u1", name: "Ann", username: "kir", role: "admin" } as never);
    await next();
  });
  app.route("/cli/api/hosts", hostAdminApi({ registry, makeClient, ...(options.peek ? { peek: options.peek } : {}) }));
  app.onError(onError);
  const post = (entry: string, body: unknown) =>
    app.request(`/cli/api/hosts${entry === "/" ? "" : entry}`, {
      method: "POST",
      headers: JSON_H,
      body: JSON.stringify(body),
    });
  const del = (entry: string) => app.request(`/cli/api/hosts${entry}`, { method: "DELETE", headers: JSON_H });
  const fp = `sha256:${node.cert.fingerprintSha256}`;
  return { node, registry, stateDir, post, del, fp };
}

let logged: string[] = [];
const realLog = console.log;
const realErr = console.error;
beforeEach(() => {
  logged = [];
  console.log = (...args: unknown[]) => void logged.push(args.join(" "));

  console.error = () => {};
});
afterEach(() => {
  console.log = realLog;
  console.error = realErr;
});

describe("POST /probe", () => {
  test("returns the node fingerprint, names, subject, expiry and PEM", async () => {
    const harness = await setup();
    const response = await harness.post("/probe", { url: harness.node.url });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.fingerprint).toBe(harness.fp);
    expect(body.names).toContain("localhost");
    expect(body.pem).toBe(harness.node.cert.certPem.trim() + "\n");
    expect(Object.keys(body).sort()).toEqual(["fingerprint", "names", "not_after", "pem", "subject"]);
  });
  test("an unreachable node is 502 with the url and reason; a bad url is 400", async () => {
    const harness = await setup({
      peek: () => {
        return Promise.reject(new PeekError("unreachable"));
      },
    });
    const response = await harness.post("/probe", { url: "https://10.0.0.9:8443" });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "host https://10.0.0.9:8443: unreachable" });
    for (const url of ["http://x:1", "https://x:1/path", "https://u:p@x:1", "nope", 5])
      expect((await harness.post("/probe", { url })).status).toBe(400);
  });
});

describe("POST / (add)", () => {
  test("the right fingerprint saves the host and it answers through the registry", async () => {
    const harness = await setup();
    const response = await harness.post("/", { id: "pi", name: "Pi", url: harness.node.url, fingerprint: harness.fp });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: "pi", name: "Pi", url: harness.node.url, source: "managed" });
    const res = await defined(harness.registry.get("pi")).client.call("GET", "/api/node");
    expect(res.status).toBe(200);
    expect(existsSync(path.join(harness.stateDir, "pins", "pi.pem"))).toBe(true);
  });
  test("colon-separated, upper-case and sha256:-less fingerprints are accepted", async () => {
    const harness = await setup();
    const hex = defined(harness.node.cert.fingerprintSha256.toUpperCase().match(/../g)).join(":");
    expect((await harness.post("/", { id: "pi", url: harness.node.url, fingerprint: hex })).status).toBe(201);
  });
  test("a wrong fingerprint is 400 and nothing is on disk", async () => {
    const harness = await setup();
    const response = await harness.post("/", {
      id: "pi",
      url: harness.node.url,
      fingerprint: `sha256:${"0".repeat(64)}`,
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("fingerprint does not match");
    expect(harness.registry.get("pi")).toBeUndefined();
    expect(existsSync(path.join(harness.stateDir, "managed-hosts.json"))).toBe(false);
  });
  test("a node that presents a different certificate than the one the user confirmed is 400", async () => {
    const other = await ensureNodeCert({ dir: tmp(), names: ["localhost"] });
    const harness = await setup({
      peek: async (options) => ({
        ...(await peekCertificate(options)),
        fingerprint: `sha256:${other.fingerprintSha256}`,
        pem: other.certPem,
      }),
    });
    const response = await harness.post("/", { id: "pi", url: harness.node.url, fingerprint: harness.fp });
    expect(response.status).toBe(400);
    expect(existsSync(path.join(harness.stateDir, "managed-hosts.json"))).toBe(false);
  });
  test("an offline node is 502 and nothing is saved", async () => {
    const harness = await setup();
    harness.node.stop();
    const response = await harness.post("/", { id: "pi", url: harness.node.url, fingerprint: harness.fp });
    expect(response.status).toBe(502);
    expect(harness.registry.get("pi")).toBeUndefined();
  });
  test("a node that rejects the hub credential is 502 unless force is true", async () => {
    const harness = await setup({ secret: generateSecret().secret });
    const response = await harness.post("/", { id: "pi", url: harness.node.url, fingerprint: harness.fp });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "host pi: rejected our credentials", host: "pi" });
    expect(harness.registry.get("pi")).toBeUndefined();
    expect(
      (await harness.post("/", { id: "pi", url: harness.node.url, fingerprint: harness.fp, force: true })).status,
    ).toBe(201);
  });
  test("bad ids are 400 before any network call, local and config ids are 409", async () => {
    let peeked = 0;
    const harness = await setup({
      peek: () => {
        peeked++;
        return Promise.reject(new PeekError("unreachable"));
      },
    });
    for (const id of ["../x", "UPPER", "", "a/b", 5])
      expect((await harness.post("/", { id, url: harness.node.url, fingerprint: harness.fp })).status).toBe(400);
    for (const id of ["local", "nas"])
      expect((await harness.post("/", { id, url: harness.node.url, fingerprint: harness.fp })).status).toBe(409);
    expect(peeked).toBe(0);
  });
  test("bad url, server_name, fingerprint and name are 400", async () => {
    const harness = await setup();
    const ok = { id: "pi", url: harness.node.url, fingerprint: harness.fp };

    for (const bad of [
      { url: "http://x:1" },
      { server_name: "bad name!" },
      { fingerprint: "abc" },
      { name: 5 },
      { force: "yes" },
    ]) {
      expect((await harness.post("/", { ...ok, ...bad })).status).toBe(400);
    }

    expect((await harness.post("/", [] as unknown)).status).toBe(400);
  });
  test("host add works when the hub has no credential other than its key", async () => {
    const harness = await setup();
    const response = await harness.post("/", { id: "pi", url: harness.node.url, fingerprint: harness.fp });
    expect(response.status).toBe(201);
  });
});

describe("DELETE /:id", () => {
  test("removes a managed host; a config host is 409; an unknown id is 404", async () => {
    const harness = await setup();
    await harness.post("/", { id: "pi", url: harness.node.url, fingerprint: harness.fp });
    expect((await harness.del("/pi")).status).toBe(204);
    expect(harness.registry.get("pi")).toBeUndefined();
    expect((await harness.del("/nas")).status).toBe(409);
    expect((await harness.del("/nope")).status).toBe(404);
  });
});

describe("audit", () => {
  test("add and remove each log one line with the user, host and status", async () => {
    const harness = await setup();
    await harness.post("/", { id: "pi", url: harness.node.url, fingerprint: harness.fp });
    await harness.del("/pi");
    await harness.post("/probe", { url: harness.node.url });
    expect(logged.filter((item) => item.startsWith("audit"))).toEqual([
      "audit user=kir role=admin host=pi POST /cli/api/hosts 201",
      "audit user=kir role=admin host=pi DELETE /cli/api/hosts/pi 204",
    ]);
  });
});

describe("PATCH /:id", () => {
  test("changes the name of a managed host and rejects an empty name", async () => {
    const harness = await setup();
    const url = `https://localhost:${new URL(harness.node.url).port}`;
    expect((await harness.post("/", { id: "win", url, fingerprint: harness.fp })).status).toBe(201);
    const patch = (body: unknown) => app_request(harness, "/win", body);
    expect((await patch({ name: "  " })).status).toBe(400);
    const ok = await patch({ name: "KIRSTATION4" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).name).toBe("KIRSTATION4");
    expect(harness.registry.get("win")?.host.name).toBe("KIRSTATION4");
  });
});

const app_request = (options: { registry: HostRegistry }, entry: string, body: unknown) => {
  const app = new Hono();
  app.route(
    "/cli/api/hosts",
    hostAdminApi({
      registry: options.registry,
      makeClient: () => {
        throw new Error("unused");
      },
    }),
  );
  app.onError(onError);
  return app.request(`/cli/api/hosts${entry}`, { method: "PATCH", headers: JSON_H, body: JSON.stringify(body) });
};

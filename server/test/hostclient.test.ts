import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfig, type ConfigIo } from "../src/config";
import { createProofVerifier, certFingerprint, loadOrCreateHubKey } from "../src/hubproof";
import { nodeAuth } from "../src/nodeauth";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { HostError, createHostClient, hubAuthorizer, secretAuthorizer, type HostConfig } from "../src/hostclient";
import { ensureNodeCert } from "../src/tls";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "rc-host-"));

// ---------------------------------------------------------------- config
describe("[[hosts]] config", () => {
  let pem = "";
  const files: Record<string, string> = {};
  const io: ConfigIo = { readFile: (p) => files[p] ?? "x".repeat(40) };
  const hubBase = () => ({
    public_url: "https://rc.example.com",
    user_auth: { mode: "oidc", session_secret_file: "session.secret", oidc: { issuer: "https://i", client_id: "c", client_secret_file: "c.secret" } },
  });
  const host = (o: Record<string, unknown> = {}) => ({ id: "nas", url: "https://10.0.0.5:8443", ca_file: "nas.pem", auth: { type: "secret", secret_file: "nas.secret" }, ...o });
  const cfgWith = (hosts: unknown[], extra: Record<string, unknown> = {}) => ({ ...hubBase(), ...extra, hosts });
  const fails = (r: unknown) => {
    try {
      parseConfig(r, io);
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error("no throw");
  };
  test("setup", async () => {
    pem = (await ensureNodeCert({ dir: tmp(), names: ["nas.internal"] })).certPem;
    files["nas.pem"] = pem;
    files["nas.secret"] = "a".repeat(64);
  });

  test("parses: name defaults to id; ca is the PEM text; secret read from file", () => {
    const c = parseConfig(cfgWith([host(), host({ id: "pi", name: "Pi", server_name: "pi.internal", auth: { type: "hub_key" } })]), io);
    expect(c.hosts).toEqual([
      { id: "nas", name: "nas", url: "https://10.0.0.5:8443", ca: pem, auth: { type: "secret", secret: "a".repeat(64) } },
      { id: "pi", name: "Pi", url: "https://10.0.0.5:8443", ca: pem, serverName: "pi.internal", auth: { type: "hub_key" } },
    ]);
  });
  test("no [[hosts]] means an empty list", () => {
    expect(parseConfig(hubBase(), io).hosts).toEqual([]);
  });
  test("each mistake is rejected naming the key", () => {
    expect(fails(cfgWith([host({ id: "Bad_ID" })]))).toContain("hosts[0].id");
    expect(fails(cfgWith([host({ id: "local" })]))).toContain("local");
    expect(fails(cfgWith([host(), host()]))).toMatch(/duplicate.*nas/);
    expect(fails(cfgWith([host({ url: "http://10.0.0.5:8443" })]))).toContain("hosts[0].url");
    expect(fails(cfgWith([host({ url: "https://10.0.0.5:8443/api" })]))).toContain("hosts[0].url");
    expect(fails(cfgWith([host({ ca_file: undefined })]))).toContain("hosts[0].ca_file");
    expect(fails(cfgWith([host({ bogus: 1 })]))).toContain("hosts[0].bogus");
    expect(fails(cfgWith([host({ auth: { type: "token" } })]))).toContain("hosts[0].auth.type");
    expect(fails(cfgWith([host({ auth: { type: "secret" } })]))).toContain("hosts[0].auth.secret_file");
  });
  test("an unparseable ca_file is rejected", () => {
    files["junk.pem"] = "not a certificate";
    expect(fails(cfgWith([host({ ca_file: "junk.pem" })]))).toContain("hosts[0].ca_file");
  });
  test("auth.type = oidc is rejected and names hub_key; a hub_key host needs nothing else", () => {
    expect(fails(cfgWith([host({ auth: { type: "oidc" } })]))).toContain("hub_key");
    expect(parseConfig({ ...hubBase(), hosts: [host({ auth: { type: "hub_key" } })] }, io).hosts[0]!.auth).toEqual({ type: "hub_key" });
  });
  test("secret_file group-readable is an error (via the io)", () => {
    const strict: ConfigIo = { readFile: (p, kind) => { if (kind === "secret" && p === "nas.secret") throw new Error("must not be accessible by group or others"); return files[p] ?? "x".repeat(40); } };
    expect(() => parseConfig(cfgWith([host()]), strict)).toThrow(/hosts\[0\]\.auth\.secret_file/);
  });
  test("[[hosts]] in a node file is rejected", () => {
    expect(fails({ mode: "node", tls: { names: ["x"] }, node_auth: { secret: [{ sha256: "a".repeat(64) }] }, hosts: [host()] })).toContain("hosts");
  });
});

// ---------------------------------------------------------------- client
type Rec = { method: string; path: string; search: string; headers: Headers; body: string };
const servers: { stop(force?: boolean): void }[] = [];
afterAll(() => servers.forEach((s) => s.stop(true)));

async function node(names = ["localhost", "127.0.0.1"], behaviour?: (req: Request, u: URL) => Response | Promise<Response>) {
  const c = await ensureNodeCert({ dir: tmp(), names });
  const log: Rec[] = [];
  const s = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert: c.certPem, key: c.keyPem },
    async fetch(req) {
      const u = new URL(req.url);
      log.push({ method: req.method, path: u.pathname, search: u.search, headers: req.headers, body: await req.text() });
      if (behaviour) return behaviour(req, u);
      return Response.json({ ok: true });
    },
  });
  servers.push(s);
  return { ...c, port: s.port!, log, stop: () => s.stop(true) };
}
const hostFor = (n: { certPem: string; port: number }, over: Partial<HostConfig> = {}): HostConfig => ({
  id: "nas", name: "NAS", url: `https://localhost:${n.port}`, ca: n.certPem, auth: { type: "secret", secret: "x" }, ...over,
});
const tok = secretAuthorizer("TOKEN");
const reason = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(HostError);
    return (e as HostError).reason;
  }
  throw new Error("no throw");
};

describe("host client", () => {
  test("GET reaches the node with Bearer, query, and no cookie", async () => {
    const n = await node();
    const r = await createHostClient(hostFor(n), tok).call("GET", "/api/fs", { query: { path: "/srv" } });
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(n.log[0]!.search).toBe("?path=%2Fsrv");
    expect(n.log[0]!.headers.get("authorization")).toBe("Bearer TOKEN");
    expect(n.log[0]!.headers.get("cookie")).toBeNull();
  });
  test("POST sends re-serialized JSON with content-type", async () => {
    const n = await node();
    await createHostClient(hostFor(n), tok).call("POST", "/api/instances", { json: { path: "/p", name: "x" } });
    expect(n.log[0]!.method).toBe("POST");
    expect(n.log[0]!.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(n.log[0]!.body)).toEqual({ path: "/p", name: "x" });
  });
  test("409 and 403 pass through with their bodies", async () => {
    const n = await node(undefined, (_r, u) => (u.pathname === "/a" ? Response.json({ error: "already running", instance: { id: "x" } }, { status: 409 }) : Response.json({ error: "path outside allowed roots" }, { status: 403 })));
    const c = createHostClient(hostFor(n), tok);
    expect(await c.call("GET", "/a")).toEqual({ status: 409, body: { error: "already running", instance: { id: "x" } } });
    expect(await c.call("GET", "/b")).toEqual({ status: 403, body: { error: "path outside allowed roots" } });
  });
  test("204 yields a null body", async () => {
    const n = await node(undefined, () => new Response(null, { status: 204 }));
    expect(await createHostClient(hostFor(n), tok).call("DELETE", "/api/instances/x")).toEqual({ status: 204, body: null });
  });
  test("node 401 -> rejected our credentials", async () => {
    const n = await node(undefined, () => Response.json({ error: "unauthorized" }, { status: 401 }));
    expect(await reason(createHostClient(hostFor(n), tok).call("GET", "/api/node"))).toBe("rejected our credentials");
  });
  test("an authorizer failure -> rejected our credentials, nothing sent", async () => {
    const n = await node();
    const bad = async (): Promise<string> => { throw new Error("idp down"); };
    expect(await reason(createHostClient(hostFor(n), bad).call("GET", "/api/node"))).toBe("rejected our credentials");
    expect(n.log.length).toBe(0);
  });
  test("a different cert -> certificate mismatch and that server never sees a request", async () => {
    const real = await node();
    const imposter = await node();
    const client = createHostClient(hostFor(real, { url: `https://localhost:${imposter.port}` }), tok);
    expect(await reason(client.call("GET", "/api/node"))).toBe("certificate mismatch");
    expect(imposter.log.length).toBe(0);
  });
  test("SAN not covering the URL host -> certificate mismatch", async () => {
    const n = await node(["other.internal"]);
    expect(await reason(createHostClient(hostFor(n), tok).call("GET", "/api/node"))).toBe("certificate mismatch");
    expect(n.log.length).toBe(0);
  });
  test("server_name lets us connect by IP", async () => {
    const n = await node(["pi.internal"]);
    const c = createHostClient(hostFor(n, { url: `https://127.0.0.1:${n.port}`, serverName: "pi.internal" }), tok);
    expect((await c.call("GET", "/api/node")).status).toBe(200);
  });
  test("closed port -> unreachable", async () => {
    const n = await node();
    n.stop();
    expect(await reason(createHostClient(hostFor(n), tok).call("GET", "/api/node"))).toBe("unreachable");
  });
  test("slow handler -> timeout", async () => {
    const n = await node(undefined, async () => { await Bun.sleep(500); return Response.json({}); });
    expect(await reason(createHostClient(hostFor(n), tok).call("GET", "/api/node", { timeoutMs: 100 }))).toBe("timeout");
  });
  test("3xx, non-JSON and oversized bodies -> bad response", async () => {
    const mk = async (b: (u: URL) => Response) => createHostClient(hostFor(await node(undefined, (_r, u) => b(u))), tok);
    expect(await reason((await mk(() => new Response(null, { status: 302, headers: { location: "/elsewhere" } }))).call("GET", "/x"))).toBe("bad response");
    expect(await reason((await mk(() => new Response("<html>", { status: 200 }))).call("GET", "/x"))).toBe("bad response");
    expect(await reason((await mk(() => new Response(JSON.stringify({ big: "x".repeat(1024 * 1024 + 10) }), { status: 200 }))).call("GET", "/x"))).toBe("bad response");
  });
  test("HostError message is `host <id>: <reason>`", () => {
    expect(new HostError("nas", "timeout").message).toBe("host nas: timeout");
  });
});

// ---------------------------------------------------------------- hub proofs
describe("hub-signed requests", () => {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const claims = (auth: string) => JSON.parse(Buffer.from(auth.replace(/^Hub-Proof /, "").split(".")[1]!, "base64url").toString());

  async function recording() {
    const n = await node();
    const key = await loadOrCreateHubKey(tmp());
    const host = hostFor(n, { auth: { type: "hub_key" } });
    const seen: { url: URL; init: RequestInit }[] = [];
    const fake = (async (url: URL, init: RequestInit) => {
      seen.push({ url, init });
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    return { key, host, seen, client: createHostClient(host, hubAuthorizer(key, host), { fetch: fake }) };
  }
  const authOf = (r: { init: RequestInit }) => (r.init.headers as Record<string, string>).authorization!;

  test("sends Hub-Proof that verifies for the fingerprint of host.ca, and fails for another", async () => {
    const { key, host, seen, client } = await recording();
    await client.call("GET", "/api/fs", { query: { path: "/srv" } });
    const auth = authOf(seen[0]!);
    expect(auth).toStartWith("Hub-Proof ");
    const jwt = auth.slice("Hub-Proof ".length);
    const req = { method: "GET", pathAndQuery: seen[0]!.url.pathname + seen[0]!.url.search, body: "" };
    await createProofVerifier({ keys: [key.publicKey], selfFingerprint: certFingerprint(host.ca) })(jwt, req);
    const other = certFingerprint((await ensureNodeCert({ dir: tmp(), names: ["x"] })).certPem);
    await expect(createProofVerifier({ keys: [key.publicKey], selfFingerprint: other })(jwt, req)).rejects.toThrow();
  });
  test("a POST proof binds the exact JSON string that was sent", async () => {
    const { seen, client } = await recording();
    await client.call("POST", "/api/instances", { json: { path: "/p", name: "x" } });
    const sent = seen[0]!.init.body as string;
    expect(claims(authOf(seen[0]!)).bh).toBe(sha(sent));
    expect(claims(authOf(seen[0]!)).htm).toBe("POST");
  });
  test("a GET proof binds the empty body", async () => {
    const { seen, client } = await recording();
    await client.call("GET", "/api/node");
    expect(claims(authOf(seen[0]!)).bh).toBe(sha(""));
  });
  test("secretAuthorizer returns Bearer <secret>", async () => {
    expect(await secretAuthorizer("s3")({ method: "GET", pathAndQuery: "/", body: "" })).toBe("Bearer s3");
  });
  test("against a real node: a query with a space and ampersand, a POST body, and a replayed jti", async () => {
    const c = await ensureNodeCert({ dir: tmp(), names: ["localhost", "127.0.0.1"] });
    const key = await loadOrCreateHubKey(tmp());
    const app = new Hono();
    app.use("*", nodeAuth({ hubKeys: [key.publicKey], selfFingerprint: certFingerprint(c.certPem), secretHashes: [] }));
    app.get("/api/fs", (x) => x.json({ q: new URL(x.req.url).search }));
    app.post("/api/instances", async (x) => x.json({ got: await x.req.json() }));
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: { cert: c.certPem, key: c.keyPem }, fetch: app.fetch });
    servers.push(s);
    const host = hostFor({ certPem: c.certPem, port: s.port! }, { auth: { type: "hub_key" } });
    const client = createHostClient(host, hubAuthorizer(key, host));
    const r = await client.call("GET", "/api/fs", { query: { path: "/a b", x: "1" } });
    expect(r.status).toBe(200);
    expect((r.body as { q: string }).q).toBe("?path=%2Fa+b&x=1");
    const p = await client.call("POST", "/api/instances", { json: { path: "/p\u00e9", name: "x" } });
    expect(p).toEqual({ status: 200, body: { got: { path: "/p\u00e9", name: "x" } } });
    // a different hub key is refused
    const wrong = createHostClient(host, hubAuthorizer(await loadOrCreateHubKey(tmp()), host));
    expect(await reason(wrong.call("GET", "/api/fs"))).toBe("rejected our credentials");
  });
});

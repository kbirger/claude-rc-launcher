import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfig, type ConfigIo } from "../src/config";
import { HostError, createHostClient, type HostConfig } from "../src/hostclient";
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
    hub_auth: { oidc: { token_url: "https://auth.example.com/t", client_id: "hub", auth_method: "client_secret", client_secret_file: "hub.secret" } },
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
  test("auth.type = oidc is rejected and names hub_key; a hub_key host needs no hub_auth", () => {
    expect(fails(cfgWith([host({ auth: { type: "oidc" } })]))).toContain("hub_key");
    const { hub_auth: _ignored, ...noHub } = hubBase();
    void _ignored;
    expect(parseConfig({ ...noHub, hosts: [host({ auth: { type: "hub_key" } })] }, io).hosts[0]!.auth).toEqual({ type: "hub_key" });
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
const tok = async () => "TOKEN";
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
  test("a token source failure -> rejected our credentials, nothing sent", async () => {
    const n = await node();
    const bad = async () => { throw new Error("idp down"); };
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

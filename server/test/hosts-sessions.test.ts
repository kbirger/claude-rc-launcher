import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { onError } from "../src/app";
import { hostsApi } from "../src/hosts";
import { HostError, type HostClient, type HostConfig } from "../src/hostclient";
import { HostRegistry } from "../src/hostregistry";

const ID = "0123456789ab";
const SID = "11111111-2222-3333-4444-555555555555";
const hostCfg: HostConfig = { id: "nas", name: "nas", url: "https://x:1", ca: "PEM", auth: { type: "secret", secret: "s" } };

function build(client: Partial<HostClient>, local: Hono = new Hono()) {
  const registry = HostRegistry.memory([hostCfg], new Map([["nas", { call: async () => ({ status: 200, body: {} }), stream: async () => { throw new Error("unused"); }, ...client } as HostClient]]));
  const app = new Hono();
  app.onError(onError);
  app.route("/api/hosts", hostsApi({ cfg: { name: "hub" } as any, local, registry }));
  return app;
}
const base = `/api/hosts/nas/instances/${ID}/sessions`;

describe("hub session JSON routes", () => {
  test("forward list, touched, files, file with validated query", async () => {
    const calls: any[] = [];
    const app = build({ call: (async (m: string, p: string, o: any) => (calls.push([m, p, o]), { status: 200, body: { ok: p } })) as any });
    expect((await app.request(base)).status).toBe(200);
    await app.request(`${base}/${SID}/touched`);
    await app.request(`${base}/${SID}/files?path=a%20b&hidden=1`);
    await app.request(`${base}/${SID}/file?path=x.txt`);
    expect(calls.map((c) => c[1])).toEqual([`/api/instances/${ID}/sessions`, `/api/instances/${ID}/sessions/${SID}/touched`, `/api/instances/${ID}/sessions/${SID}/files`, `/api/instances/${ID}/sessions/${SID}/file`]);
    expect(calls[2][2].query).toEqual({ path: "a b", hidden: "1" });
    expect(calls[3][2].query).toEqual({ path: "x.txt" });
  });
  test("rejects bad ids and bad paths with 400", async () => {
    const app = build({});
    expect((await app.request(`/api/hosts/nas/instances/zz/sessions`)).status).toBe(400);
    expect((await app.request(`${base}/nope/touched`)).status).toBe(400);
    expect((await app.request(`${base}/${SID}/files?path=${"a".repeat(4097)}`)).status).toBe(400);
    expect((await app.request(`${base}/${SID}/file?path=a%00b`)).status).toBe(400);
    expect((await app.request(`${base}/${SID}/download?path=a%00b`)).status).toBe(400);
    expect((await app.request(`${base}/${SID}/download`)).status).toBe(400);
  });
  test("a HostError gives 502", async () => {
    const app = build({ call: async () => { throw new HostError("nas", "unreachable"); } });
    const r = await app.request(`${base}/${SID}/touched`);
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "host nas: unreachable", host: "nas" });
  });
  test("/local session routes are reachable through hostsApi", async () => {
    const local = new Hono();
    local.get("/instances/:id/sessions", (c) => c.json([{ id: c.req.param("id") }]));
    const app = build({}, local);
    const r = await app.request(`/api/hosts/local/instances/${ID}/sessions`);
    expect(await r.json()).toEqual([{ id: ID }]);
  });
});

describe("hub download", () => {
  const nodeRes = (body: BodyInit | null, h: Record<string, string> = {}, status = 200) => ({ status, headers: new Headers(h), body: body instanceof ReadableStream ? body : body === null ? null : new Response(body).body });

  test("streams 5 MB without draining the node before the client reads", async () => {
    let sent = 0;
    const chunk = new Uint8Array(64 * 1024);
    const total = 5 * 1024 * 1024 / chunk.length;
    const body = new ReadableStream<Uint8Array>({ pull(ctl) { if (sent >= total) return ctl.close(); sent++; ctl.enqueue(chunk); } }, { highWaterMark: 0 });
    const app = build({ download: async () => nodeRes(body, { "content-length": String(total * chunk.length) }) });
    const res = await app.request(`${base}/${SID}/download?path=big.bin`);
    expect(res.status).toBe(200);
    await Bun.sleep(30);
    expect(sent).toBeLessThan(total / 2);
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBe(5 * 1024 * 1024);
    expect(sent).toBe(total);
  });

  test("forwards only the allow-listed headers and passes query + signal", async () => {
    let got: any;
    const app = build({
      download: async (p: string, o: any) => ((got = [p, o]), nodeRes("hi", { "content-type": "text/plain", "content-length": "2", "content-disposition": "inline", "x-content-type-options": "nosniff", "set-cookie": "a=b", "x-secret": "1", server: "node" })),
    });
    const res = await app.request(`${base}/${SID}/download?path=a%20b&inline=1`);
    expect(await res.text()).toBe("hi");
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("content-length")).toBe("2");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-secret")).toBeNull();
    expect(got[0]).toBe(`/api/instances/${ID}/sessions/${SID}/download`);
    expect(got[1].query).toEqual({ path: "a b", inline: "1" });
    expect(got[1].signal).toBeInstanceOf(AbortSignal);
  });

  test("cancelling the browser request aborts the signal given to the node call", async () => {
    let sig: AbortSignal | undefined;
    const app = build({ download: async (_p: string, o: any) => ((sig = o.signal), nodeRes(new ReadableStream({ pull() { return new Promise(() => {}); } }))) });
    const ctl = new AbortController();
    const res = await app.request(new Request(`http://h${base}/${SID}/download?path=a`, { signal: ctl.signal }));
    expect(res.status).toBe(200);
    expect(sig!.aborted).toBe(false);
    ctl.abort();
    expect(sig!.aborted).toBe(true);
  });

  test("a node 404 returns 404 JSON", async () => {
    const app = build({ download: async () => nodeRes(JSON.stringify({ error: "file not found" }), { "content-type": "application/json" }, 404) });
    const res = await app.request(`${base}/${SID}/download?path=a`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "file not found" });
  });

  test("a HostError gives 502; no download method gives 501", async () => {
    const app = build({ download: async () => { throw new HostError("nas", "timeout"); } });
    expect((await app.request(`${base}/${SID}/download?path=a`)).status).toBe(502);
    const r = await build({}).request(`${base}/${SID}/download?path=a`);
    expect(r.status).toBe(501);
    expect(await r.json()).toEqual({ error: "downloads are not available for this host" });
  });

  test("audit line has no file path", async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
    try {
      const app = build({ download: async () => nodeRes("x") });
      await (await app.request(`${base}/${SID}/download?path=secret.txt`)).text();
    } finally {
      console.log = orig;
    }
    const line = logs.find((l) => l.startsWith("audit"));
    expect(line).toBe("audit user=unknown host=nas GET download 200");
    expect(logs.join("\n")).not.toContain("secret.txt");
  });
});

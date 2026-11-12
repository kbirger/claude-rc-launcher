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
  test("a node 204 or 201 on a JSON route is a 502, a node 4xx or 5xx passes", async () => {
    for (const status of [204, 201, 302]) {
      const app = build({ call: async () => ({ status, body: status === 204 ? null : { x: 1 } }) });
      for (const p of ["", `/${SID}/touched`, `/${SID}/files`, `/${SID}/file?path=a`]) {
        const r = await app.request(`${base}${p}`);
        expect(r.status).toBe(502);
        expect(await r.json()).toEqual({ error: "bad response", host: "nas" });
      }
    }
    const app = build({ call: async () => ({ status: 403, body: { error: "path outside the session folder" } }) });
    const r = await app.request(`${base}/${SID}/files?path=x`);
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "path outside the session folder" });
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

  test("builds the download headers itself and passes only content-length, query and signal", async () => {
    let got: any;
    const app = build({
      download: async (p: string, o: any) => ((got = [p, o]), nodeRes("hi", { "content-type": "text/html", "content-length": "2", "content-disposition": "inline", "x-content-type-options": "nosniff", "set-cookie": "a=b", "x-secret": "1", server: "node" })),
    });
    const res = await app.request(`${base}/${SID}/download?path=${encodeURIComponent("dir/a b.html")}&inline=1`);
    expect(await res.text()).toBe("hi");
    // A node's text/html plus inline disposition must never reach the browser.
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="a b.html"; filename*=UTF-8''a%20b.html`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("content-length")).toBe("2");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-secret")).toBeNull();
    expect(res.headers.get("server")).toBeNull();
    expect(got[0]).toBe(`/api/instances/${ID}/sessions/${SID}/download`);
    expect(got[1].query).toEqual({ path: "dir/a b.html" });
    expect(got[1].signal).toBeInstanceOf(AbortSignal);
  });

  test("names the download from the last segment of the requested path, not from the node", async () => {
    const app = build({ download: async () => nodeRes("x", { "content-disposition": `attachment; filename="evil.exe"` }) });
    const res = await app.request(`${base}/${SID}/download?path=${encodeURIComponent("a/b/naïve.txt")}`);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="na_ve.txt"; filename*=UTF-8''na%C3%AFve.txt`);
    await res.text();
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

  test("a node 204 or 302 on download is a 502", async () => {
    for (const status of [204, 302, 201]) {
      const app = build({ download: async () => nodeRes(null, {}, status) });
      const res = await app.request(`${base}/${SID}/download?path=a`);
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "bad response", host: "nas" });
    }
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

describe("hub abs for touched files outside the session folder", () => {
  const nodeRes = (body: BodyInit | null, h: Record<string, string> = {}, status = 200) => ({ status, headers: new Headers(h), body: body === null ? null : new Response(body).body });

  test("file forwards abs alone and validates it", async () => {
    const calls: any[] = [];
    const app = build({ call: (async (m: string, p: string, o: any) => (calls.push([m, p, o]), { status: 200, body: {} })) as any });
    const abs = "/home/u/notes/a b#?%&+é.txt";
    expect((await app.request(`${base}/${SID}/file?abs=${encodeURIComponent(abs)}`)).status).toBe(200);
    expect(calls[0][1]).toBe(`/api/instances/${ID}/sessions/${SID}/file`);
    expect(calls[0][2].query).toEqual({ abs });
    // A Windows path passes the hub: only the node knows its own path rules.
    await app.request(`${base}/${SID}/file?abs=${encodeURIComponent("C:\\Users\\u\\a.txt")}`);
    expect(calls[1][2].query).toEqual({ abs: "C:\\Users\\u\\a.txt" });
    const n = calls.length;
    for (const q of [`abs=a%00b`, `abs=${"a".repeat(4097)}`, `abs=%2Fa&path=b`, ``]) {
      expect([q, (await app.request(`${base}/${SID}/file?${q}`)).status]).toEqual([q, 400]);
    }
    expect(calls.length).toBe(n);
  });

  test("a preview by abs gets one audit line with the status only, and no log line holds the path", async () => {
    const logs: string[] = [];
    const orig = { log: console.log, error: console.error, warn: console.warn };
    const keep = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
    console.log = console.error = console.warn = keep;
    const abs = "/home/u/.ssh/secret-name.txt";
    try {
      await (await build({ call: async () => ({ status: 200, body: { name: "x" } }) }).request(`${base}/${SID}/file?abs=${encodeURIComponent(abs)}`)).text();
      await (await build({ call: async () => ({ status: 404, body: { error: "file was not touched by this session" } }) }).request(`${base}/${SID}/file?abs=${encodeURIComponent(abs)}`)).text();
      await (await build({ call: async () => { throw new HostError("nas", "timeout"); } }).request(`${base}/${SID}/file?abs=${encodeURIComponent(abs)}`)).text();
      await (await build({ download: async () => nodeRes("x") }).request(`${base}/${SID}/download?abs=${encodeURIComponent(abs)}`)).text();
      // A preview by path is not audited.
      await (await build({ call: async () => ({ status: 200, body: {} }) }).request(`${base}/${SID}/file?path=a.txt`)).text();
    } finally {
      Object.assign(console, orig);
    }
    expect(logs.filter((l) => l.startsWith("audit"))).toEqual([
      "audit user=unknown host=nas GET preview abs 200",
      "audit user=unknown host=nas GET preview abs 404",
      "audit user=unknown host=nas GET preview abs 502",
      "audit user=unknown host=nas GET download 200",
    ]);
    expect(logs.join("\n")).not.toContain("secret-name");
    expect(logs.join("\n")).not.toContain(".ssh");
  });

  test("files does not forward abs", async () => {
    const calls: any[] = [];
    const app = build({ call: (async (m: string, p: string, o: any) => (calls.push([m, p, o]), { status: 200, body: {} })) as any });
    expect((await app.request(`${base}/${SID}/files?abs=%2Fetc`)).status).toBe(400);
    expect(calls.length).toBe(0);
  });

  test("download forwards abs, names it from its last segment and keeps the hub headers", async () => {
    const got: any[] = [];
    const app = build({ download: async (p: string, o: any) => (got.push([p, o]), nodeRes("<b>hi</b>", { "content-type": "text/html", "content-length": "9", "content-disposition": "inline; filename=evil.html" })) });
    const res = await app.request(`${base}/${SID}/download?abs=${encodeURIComponent("/home/u/out/naïve.html")}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<b>hi</b>");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="na_ve.html"; filename*=UTF-8''na%C3%AFve.html`);
    expect(got[0][0]).toBe(`/api/instances/${ID}/sessions/${SID}/download`);
    expect(got[0][1].query).toEqual({ abs: "/home/u/out/naïve.html" });
    const w = await app.request(`${base}/${SID}/download?abs=${encodeURIComponent("C:\\Users\\u\\report final.pdf")}`);
    expect(w.headers.get("content-disposition")).toBe(`attachment; filename="report final.pdf"; filename*=UTF-8''report%20final.pdf`);
    expect(got[1][1].query).toEqual({ abs: "C:\\Users\\u\\report final.pdf" });
    await w.text();
  });

  test("download refuses abs with path, a NUL, or too long, without calling the node", async () => {
    let called = 0;
    const app = build({ download: async () => (called++, nodeRes("x")) });
    for (const q of [`abs=%2Fa&path=a`, `abs=a%00b`, `abs=${"a".repeat(4097)}`, ``]) {
      expect([q, (await app.request(`${base}/${SID}/download?${q}`)).status]).toEqual([q, 400]);
    }
    expect(called).toBe(0);
  });
});

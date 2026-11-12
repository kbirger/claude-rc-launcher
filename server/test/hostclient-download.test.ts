import { describe, expect, test } from "bun:test";
import { HostError, createHostClient, secretAuthorizer, type HostConfig } from "../src/hostclient";

const host: HostConfig = { id: "nas", name: "nas", url: "https://10.0.0.5:8443", ca: "PEM", serverName: "nas.internal", auth: { type: "secret", secret: "s" } };
const mk = (fake: unknown) => createHostClient(host, secretAuthorizer("s"), { fetch: fake as typeof fetch });
const reason = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof HostError) return e.reason;
  }
  return undefined;
};

describe("HostClient.download", () => {
  test("returns the body stream without reading it", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({ pull() { pulls++; return new Promise(() => {}); } }, { highWaterMark: 0 });
    const r = await mk(async () => new Response(body, { headers: { "content-length": "99" } })).download!("/api/x/download", { query: { path: "a b" } });
    expect(r.status).toBe(200);
    expect(r.body).toBe(body);
    expect(pulls).toBe(0);
  });

  test("signs the GET, sends the query, tls options, manual redirect", async () => {
    const seen: { url: URL; init: any }[] = [];
    await mk(async (url: URL, init: any) => (seen.push({ url, init }), new Response("x"))).download!("/p", { query: { path: "a b" } });
    expect(seen[0]!.url.searchParams.get("path")).toBe("a b");
    expect(seen[0]!.init.headers.authorization).toBe("Bearer s");
    expect(seen[0]!.init.method).toBe("GET");
    expect(seen[0]!.init.redirect).toBe("manual");
    expect(seen[0]!.init.tls).toEqual({ ca: "PEM", serverName: "nas.internal" });
  });

  test("does not apply the 1 MB cap", async () => {
    const big = new Uint8Array(2 * 1024 * 1024);
    const r = await mk(async () => new Response(big, { headers: { "content-length": String(big.length) } })).download!("/p");
    expect(new Uint8Array(await new Response(r.body).arrayBuffer()).length).toBe(big.length);
  });

  test("maps a certificate error to HostError", async () => {
    const f = async () => { throw Object.assign(new Error("self signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }); };
    expect(await reason(mk(f).download!("/p"))).toBe("certificate mismatch");
  });

  test("maps 401, redirect and refusal", async () => {
    expect(await reason(mk(async () => new Response("", { status: 401 })).download!("/p"))).toBe("rejected our credentials");
    expect(await reason(mk(async () => new Response("", { status: 302, headers: { location: "/x" } })).download!("/p"))).toBe("bad response");
    expect(await reason(mk(async () => { throw Object.assign(new Error("x"), { code: "ECONNREFUSED" }); }).download!("/p"))).toBe("unreachable");
  });

  test("passes the abort signal to fetch: aborting aborts the fetch", async () => {
    let fetchSignal: AbortSignal | undefined;
    const ctl = new AbortController();
    await mk(async (_u: URL, init: any) => ((fetchSignal = init.signal), new Response("x"))).download!("/p", { signal: ctl.signal });
    expect(fetchSignal!.aborted).toBe(false);
    ctl.abort();
    expect(fetchSignal!.aborted).toBe(true);
  });

  test("header timeout applies to headers only", async () => {
    const slow = (_u: URL, init: any) => new Promise<Response>((_res, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason)));
    expect(await reason(mk(slow).download!("/p", { headerTimeoutMs: 20 }))).toBe("timeout");
    // after headers arrive, the timer is cleared: the stream outlives the timeout
    let fs: AbortSignal | undefined;
    const r = await mk(async (_u: URL, init: any) => ((fs = init.signal), new Response("x"))).download!("/p", { headerTimeoutMs: 20 });
    await Bun.sleep(60);
    expect(fs!.aborted).toBe(false);
    expect(await new Response(r.body).text()).toBe("x");
  });

  test("a response with no body gives body null", async () => {
    const r = await mk(async () => new Response(null, { status: 404 })).download!("/p");
    expect(r.status).toBe(404);
    expect(r.body).toBeNull();
  });
});

describe("HostClient.download details", () => {
  test("asks for identity encoding", async () => {
    let init: any;
    await mk(async (_u: URL, i: any) => ((init = i), new Response("x"))).download!("/p");
    expect(init.headers["accept-encoding"]).toBe("identity");
  });

  test("a fetch error after the caller aborted is thrown without a log line", async () => {
    const logs: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logs.push(a);
    try {
      const ctl = new AbortController();
      const f = (_u: URL, init: any) => new Promise<Response>((_res, rej) => {
        const no = () => rej(new DOMException("aborted", "AbortError"));
        if (init.signal.aborted) no();
        else init.signal.addEventListener("abort", no);
      });
      const p = mk(f).download!("/p", { signal: ctl.signal });
      ctl.abort();
      expect(await reason(p)).toBe("timeout");
      expect(logs).toEqual([]);
      // Without an abort, a failure is still logged.
      await reason(mk(async () => { throw Object.assign(new Error("x"), { code: "ECONNREFUSED" }); }).download!("/p"));
      expect(logs.length).toBe(1);
    } finally {
      console.error = orig;
    }
  });

  test("signs exactly the path and query that is fetched, for an awkward path", async () => {
    for (const name of ["a b#?%&é.txt", "c++ +x.txt", "dir/ü&=;.md"]) {
      const signed: string[] = [];
      let fetched: URL | undefined;
      const auth = async (req: { pathAndQuery: string }) => (signed.push(req.pathAndQuery), "Bearer s");
      const c = createHostClient(host, auth as never, { fetch: (async (u: URL) => ((fetched = u), new Response("x"))) as unknown as typeof fetch });
      await c.download!(`/api/instances/0123456789ab/sessions/11111111-2222-3333-4444-555555555555/download`, { query: { path: name } });
      expect(signed).toEqual([fetched!.pathname + fetched!.search]);
      expect(fetched!.searchParams.get("path")).toBe(name);
    }
  });
});

import { describe, expect, test } from "bun:test";
import { HostError, createHostClient, secretAuthorizer } from "../../src/hosts/client";
import type { HostConfig } from "../../src/hosts/client";
import { defined } from "../support";

const host: HostConfig = {
  id: "nas",
  name: "nas",
  url: "https://10.0.0.5:8443",
  ca: "PEM",
  serverName: "nas.internal",
  auth: { type: "secret", secret: "s" },
};
const mk = (fake: unknown) => createHostClient(host, secretAuthorizer("s"), { fetch: fake as typeof fetch });

const reason = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HostError) return error.reason;
  }

  return undefined;
};

describe("HostClient.download", () => {
  test("returns the body stream without reading it", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulls++;
          return new Promise(() => {});
        },
      },
      { highWaterMark: 0 },
    );
    const harness = await defined(
      mk(() => Promise.resolve(new Response(body, { headers: { "content-length": "99" } }))).download,
    )("/api/x/download", { query: { path: "a b" } });
    expect(harness.status).toBe(200);
    expect(harness.body).toBe(body);
    expect(pulls).toBe(0);
  });

  test("signs the GET, sends the query, tls options, manual redirect", async () => {
    const seen: { url: URL; init: any }[] = [];
    await defined(mk((url: URL, init: any) => Promise.resolve((seen.push({ url, init }), new Response("x")))).download)(
      "/p",
      {
        query: { path: "a b" },
      },
    );
    expect(seen[0].url.searchParams.get("path")).toBe("a b");
    expect(seen[0].init.headers.authorization).toBe("Bearer s");
    expect(seen[0].init.method).toBe("GET");
    expect(seen[0].init.redirect).toBe("manual");
    expect(seen[0].init.tls).toEqual({ ca: "PEM", serverName: "nas.internal" });
  });

  test("does not apply the 1 MB cap", async () => {
    const big = new Uint8Array(2 * 1024 * 1024);
    const harness = await defined(
      mk(() => Promise.resolve(new Response(big, { headers: { "content-length": String(big.length) } }))).download,
    )("/p");
    expect(new Uint8Array(await new Response(harness.body).arrayBuffer()).length).toBe(big.length);
  });

  test("maps a certificate error to HostError", async () => {
    const helper = () => {
      return Promise.reject(
        Object.assign(new Error("self signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
      );
    };

    expect(await reason(defined(mk(helper).download)("/p"))).toBe("certificate mismatch");
  });

  test("maps 401, redirect and refusal", async () => {
    expect(await reason(defined(mk(() => Promise.resolve(new Response("", { status: 401 }))).download)("/p"))).toBe(
      "rejected our credentials",
    );
    expect(
      await reason(
        defined(mk(() => Promise.resolve(new Response("", { status: 302, headers: { location: "/x" } }))).download)(
          "/p",
        ),
      ),
    ).toBe("bad response");
    expect(
      await reason(
        defined(
          mk(() => {
            return Promise.reject(Object.assign(new Error("x"), { code: "ECONNREFUSED" }));
          }).download,
        )("/p"),
      ),
    ).toBe("unreachable");
  });

  test("passes the abort signal to fetch: aborting aborts the fetch", async () => {
    let fetchSignal: AbortSignal | undefined;
    const ctl = new AbortController();
    await defined(
      mk((_u: URL, init: any) => Promise.resolve(((fetchSignal = init.signal), new Response("x")))).download,
    )("/p", {
      signal: ctl.signal,
    });
    expect(defined(fetchSignal).aborted).toBe(false);
    ctl.abort();
    expect(defined(fetchSignal).aborted).toBe(true);
  });

  test("header timeout applies to headers only", async () => {
    const slow = (_u: URL, init: any) =>
      new Promise<Response>((_res, rej) =>
        init.signal.addEventListener("abort", () => {
          rej(init.signal.reason);
        }),
      );
    expect(await reason(defined(mk(slow).download)("/p", { headerTimeoutMs: 20 }))).toBe("timeout");
    // after headers arrive, the timer is cleared: the stream outlives the timeout
    let fs: AbortSignal | undefined;
    const harness = await defined(
      mk((_u: URL, init: any) => Promise.resolve(((fs = init.signal), new Response("x")))).download,
    )("/p", {
      headerTimeoutMs: 20,
    });
    await Bun.sleep(60);
    expect(defined(fs).aborted).toBe(false);
    expect(await new Response(harness.body).text()).toBe("x");
  });

  test("a response with no body gives body null", async () => {
    const harness = await defined(mk(() => Promise.resolve(new Response(null, { status: 404 }))).download)("/p");
    expect(harness.status).toBe(404);
    expect(harness.body).toBeNull();
  });
});

describe("HostClient.download details", () => {
  test("asks for identity encoding", async () => {
    let init: any;
    await defined(mk((_u: URL, item: any) => Promise.resolve(((init = item), new Response("x")))).download)("/p");
    expect(init.headers["accept-encoding"]).toBe("identity");
  });

  test("a fetch error after the caller aborted is thrown without a log line", async () => {
    const logs: unknown[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => void logs.push(args);

    try {
      const ctl = new AbortController();
      const helper = (_u: URL, init: any) =>
        new Promise<Response>((_res, rej) => {
          const no = () => {
            rej(new DOMException("aborted", "AbortError"));
          };

          if (init.signal.aborted) no();
          else init.signal.addEventListener("abort", no);
        });
      const promise = defined(mk(helper).download)("/p", { signal: ctl.signal });
      ctl.abort();
      expect(await reason(promise)).toBe("timeout");
      expect(logs).toEqual([]);
      // Without an abort, a failure is still logged.
      await reason(
        defined(
          mk(() => {
            return Promise.reject(Object.assign(new Error("x"), { code: "ECONNREFUSED" }));
          }).download,
        )("/p"),
      );
      expect(logs.length).toBe(1);
    } finally {
      console.error = orig;
    }
  });

  test("signs exactly the path and query that is fetched, for an awkward path", async () => {
    for (const name of ["a b#?%&é.txt", "c++ +x.txt", "dir/ü&=;.md"]) {
      const signed: string[] = [];
      let fetched: URL | undefined;
      const auth = (req: { pathAndQuery: string }) => Promise.resolve((signed.push(req.pathAndQuery), "Bearer s"));
      const hostClient = createHostClient(host, auth, {
        fetch: ((parsedUrl: URL) =>
          Promise.resolve(((fetched = parsedUrl), new Response("x")))) as unknown as typeof fetch,
      });
      await defined(hostClient.download)(
        `/api/instances/0123456789ab/sessions/11111111-2222-3333-4444-555555555555/download`,
        {
          query: { path: name },
        },
      );
      expect(signed).toEqual([defined(fetched).pathname + defined(fetched).search]);
      expect(defined(fetched).searchParams.get("path")).toBe(name);
    }
  });
});

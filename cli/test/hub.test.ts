import { afterAll, describe, expect, test } from "bun:test";
import { parseCli } from "../src/args";
import { ExitError, LOGIN_MESSAGE } from "../src/creds";
import type { Credentials } from "../src/creds";
import { hubClient, HubError } from "../src/hub";
import { rejection, defined } from "./support";

interface Req {
  method: string;
  path: string;
  auth: string | null;
  ctype: string | null;
  body: string;
}
const stops: (() => void)[] = [];
afterAll(() => {
  stops.forEach((stop) => {
    stop();
  });
});

function fakeHub(handler: (req: Req, other: number) => Response) {
  const seen: Req[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const item = {
        method: req.method,
        path: new URL(req.url).pathname + new URL(req.url).search,
        auth: req.headers.get("authorization"),
        ctype: req.headers.get("content-type"),
        body: await req.text(),
      };
      seen.push(item);
      return handler(item, seen.length);
    },
  });
  stops.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, seen };
}

const creds = (hub: string, over: Partial<Credentials> = {}): Credentials => ({
  hub,
  issuer: "i",
  clientId: "c",
  tokenEndpoint: "t",
  idToken: "tok1",
  refreshToken: "r",
  expiresAt: 10_000,
  ...over,
});
const json = (item: unknown, status = 200) =>
  new Response(JSON.stringify(item), { status, headers: { "content-type": "application/json" } });

describe("hubClient.request", () => {
  test("sends the bearer token, and JSON content type on writes", async () => {
    const hub = fakeHub(() => json({ ok: 1 }));
    const client = hubClient({
      creds: creds(hub.url),
      save: () => {},
      renew: (credentials) => Promise.resolve(credentials),
      now: () => 0,
    });
    expect(await client.request("GET", "/cli/api/hosts")).toEqual({ ok: 1 });
    await client.request("POST", "/cli/api/hosts/local/instances", { path: "/p" });
    expect(hub.seen[0]).toMatchObject({ method: "GET", auth: "Bearer tok1", path: "/cli/api/hosts" });
    expect(hub.seen[1]).toMatchObject({
      method: "POST",
      ctype: "application/json",
      body: JSON.stringify({ path: "/p" }),
    });
  });
  test("renews before the call when the token has under 60 seconds left, and saves the result", async () => {
    const hub = fakeHub(() => json({}));
    const saved: Credentials[] = [];
    const client = hubClient({
      creds: creds(hub.url, { expiresAt: 130 }),
      save: (credentials) => saved.push(credentials),
      renew: (credentials) => Promise.resolve({ ...credentials, idToken: "tok2", expiresAt: 9999 }),
      now: () => 100,
    });
    await client.request("GET", "/cli/api/me");
    expect(hub.seen[0].auth).toBe("Bearer tok2");
    expect(saved).toHaveLength(1);
  });
  test("does not renew when the token is fresh", async () => {
    const hub = fakeHub(() => json({}));
    let renews = 0;
    const client = hubClient({
      creds: creds(hub.url, { expiresAt: 1000 }),
      save: () => {},
      renew: (credentials) => Promise.resolve((renews++, credentials)),
      now: () => 100,
    });
    await client.request("GET", "/cli/api/me");
    expect(renews).toBe(0);
  });
  test("two calls near expiry share one renewal", async () => {
    const hub = fakeHub(() => json({}));
    let renews = 0;

    const renew = async (credentials: Credentials) => {
      renews++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ...credentials, idToken: "tok2", expiresAt: 9999 };
    };

    const client = hubClient({ creds: creds(hub.url, { expiresAt: 130 }), save: () => {}, renew, now: () => 100 });
    const ac = new AbortController();
    const reading = (async () => {
      for await (const _unused of client.stream("/cli/api/events", { signal: ac.signal })) {
        /* none */
      }
    })().catch(() => {});
    await Promise.all([client.request("GET", "/cli/api/me"), client.request("GET", "/cli/api/me")]);
    ac.abort();
    await reading;
    expect(renews).toBe(1);
  });
  test("a 401 renews once and retries once", async () => {
    const hub = fakeHub((_r, count) => (count === 1 ? json({ error: "unauthenticated" }, 401) : json({ ok: true })));
    const client = hubClient({
      creds: creds(hub.url, { expiresAt: 1000 }),
      save: () => {},
      renew: (credentials) => Promise.resolve({ ...credentials, idToken: "tok2" }),
      now: () => 0,
    });
    expect(await client.request("GET", "/cli/api/me")).toEqual({ ok: true });
    expect(hub.seen.map((req) => req.auth)).toEqual(["Bearer tok1", "Bearer tok2"]);
  });
  test("a 401 then a failed renewal is ExitError code 2 with the login message", async () => {
    const hub = fakeHub(() => json({ error: "unauthenticated" }, 401));
    const client = hubClient({
      creds: creds(hub.url, { expiresAt: 1000 }),
      save: () => {},
      renew: () => {
        return Promise.reject(new ExitError(LOGIN_MESSAGE, 2));
      },
      now: () => 0,
    });
    const value = await client.request("GET", "/cli/api/me").catch((error) => error);
    expect(value).toBeInstanceOf(ExitError);
    expect(value).toMatchObject({ code: 2, message: 'not signed in or the login expired: run "claude-rc login"' });
  });
  test("a renewal that cannot reach the identity provider keeps its message and exit code 1", async () => {
    const hub = fakeHub(() => json({ error: "unauthenticated" }, 401));
    const down = new ExitError(
      "cannot reach the identity provider at https://idp.example/token: connection refused",
      1,
    );
    const client = hubClient({
      creds: creds(hub.url, { expiresAt: 1000 }),
      save: () => {},
      renew: () => {
        return Promise.reject(down);
      },
      now: () => 0,
    });
    const value = await client.request("GET", "/cli/api/me").catch((error) => error);
    expect(value).toBe(down);
    expect(value).toMatchObject({ code: 1 });
    expect(hub.seen.length).toBe(1);
  });
  test("the same happens when the token is renewed before the call", async () => {
    const hub = fakeHub(() => json({ ok: 1 }));
    const client = hubClient({
      creds: creds(hub.url, { expiresAt: 130 }),
      save: () => {},
      renew: () => {
        return Promise.reject(new ExitError("cannot reach the identity provider at t: down", 1));
      },
      now: () => 100,
    });
    const value = await client.request("GET", "/cli/api/me").catch((error) => error);
    expect(value).toMatchObject({ code: 1, message: "cannot reach the identity provider at t: down" });
    expect(hub.seen.length).toBe(0);
  });
  test("an unexpected error from the renewal is exit code 1 and keeps its message", async () => {
    const hub = fakeHub(() => json({ error: "unauthenticated" }, 401));
    const client = hubClient({
      creds: creds(hub.url, { expiresAt: 1000 }),
      save: () => {},
      renew: () => {
        return Promise.reject(new TypeError("boom"));
      },
      now: () => 0,
    });
    const value = await client.request("GET", "/cli/api/me").catch((error) => error);
    expect(value).toBeInstanceOf(ExitError);
    expect(value).toMatchObject({ code: 1 });
    expect((value as Error).message).toContain("boom");
    expect((value as Error).message).not.toContain("claude-rc login");
  });
  test("a second 401 after a good renewal is ExitError code 2", async () => {
    const hub = fakeHub(() => json({ error: "unauthenticated" }, 401));
    const client = hubClient({
      creds: creds(hub.url, { expiresAt: 1000 }),
      save: () => {},
      renew: (credentials) => Promise.resolve(credentials),
      now: () => 0,
    });
    expect(await rejection(client.request("GET", "/cli/api/me"))).toMatchObject({ code: 2 });
    expect(hub.seen).toHaveLength(2);
  });
  test("the hub error text becomes the ExitError message with code 1", async () => {
    const hub = fakeHub(() => json({ error: "already running" }, 409));
    const client = hubClient({
      creds: creds(hub.url, { expiresAt: 1000 }),
      save: () => {},
      renew: (credentials) => Promise.resolve(credentials),
      now: () => 0,
    });
    expect(await rejection(client.request("POST", "/cli/api/hosts/local/instances", {}))).toMatchObject({
      code: 1,
      message: "already running",
    });
  });
  test("request throws HubError with status and body", async () => {
    const hub = fakeHub(() => json({ error: "untrusted folder", code: "untrusted" }, 428));
    const client = hubClient({
      creds: creds(hub.url, { expiresAt: 1000 }),
      save: () => {},
      renew: (credentials) => Promise.resolve(credentials),
      now: () => 0,
    });
    const value = await client.request("POST", "/x", {}).catch((error) => error);
    expect(value).toBeInstanceOf(HubError);
    expect(value).toBeInstanceOf(ExitError);
    expect(value).toMatchObject({
      status: 428,
      code: 1,
      message: "untrusted folder",
      body: { error: "untrusted folder", code: "untrusted" },
    });
  });
  test("204 returns undefined", async () => {
    const hub = fakeHub(() => new Response(null, { status: 204 }));
    const client = hubClient({
      creds: creds(hub.url, { expiresAt: 1000 }),
      save: () => {},
      renew: (credentials) => Promise.resolve(credentials),
      now: () => 0,
    });
    expect(await client.request("DELETE", "/cli/api/hosts/x")).toBeUndefined();
  });
  test("a hub that cannot be reached is ExitError code 1 naming the hub", async () => {
    const client = hubClient({
      creds: creds("http://127.0.0.1:1", { expiresAt: 1000 }),
      save: () => {},
      renew: (credentials) => Promise.resolve(credentials),
      now: () => 0,
    });
    expect(await rejection(client.request("GET", "/cli/api/me"))).toMatchObject({
      code: 1,
      message: expect.stringContaining("http://127.0.0.1:1"),
    });
  });
  test("timeoutMs limits one call only; other calls get no signal", async () => {
    const inits: (RequestInit | undefined)[] = [];
    const slow = (async (_u: string | URL, init?: RequestInit) => {
      inits.push(init);
      if (!init?.signal) return json({ ok: 1 });
      return await new Promise<Response>((_unused, reject) => {
        defined(init.signal).addEventListener("abort", () => {
          reject(new Error("timed out"));
        });
      });
    }) as unknown as typeof fetch;
    const client = hubClient({
      creds: creds("http://hub", { expiresAt: 1000 }),
      save: () => {},
      renew: (credentials) => Promise.resolve(credentials),
      now: () => 0,
      fetch: slow,
    });
    expect(await rejection(client.request("POST", "/cli/api/hosts/a/update", {}, { timeoutMs: 20 }))).toMatchObject({
      code: 1,
      message: expect.stringContaining("timed out"),
    });
    expect(await client.request("GET", "/cli/api/hosts")).toEqual({ ok: 1 });
    expect(defined(inits[0]).signal).toBeDefined();
    expect(defined(inits[1]).signal).toBeUndefined();
  });
});

describe("parseCli", () => {
  test("splits the command from flags", () => {
    const cli = parseCli(["host", "add", "nas", "--url", "https://x:1", "--force", "--json"]);
    expect(cli.command).toEqual(["host", "add", "nas"]);
    expect(cli.flags).toMatchObject({ url: "https://x:1", force: true, json: true });
  });
  test("--all-nodes is a boolean flag", () => {
    const cli = parseCli(["update", "--all-nodes", "--release", "v1.2.3"]);
    expect(cli.command).toEqual(["update"]);
    expect(cli.flags).toMatchObject({ "all-nodes": true, release: "v1.2.3" });
  });
  test("rejects unknown flags with a clear message", () => {
    expect(() => parseCli(["list", "--bogus"])).toThrow(ExitError);
    expect(() => parseCli(["list", "--bogus"])).toThrow("--bogus");
  });
});

describe("hubClient.stream", () => {
  const sse = (body: string) => new Response(body, { headers: { "content-type": "text/event-stream" } });
  test("parses events and sends the bearer token", async () => {
    const hub = fakeHub(() => sse(': keepalive\n\nevent: log\ndata: {"a":1}\n\nevent: presence\ndata: x\n\n'));
    const client = hubClient({
      creds: creds(hub.url),
      save: () => {},
      renew: (credentials) => Promise.resolve(credentials),
      now: () => 0,
    });
    const got: { event: string; data: string }[] = [];
    for await (const sseEvent of client.stream("/cli/api/events")) got.push(sseEvent);
    expect(got).toEqual([
      { event: "log", data: '{"a":1}' },
      { event: "presence", data: "x" },
    ]);
    expect(hub.seen[0].auth).toBe("Bearer tok1");
    expect(hub.seen[0].path).toBe("/cli/api/events");
  });
  test("renews once after a 401", async () => {
    const hub = fakeHub((req) =>
      req.auth === "Bearer tok1" ? json({ error: "no" }, 401) : sse("event: log\ndata: 1\n\n"),
    );
    let renewed = 0;
    const client = hubClient({
      creds: creds(hub.url),
      save: () => {},
      renew: (credentials) => Promise.resolve((renewed++, { ...credentials, idToken: "tok2" })),
      now: () => 0,
    });
    const got: unknown[] = [];
    for await (const sseEvent of client.stream("/cli/api/events")) got.push(sseEvent);
    expect(renewed).toBe(1);
    expect(got).toHaveLength(1);
    expect(hub.seen.map((req) => req.auth)).toEqual(["Bearer tok1", "Bearer tok2"]);
  });
  test("a second 401 is a login error, and other statuses throw HubError", async () => {
    const hub = fakeHub(() => json({ error: "no" }, 401));
    const client = hubClient({
      creds: creds(hub.url),
      save: () => {},
      renew: (credentials) => Promise.resolve(credentials),
      now: () => 0,
    });
    expect(
      await rejection(
        (async () => {
          for await (const _unused of client.stream("/x")) {
            /* none */
          }
        })(),
      ),
    ).toMatchObject({ code: 2 });
    const h2 = fakeHub(() => json({ error: "nf" }, 404));
    const c2 = hubClient({
      creds: creds(h2.url),
      save: () => {},
      renew: (credentials) => Promise.resolve(credentials),
      now: () => 0,
    });
    const value = await (async () => {
      for await (const _unused of c2.stream("/x")) {
        /* none */
      }
    })().catch((error) => error);
    expect(value).toBeInstanceOf(HubError);
    expect(value.status).toBe(404);
  });
  test("ends on abort", async () => {
    const hub = fakeHub(
      () =>
        new Response(
          new ReadableStream({
            start(ctl) {
              ctl.enqueue(new TextEncoder().encode("event: log\ndata: 1\n\n"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const client = hubClient({
      creds: creds(hub.url),
      save: () => {},
      renew: (credentials) => Promise.resolve(credentials),
      now: () => 0,
    });
    const ac = new AbortController();
    const got: unknown[] = [];

    for await (const sseEvent of client.stream("/cli/api/events", { signal: ac.signal })) {
      got.push(sseEvent);
      ac.abort();
    }

    expect(got).toHaveLength(1);
  });
});

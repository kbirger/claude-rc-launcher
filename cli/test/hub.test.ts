import { afterAll, describe, expect, test } from "bun:test";
import { ExitError, type Credentials } from "../src/creds";
import { hubClient } from "../src/hub";
import { parseCli } from "../src/args";

type Req = { method: string; path: string; auth: string | null; ctype: string | null; body: string };
const stops: (() => void)[] = [];
afterAll(() => stops.forEach((s) => s()));

function fakeHub(handler: (r: Req, n: number) => Response) {
  const seen: Req[] = [];
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const r = { method: req.method, path: new URL(req.url).pathname + new URL(req.url).search, auth: req.headers.get("authorization"), ctype: req.headers.get("content-type"), body: await req.text() };
      seen.push(r);
      return handler(r, seen.length);
    },
  });
  stops.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, seen };
}
const creds = (hub: string, over: Partial<Credentials> = {}): Credentials => ({
  hub, issuer: "i", clientId: "c", tokenEndpoint: "t", idToken: "tok1", refreshToken: "r", expiresAt: 10_000, ...over,
});
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

describe("hubClient.request", () => {
  test("sends the bearer token, and JSON content type on writes", async () => {
    const h = fakeHub(() => json({ ok: 1 }));
    const c = hubClient({ creds: creds(h.url), save: () => {}, renew: async (x) => x, now: () => 0 });
    expect(await c.request("GET", "/cli/api/hosts")).toEqual({ ok: 1 });
    await c.request("POST", "/cli/api/hosts/local/instances", { path: "/p" });
    expect(h.seen[0]).toMatchObject({ method: "GET", auth: "Bearer tok1", path: "/cli/api/hosts" });
    expect(h.seen[1]).toMatchObject({ method: "POST", ctype: "application/json", body: JSON.stringify({ path: "/p" }) });
  });
  test("renews before the call when the token has under 60 seconds left, and saves the result", async () => {
    const h = fakeHub(() => json({}));
    const saved: Credentials[] = [];
    const c = hubClient({ creds: creds(h.url, { expiresAt: 130 }), save: (x) => saved.push(x), renew: async (x) => ({ ...x, idToken: "tok2", expiresAt: 9999 }), now: () => 100 });
    await c.request("GET", "/cli/api/me");
    expect(h.seen[0]!.auth).toBe("Bearer tok2");
    expect(saved).toHaveLength(1);
  });
  test("does not renew when the token is fresh", async () => {
    const h = fakeHub(() => json({}));
    let renews = 0;
    const c = hubClient({ creds: creds(h.url, { expiresAt: 1000 }), save: () => {}, renew: async (x) => (renews++, x), now: () => 100 });
    await c.request("GET", "/cli/api/me");
    expect(renews).toBe(0);
  });
  test("a 401 renews once and retries once", async () => {
    const h = fakeHub((_r, n) => (n === 1 ? json({ error: "unauthenticated" }, 401) : json({ ok: true })));
    const c = hubClient({ creds: creds(h.url, { expiresAt: 1000 }), save: () => {}, renew: async (x) => ({ ...x, idToken: "tok2" }), now: () => 0 });
    expect(await c.request("GET", "/cli/api/me")).toEqual({ ok: true });
    expect(h.seen.map((r) => r.auth)).toEqual(["Bearer tok1", "Bearer tok2"]);
  });
  test("a 401 then a failed renewal is ExitError code 2 with the login message", async () => {
    const h = fakeHub(() => json({ error: "unauthenticated" }, 401));
    const c = hubClient({ creds: creds(h.url, { expiresAt: 1000 }), save: () => {}, renew: async () => { throw new Error("rejected"); }, now: () => 0 });
    const e = await c.request("GET", "/cli/api/me").catch((x) => x);
    expect(e).toBeInstanceOf(ExitError);
    expect(e).toMatchObject({ code: 2, message: 'not signed in or the login expired: run "claude-rc login"' });
  });
  test("a second 401 after a good renewal is ExitError code 2", async () => {
    const h = fakeHub(() => json({ error: "unauthenticated" }, 401));
    const c = hubClient({ creds: creds(h.url, { expiresAt: 1000 }), save: () => {}, renew: async (x) => x, now: () => 0 });
    await expect(c.request("GET", "/cli/api/me")).rejects.toMatchObject({ code: 2 });
    expect(h.seen).toHaveLength(2);
  });
  test("the hub error text becomes the ExitError message with code 1", async () => {
    const h = fakeHub(() => json({ error: "already running" }, 409));
    const c = hubClient({ creds: creds(h.url, { expiresAt: 1000 }), save: () => {}, renew: async (x) => x, now: () => 0 });
    await expect(c.request("POST", "/cli/api/hosts/local/instances", {})).rejects.toMatchObject({ code: 1, message: "already running" });
  });
  test("204 returns undefined", async () => {
    const h = fakeHub(() => new Response(null, { status: 204 }));
    const c = hubClient({ creds: creds(h.url, { expiresAt: 1000 }), save: () => {}, renew: async (x) => x, now: () => 0 });
    expect(await c.request("DELETE", "/cli/api/hosts/x")).toBeUndefined();
  });
  test("a hub that cannot be reached is ExitError code 1 naming the hub", async () => {
    const c = hubClient({ creds: creds("http://127.0.0.1:1", { expiresAt: 1000 }), save: () => {}, renew: async (x) => x, now: () => 0 });
    await expect(c.request("GET", "/cli/api/me")).rejects.toMatchObject({ code: 1, message: expect.stringContaining("http://127.0.0.1:1") });
  });
});

describe("parseCli", () => {
  test("splits the command from flags", () => {
    const p = parseCli(["host", "add", "nas", "--url", "https://x:1", "--force", "--json"]);
    expect(p.command).toEqual(["host", "add", "nas"]);
    expect(p.flags).toMatchObject({ url: "https://x:1", force: true, json: true });
  });
  test("rejects unknown flags with a clear message", () => {
    expect(() => parseCli(["list", "--bogus"])).toThrow(ExitError);
    expect(() => parseCli(["list", "--bogus"])).toThrow("--bogus");
  });
});

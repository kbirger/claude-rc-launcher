import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ExitError, type Credentials } from "../src/creds";
import { login, logout, renew } from "../src/oidc";

const stops: (() => void)[] = [];
afterAll(() => stops.forEach((s) => s()));
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const unsigned = (claims: Record<string, unknown>) => `${b64({ alg: "none" })}.${b64(claims)}.sig`;
const sha = (s: string) => createHash("sha256").update(s).digest("base64url");

type Mode = "ok" | "wrong-state-first" | "denied" | "wrong-nonce";
function fakeIdp(mode: Mode = "ok") {
  const log = { authorize: [] as URLSearchParams[], token: [] as URLSearchParams[], revoke: [] as URLSearchParams[], challenge: "", nonce: "" };
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req): Promise<Response> {
      const u = new URL(req.url);
      const base = `http://127.0.0.1:${server.port}`;
      if (u.pathname.endsWith("/.well-known/openid-configuration")) {
        return Response.json({ issuer: `${base}/o/cli/`, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, revocation_endpoint: `${base}/revoke` });
      }
      if (u.pathname === "/authorize") {
        const q = u.searchParams;
        log.authorize.push(q);
        log.challenge = q.get("code_challenge")!;
        log.nonce = q.get("nonce")!;
        const redirect = q.get("redirect_uri")!;
        const visit = (qs: string) => fetch(`${redirect}?${qs}`).catch(() => {}); // the browser being sent back
        if (mode === "wrong-state-first") await visit("code=evil&state=wrong");
        if (mode === "denied") await visit(`error=access_denied&error_description=${encodeURIComponent("user said no")}&state=${q.get("state")}`);
        else await visit(`code=C1&state=${q.get("state")}`);
        return new Response("ok");
      }
      if (u.pathname === "/token") {
        const f = new URLSearchParams(await req.text());
        log.token.push(f);
        if (f.has("client_secret")) return Response.json({ error: "invalid_client" }, { status: 400 });
        const exp = Math.floor(Date.now() / 1000) + 300;
        if (f.get("grant_type") === "authorization_code") {
          if (f.get("code") !== "C1" || sha(f.get("code_verifier")!) !== log.challenge) return Response.json({ error: "invalid_grant" }, { status: 400 });
          return Response.json({ id_token: unsigned({ sub: "u1", nonce: mode === "wrong-nonce" ? "other" : log.nonce, exp }), refresh_token: "R1", expires_in: 300 });
        }
        if (f.get("refresh_token") !== "R1") return Response.json({ error: "invalid_grant", error_description: "revoked" }, { status: 400 });
        return Response.json({ id_token: unsigned({ sub: "u1", exp: exp + 1 }), expires_in: 300 });
      }
      if (u.pathname === "/revoke") {
        log.revoke.push(new URLSearchParams(await req.text()));
        return new Response(null, { status: 200 });
      }
      return new Response("nope", { status: 404 });
    },
  });
  stops.push(() => server.stop(true));
  return { base: `http://127.0.0.1:${server.port}`, log, stop: () => server.stop(true) };
}

function fakeHub(idpBase: string) {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ issuer: `${idpBase}/o/cli/`, client_id: "cli" }) });
  stops.push(() => server.stop(true));
  return `http://127.0.0.1:${server.port}`;
}

const openViaFetch = async (url: string) => void (await fetch(url));
const base = (idp: ReturnType<typeof fakeIdp>, over: Partial<Parameters<typeof login>[0]> = {}) => ({
  hub: fakeHub(idp.base), noBrowser: false, open: openViaFetch, readLine: async () => "", log: () => {}, timeoutMs: 3000, ...over,
});

describe("login", () => {
  test("happy path saves tokens, endpoints and expiry", async () => {
    const idp = fakeIdp();
    const o = base(idp);
    const c = await login(o);
    expect(c).toMatchObject({ hub: o.hub, clientId: "cli", tokenEndpoint: `${idp.base}/token`, revocationEndpoint: `${idp.base}/revoke`, refreshToken: "R1" });
    expect(c.idToken.split(".")).toHaveLength(3);
    expect(c.expiresAt).toBeGreaterThan(Date.now() / 1000);
    const q = idp.log.authorize[0]!;
    expect(q.get("scope")).toBe("openid email profile offline_access");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe("cli");
    expect(q.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });

  test("sends no client_secret", async () => {
    const idp = fakeIdp();
    await login(base(idp));
    expect(idp.log.token[0]!.has("client_secret")).toBe(false);
    expect(idp.log.token[0]!.get("client_id")).toBe("cli");
  });

  test("a callback with the wrong state is ignored and the right one still completes", async () => {
    const idp = fakeIdp("wrong-state-first");
    const c = await login(base(idp));
    expect(c.refreshToken).toBe("R1");
    expect(idp.log.token).toHaveLength(1);
    expect(idp.log.token[0]!.get("code")).toBe("C1");
  });

  test("an error from the identity provider fails the login with its text and closes the listener", async () => {
    const idp = fakeIdp("denied");
    await expect(login(base(idp))).rejects.toThrow("user said no");
    const redirect = idp.log.authorize[0]!.get("redirect_uri")!;
    await expect(fetch(redirect)).rejects.toBeDefined();
  });

  test("a wrong nonce in the ID token fails the login", async () => {
    const idp = fakeIdp("wrong-nonce");
    await expect(login(base(idp))).rejects.toThrow("nonce");
  });

  test("--no-browser prints the URL and accepts a pasted redirect URL", async () => {
    const idp = fakeIdp();
    const printed: string[] = [];
    const c = await login(
      base(idp, {
        noBrowser: true,
        open: async () => { throw new Error("must not open a browser"); },
        log: (s) => printed.push(s),
        readLine: async () => {
          const url = new URL(printed.find((l) => l.startsWith("http"))!);
          await fetch(url).catch(() => {}); // the browser visit: lets the fake provider record the PKCE challenge and nonce
          return `${url.searchParams.get("redirect_uri")}?code=C1&state=${url.searchParams.get("state")}`;
        },
      }),
    );
    expect(c.refreshToken).toBe("R1");
    expect(printed.some((l) => l.startsWith(`${idp.base}/authorize?`))).toBe(true);
  });

  test("a hub URL or issuer that is plain http on a non-loopback host is refused before anything is sent", async () => {
    let calls = 0;
    const f = (async () => (calls++, Response.json({}))) as unknown as typeof fetch;
    const o = { noBrowser: false, open: openViaFetch, readLine: async () => "", log: () => {}, timeoutMs: 200, fetch: f };
    await expect(login({ ...o, hub: "http://hub.example.com" })).rejects.toThrow("https");
    expect(calls).toBe(0);
    const g = (async (url: string) => (String(url).endsWith("/cli/config") ? Response.json({ issuer: "http://idp.example.com/o/", client_id: "c" }) : Response.json({}))) as unknown as typeof fetch;
    await expect(login({ ...o, hub: "https://hub.example.com", fetch: g })).rejects.toThrow("https");
  });

  test("a hub that answers /cli/config with a web page or a redirect gets an explanation", async () => {
    const o = { hub: "https://hub.example.com", noBrowser: false, open: openViaFetch, readLine: async () => "", log: () => {}, timeoutMs: 200 };
    const html = (async () => new Response("<!doctype html><title>login</title>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const redirect = (async () => new Response(null, { status: 302, headers: { location: "/auth/login" } })) as unknown as typeof fetch;
    for (const f of [html, redirect]) {
      const e = await login({ ...o, fetch: f }).catch((x) => x);
      expect(e).toBeInstanceOf(ExitError);
      expect(e.message).toContain("[cli_auth");
      expect(e.message).toContain("/cli/");
      expect(e.message).not.toContain("JSON Parse");
    }
  });

  test("a login that nobody completes times out", async () => {
    const idp = fakeIdp();
    await expect(login(base(idp, { open: async () => {}, timeoutMs: 200 }))).rejects.toThrow("timed out");
  });
});

const sample = (idp: ReturnType<typeof fakeIdp>, over: Partial<Credentials> = {}): Credentials => ({
  hub: "https://hub", issuer: `${idp.base}/o/cli/`, clientId: "cli", tokenEndpoint: `${idp.base}/token`, revocationEndpoint: `${idp.base}/revoke`,
  idToken: "old", refreshToken: "R1", expiresAt: 1, ...over,
});

describe("renew", () => {
  test("stores the new ID token and expiry and keeps the old refresh token when none is returned", async () => {
    const idp = fakeIdp();
    const c = await renew(sample(idp));
    expect(c.idToken).not.toBe("old");
    expect(c.refreshToken).toBe("R1");
    expect(c.expiresAt).toBeGreaterThan(Date.now() / 1000);
    expect(idp.log.token[0]!.get("grant_type")).toBe("refresh_token");
    expect(idp.log.token[0]!.has("client_secret")).toBe(false);
  });
  test("a rejected refresh token is ExitError code 2", async () => {
    const idp = fakeIdp();
    await expect(renew(sample(idp, { refreshToken: "bad" }))).rejects.toMatchObject({ name: "ExitError", code: 2 });
  });
  test("no refresh token is ExitError code 2", async () => {
    const idp = fakeIdp();
    await expect(renew(sample(idp, { refreshToken: undefined }))).rejects.toBeInstanceOf(ExitError);
  });
});

describe("logout", () => {
  test("revokes the refresh token", async () => {
    const idp = fakeIdp();
    await logout(sample(idp));
    expect(idp.log.revoke[0]!.get("token")).toBe("R1");
    expect(idp.log.revoke[0]!.get("client_id")).toBe("cli");
  });
  test("never throws when the identity provider is down", async () => {
    const idp = fakeIdp();
    const c = sample(idp);
    idp.stop();
    await logout(c);
  });
});

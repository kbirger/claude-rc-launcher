import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ExitError } from "../src/creds";
import type { Credentials } from "../src/creds";
import { login, logout, renew } from "../src/oidc";
import { rejection, defined } from "./support";

const stops: (() => void)[] = [];
afterAll(() => {
  stops.forEach((stop) => {
    stop();
  });
});
const b64 = (item: unknown) => Buffer.from(JSON.stringify(item)).toString("base64url");
const unsigned = (claims: Record<string, unknown>) => `${b64({ alg: "none" })}.${b64(claims)}.sig`;
const sha = (item: string) => createHash("sha256").update(item).digest("base64url");

type Mode = "ok" | "wrong-state-first" | "denied" | "wrong-nonce";

function fakeIdp(mode: Mode = "ok") {
  const log = {
    authorize: [] as URLSearchParams[],
    token: [] as URLSearchParams[],
    revoke: [] as URLSearchParams[],
    challenge: "",
    nonce: "",
  };
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req): Promise<Response> {
      const parsedUrl = new URL(req.url);
      const base = `http://127.0.0.1:${server.port}`;

      if (parsedUrl.pathname.endsWith("/.well-known/openid-configuration")) {
        return Response.json({
          issuer: `${base}/o/cli/`,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          revocation_endpoint: `${base}/revoke`,
        });
      }

      if (parsedUrl.pathname === "/authorize") {
        const urlSearchParams = parsedUrl.searchParams;
        log.authorize.push(urlSearchParams);
        log.challenge = defined(urlSearchParams.get("code_challenge"));
        log.nonce = defined(urlSearchParams.get("nonce"));
        const redirect = defined(urlSearchParams.get("redirect_uri"));
        const visit = (qs: string) => fetch(`${redirect}?${qs}`).catch(() => {}); // the browser being sent back
        if (mode === "wrong-state-first") await visit("code=evil&state=wrong");
        if (mode === "denied")
          await visit(
            `error=access_denied&error_description=${encodeURIComponent("user said no")}&state=${urlSearchParams.get("state")}`,
          );
        else await visit(`code=C1&state=${urlSearchParams.get("state")}`);
        return new Response("ok");
      }

      if (parsedUrl.pathname === "/token") {
        const searchParams = new URLSearchParams(await req.text());
        log.token.push(searchParams);
        if (searchParams.has("client_secret")) return Response.json({ error: "invalid_client" }, { status: 400 });
        const exp = Math.floor(Date.now() / 1000) + 300;

        if (searchParams.get("grant_type") === "authorization_code") {
          if (searchParams.get("code") !== "C1" || sha(defined(searchParams.get("code_verifier"))) !== log.challenge)
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          return Response.json({
            id_token: unsigned({ sub: "u1", nonce: mode === "wrong-nonce" ? "other" : log.nonce, exp }),
            refresh_token: "R1",
            expires_in: 300,
          });
        }

        if (searchParams.get("refresh_token") !== "R1")
          return Response.json({ error: "invalid_grant", error_description: "revoked" }, { status: 400 });
        return Response.json({ id_token: unsigned({ sub: "u1", exp: exp + 1 }), expires_in: 300 });
      }

      if (parsedUrl.pathname === "/revoke") {
        log.revoke.push(new URLSearchParams(await req.text()));
        return new Response(null, { status: 200 });
      }

      return new Response("nope", { status: 404 });
    },
  });
  stops.push(() => server.stop(true));
  return { base: `http://127.0.0.1:${server.port}`, log, stop: () => server.stop(true) };
}

function fakeHub(idpBase: string, roleScope?: string) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      Response.json({ issuer: `${idpBase}/o/cli/`, client_id: "cli", ...(roleScope ? { role_scope: roleScope } : {}) }),
  });
  stops.push(() => server.stop(true));
  return `http://127.0.0.1:${server.port}`;
}

const openViaFetch = async (url: string) => void (await fetch(url));
const base = (idp: ReturnType<typeof fakeIdp>, over: Partial<Parameters<typeof login>[0]> = {}) => ({
  hub: fakeHub(idp.base),
  noBrowser: false,
  open: openViaFetch,
  readLine: () => Promise.resolve(""),
  log: () => {},
  timeoutMs: 3000,
  ...over,
});

describe("login", () => {
  test("happy path saves tokens, endpoints and expiry", async () => {
    const idp = fakeIdp();
    const harness = base(idp);
    const credentials = await login(harness);
    expect(credentials).toMatchObject({
      hub: harness.hub,
      clientId: "cli",
      tokenEndpoint: `${idp.base}/token`,
      revocationEndpoint: `${idp.base}/revoke`,
      refreshToken: "R1",
    });
    expect(credentials.idToken.split(".")).toHaveLength(3);
    expect(credentials.expiresAt).toBeGreaterThan(Date.now() / 1000);
    const searchParams = idp.log.authorize[0];
    expect(searchParams.get("scope")).toBe("openid email profile offline_access");
    expect(searchParams.get("code_challenge_method")).toBe("S256");
    expect(searchParams.get("response_type")).toBe("code");
    expect(searchParams.get("client_id")).toBe("cli");
    expect(searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });

  test("sends no client_secret", async () => {
    const idp = fakeIdp();
    await login(base(idp));
    expect(idp.log.token[0].has("client_secret")).toBe(false);
    expect(idp.log.token[0].get("client_id")).toBe("cli");
  });

  test("a callback with the wrong state is ignored and the right one still completes", async () => {
    const idp = fakeIdp("wrong-state-first");
    const credentials = await login(base(idp));
    expect(credentials.refreshToken).toBe("R1");
    expect(idp.log.token).toHaveLength(1);
    expect(idp.log.token[0].get("code")).toBe("C1");
  });

  test("an error from the identity provider fails the login with its text and closes the listener", async () => {
    const idp = fakeIdp("denied");
    expect((await rejection(login(base(idp)))).message).toContain("user said no");
    const redirect = defined(idp.log.authorize[0].get("redirect_uri"));
    expect(await rejection(fetch(redirect))).toBeDefined();
  });

  test("a wrong nonce in the ID token fails the login", async () => {
    const idp = fakeIdp("wrong-nonce");
    expect((await rejection(login(base(idp)))).message).toContain("nonce");
  });

  test("--no-browser prints the URL and accepts a pasted redirect URL", async () => {
    const idp = fakeIdp();
    const printed: string[] = [];
    const credentials = await login(
      base(idp, {
        noBrowser: true,
        open: () => {
          return Promise.reject(new Error("must not open a browser"));
        },
        log: (line) => printed.push(line),
        readLine: async () => {
          const url = new URL(defined(printed.find((item) => item.startsWith("http"))));
          await fetch(url).catch(() => {}); // the browser visit: lets the fake provider record the PKCE challenge and nonce
          return `${url.searchParams.get("redirect_uri")}?code=C1&state=${url.searchParams.get("state")}`;
        },
      }),
    );
    expect(credentials.refreshToken).toBe("R1");
    expect(printed.some((item) => item.startsWith(`${idp.base}/authorize?`))).toBe(true);
  });

  test("browser mode always prints the URL, and a pasted redirect URL completes the login when the browser cannot reach the listener", async () => {
    const idp = fakeIdp();
    const printed: string[] = [];
    let opened = 0;
    const credentials = await login(
      base(idp, {
        open: () => Promise.resolve(void opened++), // like xdg-open over ssh: succeeds and shows nothing
        log: (line) => printed.push(line),
        readLine: async () => {
          const url = new URL(defined(printed.find((item) => item.startsWith("http"))));
          await fetch(url).catch(() => {}); // the user's browser visit
          // The browser ended on a connection error page for 127.0.0.1, and the user pastes the address bar.
          return `${url.searchParams.get("redirect_uri")}?code=C1&state=${url.searchParams.get("state")}`;
        },
      }),
    );
    expect(opened).toBe(1);
    expect(credentials.refreshToken).toBe("R1");
    expect(printed.join("\n")).toContain("paste");
  });

  test("a pasted line that is not the right URL is refused and the login keeps waiting for the browser", async () => {
    const idp = fakeIdp();
    const printed: string[] = [];
    const lines = ["not a url", "http://127.0.0.1:1/callback?code=evil&state=wrong"];
    const credentials = await login(
      base(idp, {
        log: (line) => printed.push(line),
        open: async (url) => void (await fetch(url)), // the browser does reach the listener
        readLine: () => Promise.resolve(lines.shift() ?? ""),
      }),
    );
    expect(credentials.refreshToken).toBe("R1");
    expect(idp.log.token).toHaveLength(1);
    expect(idp.log.token[0].get("code")).toBe("C1");
  });

  test("a hub URL or issuer that is plain http on a non-loopback host is refused before anything is sent", async () => {
    let calls = 0;
    const item = (() => Promise.resolve((calls++, Response.json({})))) as unknown as typeof fetch;
    const entry = {
      noBrowser: false,
      open: openViaFetch,
      readLine: () => Promise.resolve(""),
      log: () => {},
      timeoutMs: 200,
      fetch: item,
    };
    expect((await rejection(login({ ...entry, hub: "http://hub.example.com" }))).message).toContain("https");
    expect(calls).toBe(0);
    const value = ((url: string) =>
      Promise.resolve(
        String(url).endsWith("/cli/config")
          ? Response.json({ issuer: "http://idp.example.com/o/", client_id: "c" })
          : Response.json({}),
      )) as unknown as typeof fetch;
    expect((await rejection(login({ ...entry, hub: "https://hub.example.com", fetch: value }))).message).toContain(
      "https",
    );
  });

  test("a hub that answers /cli/config with a web page or a redirect gets an explanation", async () => {
    const item = {
      hub: "https://hub.example.com",
      noBrowser: false,
      open: openViaFetch,
      readLine: () => Promise.resolve(""),
      log: () => {},
      timeoutMs: 200,
    };
    const html = (() =>
      Promise.resolve(
        new Response("<!doctype html><title>login</title>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      )) as unknown as typeof fetch;
    const redirect = (() =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: "/auth/login" } }),
      )) as unknown as typeof fetch;

    for (const fetch of [html, redirect]) {
      const entry = await login({ ...item, fetch: fetch }).catch((error) => error);
      expect(entry).toBeInstanceOf(ExitError);
      expect(entry.message).toContain("[cli_auth");
      expect(entry.message).toContain("/cli/");
      expect(entry.message).not.toContain("JSON Parse");
    }
  });

  test("a login that nobody completes times out", async () => {
    const idp = fakeIdp();
    expect((await rejection(login(base(idp, { open: async () => {}, timeoutMs: 200 })))).message).toContain(
      "timed out",
    );
  });
});

const sample = (idp: ReturnType<typeof fakeIdp>, over: Partial<Credentials> = {}): Credentials => ({
  hub: "https://hub",
  issuer: `${idp.base}/o/cli/`,
  clientId: "cli",
  tokenEndpoint: `${idp.base}/token`,
  revocationEndpoint: `${idp.base}/revoke`,
  idToken: "old",
  refreshToken: "R1",
  expiresAt: 1,
  ...over,
});

describe("renew", () => {
  test("stores the new ID token and expiry and keeps the old refresh token when none is returned", async () => {
    const idp = fakeIdp();
    const credentials = await renew(sample(idp));
    expect(credentials.idToken).not.toBe("old");
    expect(credentials.refreshToken).toBe("R1");
    expect(credentials.expiresAt).toBeGreaterThan(Date.now() / 1000);
    expect(idp.log.token[0].get("grant_type")).toBe("refresh_token");
    expect(idp.log.token[0].has("client_secret")).toBe(false);
  });
  test("a rejected refresh token is ExitError code 2", async () => {
    const idp = fakeIdp();
    expect(await rejection(renew(sample(idp, { refreshToken: "bad" })))).toMatchObject({ name: "ExitError", code: 2 });
  });
  test("no refresh token is ExitError code 2", async () => {
    const idp = fakeIdp();
    expect(await rejection(renew(sample(idp, { refreshToken: undefined })))).toBeInstanceOf(ExitError);
  });
});

describe("logout", () => {
  test("revokes the refresh token", async () => {
    const idp = fakeIdp();
    await logout(sample(idp));
    expect(idp.log.revoke[0].get("token")).toBe("R1");
    expect(idp.log.revoke[0].get("client_id")).toBe("cli");
  });
  test("never throws when the identity provider is down", async () => {
    const idp = fakeIdp();
    const credentials = sample(idp);
    idp.stop();
    await logout(credentials);
  });
});

describe("role scope", () => {
  test("login asks for the role scope that the hub reports, and keeps the scope for a refresh", async () => {
    const idp = fakeIdp();
    const credentials = await login(base(idp, { hub: fakeHub(idp.base, "clauderc") }));
    expect(idp.log.authorize[0].get("scope")).toBe("openid email profile offline_access clauderc");
    expect(credentials.scope).toBe("openid email profile offline_access clauderc");
    await renew(credentials);
    expect(defined(idp.log.token.at(-1)).get("scope")).toBe("openid email profile offline_access clauderc");
  });
  test("with no role scope from the hub, the scope is the old one", async () => {
    const idp = fakeIdp();
    const credentials = await login(base(idp));
    expect(credentials.scope).toBe("openid email profile offline_access");
  });
  test("credentials saved before this change refresh with the old scope", async () => {
    const idp = fakeIdp();
    await renew({
      hub: "https://hub",
      issuer: `${idp.base}/o/cli/`,
      clientId: "cli",
      tokenEndpoint: `${idp.base}/token`,
      idToken: "old",
      refreshToken: "R1",
      expiresAt: 1,
    });
    expect(idp.log.token[0].get("scope")).toBe("openid email profile offline_access");
  });
  test("an odd role scope from the hub is ignored", async () => {
    const idp = fakeIdp();
    await login(base(idp, { hub: fakeHub(idp.base, "a b\nc") }));
    expect(idp.log.authorize[0].get("scope")).toBe("openid email profile offline_access");
  });
});

import { describe, expect, test } from "bun:test";
import { decodeProtectedHeader, exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { parseConfig, type ConfigIo } from "../src/config";
import { createTokenSource, type ClientCredsSettings } from "../src/clientcreds";

const TOKEN_URL = "https://auth.example.com/application/o/token/";

function fakeFetch(handler: (body: URLSearchParams, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; body: URLSearchParams; init: RequestInit }[] = [];
  const f = (async (url: any, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body ?? ""));
    calls.push({ url: String(url), body, init: init ?? {} });
    return handler(body, init ?? {});
  }) as typeof fetch;
  return { f, calls };
}
const tokenResponse = (token = "tok-1", expiresIn = 300) =>
  new Response(JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: expiresIn }), { status: 200, headers: { "content-type": "application/json" } });

const secretSettings = (over: Partial<Extract<ClientCredsSettings["clientAuth"], { method: "client_secret" }>> = {}, scope?: string): ClientCredsSettings => ({
  tokenUrl: TOKEN_URL,
  clientId: "hub",
  ...(scope ? { scope } : {}),
  clientAuth: { method: "client_secret", clientSecret: "s3cr3t-value", ...over },
});

describe("client_secret", () => {
  test("POSTs form-encoded client_credentials and returns access_token", async () => {
    const { f, calls } = fakeFetch(() => tokenResponse("abc"));
    const t = await createTokenSource(secretSettings({ username: "rc-hub", password: "pw" }, "rc-node"), { fetch: f })();
    expect(t).toBe("abc");
    const c = calls[0]!;
    expect(c.url).toBe(TOKEN_URL);
    expect(c.init.method).toBe("POST");
    expect(new Headers(c.init.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(c.body)).toEqual({
      grant_type: "client_credentials", client_id: "hub", client_secret: "s3cr3t-value", username: "rc-hub", password: "pw", scope: "rc-node",
    });
  });
  test("optional fields are omitted when unset", async () => {
    const { f, calls } = fakeFetch(() => tokenResponse());
    await createTokenSource(secretSettings(), { fetch: f })();
    expect([...calls[0]!.body.keys()].sort()).toEqual(["client_id", "client_secret", "grant_type"]);
  });
});

describe("caching", () => {
  test("cached until 30 s before expiry, then refetched", async () => {
    let now = 1_000_000;
    let n = 0;
    const { f, calls } = fakeFetch(() => tokenResponse(`t${++n}`, 300));
    const src = createTokenSource(secretSettings(), { fetch: f, now: () => now });
    expect(await src()).toBe("t1");
    now += 269_000;
    expect(await src()).toBe("t1");
    expect(calls.length).toBe(1);
    now += 2_000; // 271 s > 300 - 30
    expect(await src()).toBe("t2");
    expect(calls.length).toBe(2);
  });
  test("5 concurrent first calls produce one request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { f, calls } = fakeFetch(async () => {
      await gate;
      return tokenResponse("shared");
    });
    const src = createTokenSource(secretSettings(), { fetch: f });
    const all = Promise.all([src(), src(), src(), src(), src()]);
    release();
    expect(await all).toEqual(["shared", "shared", "shared", "shared", "shared"]);
    expect(calls.length).toBe(1);
  });
  test("failures reject, are not cached, and never leak the secret", async () => {
    const bodies = [
      () => new Response("secret s3cr3t-value in body", { status: 500 }),
      () => new Response("not json", { status: 200 }),
      () => new Response(JSON.stringify({ token_type: "Bearer" }), { status: 200 }),
    ];
    for (const mk of bodies) {
      let attempt = 0;
      const { f, calls } = fakeFetch(() => (attempt++ === 0 ? mk() : tokenResponse("recovered")));
      const src = createTokenSource(secretSettings(), { fetch: f });
      const err = (await src().catch((e) => e)) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(String(err.message)).not.toContain("s3cr3t-value");
      expect(await src()).toBe("recovered");
      expect(calls.length).toBe(2);
    }
  });
  test("an error message contains the HTTP status", async () => {
    const { f } = fakeFetch(() => new Response("{}", { status: 401 }));
    await expect(createTokenSource(secretSettings(), { fetch: f })()).rejects.toThrow(/401/);
  });
});

describe("private_key_jwt", () => {
  test("sends a verifiable client_assertion and no client_secret", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
    const pem = await exportPKCS8(privateKey);
    const { f, calls } = fakeFetch(() => tokenResponse("pk"));
    const mk = () => createTokenSource({ tokenUrl: TOKEN_URL, clientId: "hub", clientAuth: { method: "private_key_jwt", privateKeyPem: pem, keyId: "hub-1" } }, { fetch: f, now: () => Date.now() });
    await mk()();
    await mk()();
    const [a, b] = calls.map((c) => c.body);
    expect(a!.get("client_assertion_type")).toBe("urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    expect(a!.has("client_secret")).toBe(false);
    expect(a!.get("grant_type")).toBe("client_credentials");
    expect(a!.get("client_id")).toBe("hub");
    const jwt = a!.get("client_assertion")!;
    expect(decodeProtectedHeader(jwt).kid).toBe("hub-1");
    const { payload } = await jwtVerify(jwt, publicKey, { issuer: "hub", audience: TOKEN_URL });
    expect(payload.sub).toBe("hub");
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(60);
    expect(typeof payload.jti).toBe("string");
    const p2 = (await jwtVerify(b!.get("client_assertion")!, publicKey, { issuer: "hub", audience: TOKEN_URL })).payload;
    expect(p2.jti).not.toBe(payload.jti);
  });
  test("no kid header when keyId is unset", async () => {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const { f, calls } = fakeFetch(() => tokenResponse());
    await createTokenSource({ tokenUrl: TOKEN_URL, clientId: "hub", clientAuth: { method: "private_key_jwt", privateKeyPem: await exportPKCS8(privateKey) } }, { fetch: f })();
    expect(decodeProtectedHeader(calls[0]!.body.get("client_assertion")!).kid).toBeUndefined();
  });
});

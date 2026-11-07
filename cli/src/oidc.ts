import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ExitError, LOGIN_MESSAGE, type Credentials } from "./creds";

const SCOPE = "openid email profile offline_access";
const SUCCESS_PAGE = "<!doctype html><meta charset=utf-8><title>claude-rc</title><p>You are signed in. You can close this tab.</p>";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Tokens and codes travel on these URLs, so they must be https. Plain http is accepted only for the local machine. */
function requireSecure(what: string, url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ExitError(`${what} is not a valid URL: ${url}`, 1);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) throw new ExitError(`${what} must use https: ${url}`, 1);
}

const rand = () => randomBytes(32).toString("base64url");
const challengeOf = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function decodeClaims(jwt: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    throw new ExitError("the identity provider returned an ID token that cannot be read", 1);
  }
}

async function postForm(f: typeof fetch, url: string, form: Record<string, string>): Promise<{ ok: boolean; body: any }> {
  let res: Response;
  try {
    res = await f(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(form) });
  } catch (e) {
    throw new ExitError(`cannot reach the identity provider at ${url}: ${(e as Error).message}`, 1);
  }
  let body: any = {};
  try {
    body = await res.json();
  } catch {
    /* keep {} */
  }
  return { ok: res.ok, body };
}

/** Starts a one-shot listener on the loopback address. It answers only `GET /callback` with the right state. */
function listen(state: string) {
  let resolve!: (u: URL) => void;
  let reject!: (e: Error) => void;
  const result = new Promise<URL>((res, rej) => ((resolve = res), (reject = rej)));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname !== "/callback") return new Response("not found", { status: 404 });
      const given = u.searchParams.get("state");
      if (!given || !same(given, state)) return new Response("invalid state", { status: 400 });
      resolve(u);
      return new Response(SUCCESS_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  return { port: server.port!, result, fail: reject, close: () => server.stop() };
}

export async function login(o: {
  hub: string;
  noBrowser: boolean;
  open: (url: string) => Promise<void>;
  readLine: (prompt: string) => Promise<string>;
  log: (s: string) => void;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<Credentials> {
  const f = o.fetch ?? fetch;
  const hub = o.hub.replace(/\/+$/, "");
  requireSecure("the hub URL", hub);

  const NOT_ENABLED =
    `${hub}/cli/config did not return the CLI settings. Make sure that the hub runs a version with CLI support and that ` +
    `config.toml has a [cli_auth.oidc] table. If the hub is behind an authenticating proxy (proxy-jwt mode), ` +
    `the proxy must let paths that start with /cli/ through without its own login.`;
  let cfg: any;
  try {
    const r = await f(`${hub}/cli/config`, { redirect: "manual" });
    if (r.status >= 300 && r.status < 400) throw new ExitError(`${NOT_ENABLED} The hub answered with a redirect to ${r.headers.get("location") ?? "another page"}.`, 1);
    if (!r.ok) throw new ExitError(`${NOT_ENABLED} The hub answered HTTP ${r.status}.`, 1);
    try {
      cfg = await r.json();
    } catch {
      throw new ExitError(`${NOT_ENABLED} The hub answered with a web page, not JSON.`, 1);
    }
  } catch (e) {
    if (e instanceof ExitError) throw e;
    throw new ExitError(`cannot reach ${hub}: ${(e as Error).message}`, 1);
  }
  if (typeof cfg?.issuer !== "string" || typeof cfg?.client_id !== "string") throw new ExitError(`${hub}/cli/config returned an unexpected answer`, 1);

  requireSecure("the issuer", cfg.issuer);
  let disco: any;
  try {
    const r = await f(`${cfg.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    disco = await r.json();
  } catch (e) {
    throw new ExitError(`OIDC discovery failed for ${cfg.issuer}: ${(e as Error).message}`, 1);
  }
  if (typeof disco?.authorization_endpoint !== "string" || typeof disco?.token_endpoint !== "string") throw new ExitError("the OIDC discovery document has no authorization or token endpoint", 1);

  requireSecure("the authorization endpoint", disco.authorization_endpoint);
  requireSecure("the token endpoint", disco.token_endpoint);
  const state = rand();
  const nonce = rand();
  const verifier = rand();
  const listener = o.noBrowser ? undefined : listen(state);
  let port: number;
  if (listener) port = listener.port;
  else {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    port = probe.port!;
    probe.stop(true);
  }
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const auth = new URL(disco.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: cfg.client_id,
    redirect_uri: redirectUri,
    scope: SCOPE,
    state,
    nonce,
    code_challenge: challengeOf(verifier),
    code_challenge_method: "S256",
  })) auth.searchParams.set(k, v);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let callback: URL;
    if (listener) {
      timer = setTimeout(() => listener.fail(new ExitError("login timed out", 1)), o.timeoutMs ?? 300_000);
      try {
        await o.open(auth.href);
      } catch {
        o.log(`Open this URL in a browser to sign in:\n${auth.href}`);
      }
      o.log("Waiting for the browser sign-in...");
      callback = await listener.result;
    } else {
      o.log("Open this URL in a browser and sign in:");
      o.log(auth.href);
      const pasted = await Promise.race([
        o.readLine("Paste the URL that the browser ended up on: "),
        new Promise<string>((_, rej) => (timer = setTimeout(() => rej(new ExitError("login timed out", 1)), o.timeoutMs ?? 300_000))),
      ]);
      try {
        callback = new URL(pasted.trim());
      } catch {
        throw new ExitError("that is not a URL", 1);
      }
      const given = callback.searchParams.get("state");
      if (!given || !same(given, state)) throw new ExitError("the pasted URL has the wrong state", 1);
    }

    const err = callback.searchParams.get("error");
    if (err) throw new ExitError(`login failed: ${callback.searchParams.get("error_description") ?? err}`, 1);
    const code = callback.searchParams.get("code");
    if (!code) throw new ExitError("login failed: the identity provider sent no code", 1);

    const t = await postForm(f, disco.token_endpoint, { grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: cfg.client_id, code_verifier: verifier });
    if (!t.ok || typeof t.body?.id_token !== "string") throw new ExitError(`login failed: ${t.body?.error_description ?? t.body?.error ?? "no ID token"}`, 1);
    const claims = decodeClaims(t.body.id_token);
    if (typeof claims.nonce !== "string" || !same(claims.nonce, nonce)) throw new ExitError("login failed: the ID token has the wrong nonce", 1);

    return {
      hub,
      issuer: cfg.issuer,
      clientId: cfg.client_id,
      tokenEndpoint: disco.token_endpoint,
      ...(typeof disco.revocation_endpoint === "string" ? { revocationEndpoint: disco.revocation_endpoint } : {}),
      idToken: t.body.id_token,
      ...(typeof t.body.refresh_token === "string" ? { refreshToken: t.body.refresh_token } : {}),
      expiresAt: typeof claims.exp === "number" ? claims.exp : Math.floor(Date.now() / 1000) + Number(t.body.expires_in ?? 300),
    };
  } finally {
    clearTimeout(timer);
    listener?.close();
  }
}

/** Exchanges the refresh token for a new ID token. Code 2 means that the user must log in again. */
export async function renew(c: Credentials, f: typeof fetch = fetch): Promise<Credentials> {
  if (!c.refreshToken) throw new ExitError(LOGIN_MESSAGE, 2);
  const t = await postForm(f, c.tokenEndpoint, { grant_type: "refresh_token", refresh_token: c.refreshToken, client_id: c.clientId, scope: SCOPE });
  if (!t.ok || typeof t.body?.id_token !== "string") throw new ExitError(LOGIN_MESSAGE, 2);
  const claims = decodeClaims(t.body.id_token);
  return {
    ...c,
    idToken: t.body.id_token,
    refreshToken: typeof t.body.refresh_token === "string" ? t.body.refresh_token : c.refreshToken,
    expiresAt: typeof claims.exp === "number" ? claims.exp : Math.floor(Date.now() / 1000) + Number(t.body.expires_in ?? 300),
  };
}

/** Best effort: asks the identity provider to revoke the refresh token. Never throws. */
export async function logout(c: Credentials, f: typeof fetch = fetch): Promise<void> {
  if (!c.revocationEndpoint || !c.refreshToken) return;
  try {
    await postForm(f, c.revocationEndpoint, { token: c.refreshToken, token_type_hint: "refresh_token", client_id: c.clientId });
  } catch {
    /* best effort */
  }
}

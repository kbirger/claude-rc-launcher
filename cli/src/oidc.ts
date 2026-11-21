import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ExitError, LOGIN_MESSAGE } from "./creds";
import type { Credentials } from "./creds";
import { isObject, readJson } from "./json";

const SCOPE = "openid email profile offline_access";

/** The hub can name one more scope that carries the role claim. Only a plain token is used, so the value cannot add a scope or break the request. */
const roleScopeOf = (value: unknown): string | undefined =>
  typeof value === "string" && /^[\w.:-]{1,64}$/.test(value) ? value : undefined;
const SUCCESS_PAGE =
  "<!doctype html><meta charset=utf-8><title>claude-rc</title><p>You are signed in. You can close this tab.</p>";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Tokens and codes travel on these URLs, so they must be https. Plain http is accepted only for the local machine. */
function requireSecure(what: string, url: string): void {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(url);
  } catch {
    throw new ExitError(`${what} is not a valid URL: ${url}`, 1);
  }

  if (parsedUrl.protocol !== "https:" && !(parsedUrl.protocol === "http:" && LOOPBACK.has(parsedUrl.hostname)))
    throw new ExitError(`${what} must use https: ${url}`, 1);
}

const rand = () => randomBytes(32).toString("base64url");
const challengeOf = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
const same = (left: string, right: string) =>
  left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));

function decodeClaims(jwt: string): Record<string, unknown> {
  let claims: unknown;

  try {
    claims = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    throw new ExitError("the identity provider returned an ID token that cannot be read", 1);
  }

  if (!isObject(claims)) throw new ExitError("the identity provider returned an ID token that cannot be read", 1);

  return claims;
}

async function postForm(
  fetchImpl: typeof fetch,
  url: string,
  form: Record<string, string>,
): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  let res: Response;

  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form),
    });
  } catch (error) {
    throw new ExitError(`cannot reach the identity provider at ${url}: ${(error as Error).message}`, 1);
  }

  let body: Record<string, unknown> = {};

  try {
    const parsed = await readJson(res);
    if (isObject(parsed)) body = parsed;
  } catch {
    /* keep {} */
  }

  return { ok: res.ok, body };
}

/** The reason that the identity provider gave for a failed token request. */
function describeError(body: Record<string, unknown>): string {
  const reason = body.error_description ?? body.error;
  return typeof reason === "string" ? reason : "no ID token";
}

/** When the ID token expires: the exp claim, or else the lifetime that the token answer names, or else five minutes from now. */
function expiryOf(claims: Record<string, unknown>, body: Record<string, unknown>): number {
  if (typeof claims.exp === "number") return claims.exp;
  const lifetime =
    typeof body.expires_in === "number" || typeof body.expires_in === "string" ? Number(body.expires_in) : 300;
  return Math.floor(Date.now() / 1000) + lifetime;
}

/** Starts a one-shot listener on the loopback address. It answers only `GET /callback` with the right state. */
function listen(state: string) {
  let resolve!: (url: URL) => void;
  let reject!: (error: Error) => void;
  const result = new Promise<URL>((res, rej) => ((resolve = res), (reject = rej)));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const parsedUrl = new URL(req.url);
      if (parsedUrl.pathname !== "/callback") return new Response("not found", { status: 404 });
      const given = parsedUrl.searchParams.get("state");
      if (!given || !same(given, state)) return new Response("invalid state", { status: 400 });
      resolve(parsedUrl);
      return new Response(SUCCESS_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  const { port } = server;
  if (port === undefined) throw new Error("the login listener did not get a port");

  return { port, result, fail: reject, close: () => server.stop() };
}

export async function login(options: {
  hub: string;
  noBrowser: boolean;
  open: (url: string) => Promise<void>;
  readLine: (prompt: string, signal?: AbortSignal) => Promise<string>;
  log: (line: string) => void;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<Credentials> {
  const fetchImpl = options.fetch ?? fetch;
  const hub = options.hub.replace(/\/+$/, "");
  requireSecure("the hub URL", hub);

  const NOT_ENABLED =
    `${hub}/cli/config did not return the CLI settings. Make sure that the hub runs a version with CLI support and that ` +
    `config.toml has a [cli_auth.oidc] table. If the hub is behind an authenticating proxy (proxy-jwt mode), ` +
    `the proxy must let paths that start with /cli/ through without its own login.`;
  let cfg: Record<string, unknown> = {};

  try {
    const response = await fetchImpl(`${hub}/cli/config`, { redirect: "manual" });
    if (response.status >= 300 && response.status < 400)
      throw new ExitError(
        `${NOT_ENABLED} The hub answered with a redirect to ${response.headers.get("location") ?? "another page"}.`,
        1,
      );
    if (!response.ok) throw new ExitError(`${NOT_ENABLED} The hub answered HTTP ${response.status}.`, 1);

    try {
      const parsed = await readJson(response);
      if (isObject(parsed)) cfg = parsed;
    } catch {
      throw new ExitError(`${NOT_ENABLED} The hub answered with a web page, not JSON.`, 1);
    }
  } catch (error) {
    if (error instanceof ExitError) throw error;
    throw new ExitError(`cannot reach ${hub}: ${(error as Error).message}`, 1);
  }

  const { issuer, client_id: clientId } = cfg;
  if (typeof issuer !== "string" || typeof clientId !== "string")
    throw new ExitError(`${hub}/cli/config returned an unexpected answer`, 1);

  requireSecure("the issuer", issuer);
  let disco: Record<string, unknown> = {};

  try {
    const response = await fetchImpl(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = await readJson(response);
    if (isObject(parsed)) disco = parsed;
  } catch (error) {
    throw new ExitError(`OIDC discovery failed for ${issuer}: ${(error as Error).message}`, 1);
  }

  const { authorization_endpoint: authorizationEndpoint, token_endpoint: tokenEndpoint } = disco;
  if (typeof authorizationEndpoint !== "string" || typeof tokenEndpoint !== "string")
    throw new ExitError("the OIDC discovery document has no authorization or token endpoint", 1);

  requireSecure("the authorization endpoint", authorizationEndpoint);
  requireSecure("the token endpoint", tokenEndpoint);
  const roleScope = roleScopeOf(cfg.role_scope);
  const scope = roleScope ? `${SCOPE} ${roleScope}` : SCOPE;
  const state = rand();
  const nonce = rand();
  const verifier = rand();
  // The listener is always started: when the browser runs on this machine it catches the redirect. When it does not
  // (for example over ssh), the user pastes the URL that the browser ended up on.
  const listener = listen(state);
  const redirectUri = `http://127.0.0.1:${listener.port}/callback`;
  const auth = new URL(authorizationEndpoint);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    nonce,
    code_challenge: challengeOf(verifier),
    code_challenge_method: "S256",
  }))
    auth.searchParams.set(key, value);

  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    options.log("Open this URL in a browser and sign in:");
    options.log(auth.href);
    options.log(
      "If the browser runs on another machine, it will end on an error page for 127.0.0.1 after you sign in. " +
        "Copy the URL from its address bar and paste it here.",
    );

    if (!options.noBrowser) {
      try {
        await options.open(auth.href);
      } catch {
        /* the URL is printed above */
      }
    }

    const timeout = new Promise<never>(
      (_unused, rej) =>
        (timer = setTimeout(() => {
          rej(new ExitError("login timed out", 1));
        }, options.timeoutMs ?? 300_000)),
    );
    const pasted = (async (): Promise<URL> => {
      for (;;) {
        let line = "";

        try {
          line = (await options.readLine("Paste the URL here (or wait for the browser): ", stop.signal)).trim();
        } catch {
          /* input closed or aborted: treated as nothing typed */
        }

        if (!line) return new Promise<never>(() => {}); // nothing typed or stdin closed: wait for the browser
        let parsedUrl: URL;

        try {
          parsedUrl = new URL(line);
        } catch {
          options.log("That is not a URL.");
          continue;
        }

        const given = parsedUrl.searchParams.get("state");
        if (given && same(given, state)) return parsedUrl;
        options.log("That URL is not from this login. Paste the URL from the browser that just signed in.");
      }
    })();
    pasted.catch(() => {}); // an aborted read after the login finished
    const callback = await Promise.race([listener.result, pasted, timeout]);

    const err = callback.searchParams.get("error");
    if (err) throw new ExitError(`login failed: ${callback.searchParams.get("error_description") ?? err}`, 1);
    const code = callback.searchParams.get("code");
    if (!code) throw new ExitError("login failed: the identity provider sent no code", 1);

    const form = await postForm(fetchImpl, tokenEndpoint, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    });
    const { id_token: idToken } = form.body;
    if (!form.ok || typeof idToken !== "string") throw new ExitError(`login failed: ${describeError(form.body)}`, 1);
    const claims = decodeClaims(idToken);
    if (typeof claims.nonce !== "string" || !same(claims.nonce, nonce))
      throw new ExitError("login failed: the ID token has the wrong nonce", 1);

    return {
      hub,
      issuer,
      clientId,
      tokenEndpoint,
      ...(typeof disco.revocation_endpoint === "string" ? { revocationEndpoint: disco.revocation_endpoint } : {}),
      idToken,
      scope,
      ...(typeof form.body.refresh_token === "string" ? { refreshToken: form.body.refresh_token } : {}),
      expiresAt: expiryOf(claims, form.body),
    };
  } finally {
    clearTimeout(timer);
    stop.abort();
    void listener.close();
  }
}

/** Exchanges the refresh token for a new ID token. Code 2 means that the user must log in again. */
export async function renew(credentials: Credentials, fetchImpl: typeof fetch = fetch): Promise<Credentials> {
  if (!credentials.refreshToken) throw new ExitError(LOGIN_MESSAGE, 2);
  const form = await postForm(fetchImpl, credentials.tokenEndpoint, {
    grant_type: "refresh_token",
    refresh_token: credentials.refreshToken,
    client_id: credentials.clientId,
    scope: credentials.scope ?? SCOPE,
  });
  const { id_token: idToken } = form.body;
  if (!form.ok || typeof idToken !== "string") throw new ExitError(LOGIN_MESSAGE, 2);
  const claims = decodeClaims(idToken);
  return {
    ...credentials,
    idToken,
    refreshToken: typeof form.body.refresh_token === "string" ? form.body.refresh_token : credentials.refreshToken,
    expiresAt: expiryOf(claims, form.body),
  };
}

/** Best effort: asks the identity provider to revoke the refresh token. Never throws. */
export async function logout(credentials: Credentials, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!credentials.revocationEndpoint || !credentials.refreshToken) return;

  try {
    await postForm(fetchImpl, credentials.revocationEndpoint, {
      token: credentials.refreshToken,
      token_type_hint: "refresh_token",
      client_id: credentials.clientId,
    });
  } catch {
    /* best effort */
  }
}

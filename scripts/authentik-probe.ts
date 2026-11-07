#!/usr/bin/env bun
/**
 * Probes a real Authentik to answer the open questions in docs/superpowers/specs/2026-11-06-multi-host-design.md.
 * Prints decoded header and claims only: never secrets, never a full token.
 *
 *   bun scripts/authentik-probe.ts client-credentials   # AK_TOKEN_URL AK_CLIENT_ID AK_CLIENT_SECRET_FILE [AK_USERNAME AK_PASSWORD_FILE] [AK_SCOPE]
 *   bun scripts/authentik-probe.ts private-key-jwt      # AK_TOKEN_URL AK_CLIENT_ID AK_PRIVATE_KEY_FILE [AK_KEY_ID] [AK_SCOPE]
 *   bun scripts/authentik-probe.ts proxy-jwt            # JWT on stdin (copy the X-authentik-jwt header value)
 *   bun scripts/authentik-probe.ts forged <hub-url>     # sends forged identities to a hub; expects 401 [AK_JWT_HEADER]
 */
import { readFileSync } from "node:fs";
import { createTokenSource, type ClientCredsSettings } from "../server/src/clientcreds";

export type TokenDescription = { header: Record<string, unknown>; claims: Record<string, unknown>; lifetimeS: number | null };

function decodePart(part: string | undefined): Record<string, unknown> {
  if (!part) throw new Error("not a JWT: expected three dot-separated parts");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    throw new Error("not a JWT: a part is not base64url-encoded JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not a JWT: a part is not a JSON object");
  return parsed as Record<string, unknown>;
}

/** Decodes (without verifying) a JWT. Throws "not a JWT: ..." on anything else. */
export function describeToken(jwt: string): TokenDescription {
  const parts = jwt.trim().split(".");
  if (parts.length !== 3) throw new Error("not a JWT: expected three dot-separated parts");
  const header = decodePart(parts[0]);
  const claims = decodePart(parts[1]);
  const exp = claims.exp;
  const iat = claims.iat;
  const lifetimeS = typeof exp === "number" && typeof iat === "number" ? exp - iat : null;
  return { header, claims, lifetimeS };
}

/** A ready-to-paste `[node_auth.oidc]` snippet. Contains claims only, never the token. */
export function nodeSnippet(claims: Record<string, unknown>): string {
  const iss = typeof claims.iss === "string" ? claims.iss : "<iss>";
  const aud = Array.isArray(claims.aud) ? claims.aud[0] : claims.aud;
  const sub = typeof claims.sub === "string" ? claims.sub : "<sub>";
  const jwks = `${iss.replace(/\/?$/, "/")}jwks/`;
  return [
    "[node_auth.oidc]",
    `jwks_url = "${jwks}"   # verify this URL in Authentik (provider -> JWKS)`,
    `issuer = "${iss}"`,
    `audience = "${typeof aud === "string" ? aud : "<aud>"}"`,
    'caller_claim = "sub"',
    `caller_value = "${sub}"`,
  ].join("\n");
}

function show(label: string, d: TokenDescription) {
  console.log(`${label} header: ${JSON.stringify(d.header)}`);
  console.log(`${label} claims: ${JSON.stringify(d.claims, null, 2)}`);
  console.log(`lifetime: ${d.lifetimeS === null ? "unknown (no exp/iat)" : `${d.lifetimeS}s`}`);
}

const env = (k: string, required = true): string | undefined => {
  const v = process.env[k];
  if (!v && required) {
    console.error(`missing environment variable ${k}`);
    process.exit(2);
  }
  return v || undefined;
};
const readFile = (k: string) => readFileSync(env(k)!, "utf8").replace(/\r?\n$/, "");

async function clientCreds(method: "client_secret" | "private_key_jwt") {
  const scope = env("AK_SCOPE", false);
  const common = { tokenUrl: env("AK_TOKEN_URL")!, clientId: env("AK_CLIENT_ID")!, ...(scope ? { scope } : {}) };
  let settings: ClientCredsSettings;
  if (method === "client_secret") {
    const username = env("AK_USERNAME", false);
    settings = {
      ...common,
      clientAuth: {
        method,
        clientSecret: readFile("AK_CLIENT_SECRET_FILE"),
        ...(username ? { username, password: readFile("AK_PASSWORD_FILE") } : {}),
      },
    };
  } else {
    const keyId = env("AK_KEY_ID", false);
    settings = { ...common, clientAuth: { method, privateKeyPem: readFile("AK_PRIVATE_KEY_FILE"), ...(keyId ? { keyId } : {}) } };
  }
  let token: string;
  try {
    token = await createTokenSource(settings)();
  } catch (e) {
    console.error(`token request failed (${method}): ${(e as Error).message}`);
    process.exit(1);
  }
  const d = describeToken(token); // throws for an opaque (non-JWT) access token
  show("access token", d);
  console.log(`\n# paste into the node's config.toml, then set hub_auth.oidc accordingly:\n${nodeSnippet(d.claims)}`);
}

async function proxyJwt() {
  const jwt = (await Bun.stdin.text()).trim();
  const d = describeToken(jwt);
  show("proxy token", d);
  const iss = typeof d.claims.iss === "string" ? d.claims.iss : "<iss>";
  console.log(`\niss: ${iss}\naud: ${JSON.stringify(d.claims.aud)}`);
  console.log(`\n# paste into the hub's config.toml:\n[user_auth.proxy_jwt]\nheader = "${env("AK_JWT_HEADER", false) ?? "X-authentik-jwt"}"\njwks_url = "${iss.replace(/\/?$/, "/")}jwks/"   # verify in Authentik\nissuer = "${iss}"\naudience = "${Array.isArray(d.claims.aud) ? d.claims.aud[0] : d.claims.aud}"`);
}

async function forged(hubUrl: string | undefined) {
  if (!hubUrl) {
    console.error("usage: forged <hub-url>");
    process.exit(2);
  }
  const header = env("AK_JWT_HEADER", false) ?? "X-authentik-jwt";
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "attacker", preferred_username: "admin", exp: Math.floor(Date.now() / 1000) + 300 })}.`;
  const attempts: [string, Record<string, string>][] = [
    ["plain X-authentik-username", { "X-authentik-username": "admin" }],
    [`unsigned (alg none) ${header}`, { [header]: unsigned }],
    ["both", { "X-authentik-username": "admin", [header]: unsigned }],
  ];
  let bad = 0;
  for (const [label, headers] of attempts) {
    const res = await fetch(new URL("/api/me", hubUrl), { headers, redirect: "manual" });
    const ok = res.status === 401;
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "FAIL"} ${label}: HTTP ${res.status}${ok ? "" : " (expected 401)"}`);
  }
  process.exit(bad ? 1 : 0);
}

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === "client-credentials") await clientCreds("client_secret");
    else if (cmd === "private-key-jwt") await clientCreds("private_key_jwt");
    else if (cmd === "proxy-jwt") await proxyJwt();
    else if (cmd === "forged") await forged(arg);
    else {
      console.error("usage: authentik-probe.ts client-credentials | private-key-jwt | proxy-jwt | forged <hub-url>");
      process.exit(2);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

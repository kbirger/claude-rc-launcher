# Authentik findings (multi-host)

Template for the results of `scripts/authentik-probe.ts` against the real Authentik instance. The three open
questions are from `2026-11-06-multi-host-design.md`. Nothing here is verified yet: fill the blanks in, then
adjust `README.md` and `deploy/*.example.toml` if the claims differ from the assumptions listed.

Run date: ____  Authentik version: ____

## 1. Client-credentials token (hub -> node)

Command: `bun scripts/authentik-probe.ts client-credentials` (and `private-key-jwt`)

| Item | Assumption | Observed |
|---|---|---|
| Access token is a JWT (not opaque) | yes | ____ |
| `iss` | `https://<authentik>/application/o/<slug>/` | ____ |
| `aud` → `audience` | the client id | ____ |
| `sub` → `caller_value` | the service account identity | ____ |
| Signing alg (RS256/ES256/EdDSA only) | RS256 | ____ |
| Token lifetime | minutes | ____ s |
| `jwks_url` | `<iss>jwks/` | ____ |
| `client_secret` (+ service-account `username`/`password`) works | yes | ____ |
| `private_key_jwt` can be registered for a hub-held key | unknown | ____ |

Decision if `private_key_jwt` is not available: use `client_secret`, or shared secrets.

## 2. Proxy outpost JWT (`X-authentik-jwt`)

Command: `bun scripts/authentik-probe.ts proxy-jwt < token.txt`

| Item | Assumption | Observed |
|---|---|---|
| `iss` | provider issuer URL | ____ |
| `aud` → `audience` | the provider's client id | ____ |
| `jwks_url` that verifies it | `<iss>jwks/` | ____ |
| Lifetime | ____ | ____ s |
| `preferred_username`, `email`, `name`, `sub` present | yes | ____ |
| `groups` content | list of group names | ____ |

## 3. Traefik and client-supplied headers

Does Traefik strip client-supplied copies of `authResponseHeaders` (`X-authentik-*`)? ____

Irrelevant to safety, the JWT is verified and plain headers are ignored, but worth documenting.
`bun scripts/authentik-probe.ts forged https://rc.example.com` must report `ok` for all three attempts.

## Resulting config values

```toml
# caller_value = "____"
# audience     = "____"
# jwks_url     = "____"
```

## 4. Command-line client (public client)

Checked on 2026-11-07 against Authentik 2026.8.4 (provider created through the API).

| Item | Assumption | Observed |
|---|---|---|
| A public client (no secret) can be created, with a regular expression redirect `^http://127\.0\.0\.1:\d+/callback$` | yes | Yes. A loopback request with a random port is accepted and sent to the login flow. |
| The `offline_access` scope returns a refresh token | yes | Not tested yet (needs a real browser login). |
| The ID token holds `sub`, `preferred_username`, `email` | yes | Not tested yet (needs a real browser login). |
| The ID token `aud` equals the client id and `iss` equals the provider issuer | yes | Not tested yet. The discovery document shows `issuer` = `https://auth.undisclosed.work/application/o/claude-rc-cli/`. |
| The `jwks_url` of the provider verifies the ID token | `<issuer>jwks/` | The JWKS exists and holds one RS256 signing key. Requires a signing key on the provider. |
| The ID token lifetime | minutes | Set to 5 minutes (`access_token_validity`). |
| The proxy provider lets `^/cli/` through without its login (proxy-jwt mode) | yes | Not applicable on this deployment (oidc mode). |
| The provider supports token revocation (`logout` is best effort) | unknown | Yes. The discovery document lists `revocation_endpoint`. |

Gotchas:

- A provider created through the API in 2026.8 has **no allowed grant types** unless you set them. The authorize
  endpoint then answers every request with `invalid_request: The request is otherwise malformed`, even with a
  valid client id and redirect. Set `grant_types` to `["authorization_code", "refresh_token"]` (in the UI, select
  the "Authorization Code" and "Refresh Token" grants).
- The provider needs a **signing key** (a certificate). Without one Authentik signs ID tokens with HS256 and the
  hub rejects them, because it accepts only RS256, ES256 and EdDSA.

Already verified by the tests of this repository: `node:tls` with certificate validation off reads the peer
certificate inside a `bun build --compile` binary on Linux (used only by `host add` to show the fingerprint).

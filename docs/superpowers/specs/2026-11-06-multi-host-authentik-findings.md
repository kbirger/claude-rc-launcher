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

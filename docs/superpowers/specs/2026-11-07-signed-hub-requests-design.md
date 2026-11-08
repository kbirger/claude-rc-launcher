# Hub-signed node requests: design

Status: approved by the user. Date: 2026-11-07.
Origin: code review of `feat/multi-host`, finding 1 (see the project memory `code-review-feat-multi-host`).

## Intent

Today the hub sends one OIDC service-account token to every node as a bearer token. Every node accepts it. Suppose the hub sends that token to a server that is not a real node. The owner of that server can then replay it against every real node.

This can happen through `POST /cli/api/hosts` (`host add`). A signed-in CLI user supplies a URL and a fingerprint. The hub pins the certificate that the server presents, then calls `GET /api/node` with the token. The user can supply the fingerprint of an attacker's server, so the pin proves nothing.

The fix: the hub stops sending a reusable credential. For each request it sends a short-lived signed proof that names the one node it is for. A server that receives the proof cannot use it anywhere else.

## Goals

1. A proof that the hub sends to server X is useless at any server other than X.
2. Adding a node needs no new manual step beyond today's (`node setup`, or `host add` with a fingerprint).
3. The node does not need a secret, an IdP account or a connection to the IdP.
4. A proof that expires, or that has a different method, path or body than the request, is rejected.

## Non-goals

- The other parts of finding 1. These are separate changes. This design removes the credential theft only.
  - The probe can make the hub open connections to any host and port (SSRF).
  - `/probe` has no audit.
  - `host add` has no admin gate.
- Rotating the hub key without a short outage. See "Rotation".
- Changing how users log in to the hub or the CLI.
- Hosts that use `auth.type = "secret"`. They come from the config file that an admin writes, not from the API, and they stay as they are.

## Anti-goals

- No fallback to the old bearer token. There is no migration period (the user decided this). A node that does not know the hub key rejects the hub.
- No option to switch the check off.

## Design

### Hub key

- The hub makes an Ed25519 key pair on first start. It writes the private key to `<state_dir>/hub-key.pem` (mode 0600) and reuses it afterward. Ed25519 is already in `DEFAULT_ALGS` in `jwt.ts`, and `jose` signs it.
- The public key is 32 raw bytes, written as base64url text. The key ID (`kid`) is the first 16 characters of the sha256 of those bytes, in hex.

### Proof

The hub sends `Authorization: Hub-Proof <jwt>` on every call to a managed node. The JWT is signed with `EdDSA`, with `kid` in the header. Claims:

| Claim | Value |
|---|---|
| `iss` | `claude-rc-hub` |
| `aud` | `sha256:<hex>` of the node certificate, computed from `host.ca` (the same value that `nodesetup.ts` prints as the fingerprint) |
| `iat`, `exp` | now, and now + 30 seconds |
| `jti` | random UUID |
| `htm` | HTTP method |
| `htu` | request path plus query string, as sent |
| `bh` | sha256 hex of the exact request body bytes. With no body, the hash of the empty string |

### Node check

All of these checks must pass, or the node rejects the request:

1. The scheme is `Hub-Proof`, the algorithm is `EdDSA`, and the signature verifies with one of the trusted hub keys (chosen by `kid`).
2. `aud` equals the node's own certificate fingerprint. The node already knows it: `ensureNodeCert` returns `fingerprintSha256`.
3. `exp` is present. The value `exp - iat` is at most 60 seconds. The current time is inside the window, with a 5-second clock tolerance (the value `jwt.ts` already uses).
4. `htm`, `htu` and `bh` match the request that arrived. The node hashes the raw body before it parses it.
5. `jti` has not been seen before. The node keeps seen values in memory until `exp`. After a restart the cache is empty, but the 30-second lifetime and the `aud` binding limit the risk. This check is defense in depth.

A request with `Authorization: Bearer <secret>` still goes through the existing shared-secret path. The old rule that picks the verifier by counting dots is removed. The scheme name picks it.

### Where the node gets the key

- Node config: `[[node_auth.hub_key]]` with `public_key = "<base64url>"`. One or more rows. `[node_auth.oidc]` is removed, and the config loader rejects it with a message that names the replacement.
- `GET /cli/api/node-enrollment` returns `{ "hub_keys": [{ "public_key": "..." }] }` instead of the OIDC claims. `renderNodeConfig` in `cli/src/nodecmd.ts` writes the rows. `claude-rc node setup` and `node install` need no new flag or prompt.
- A node must have at least one `hub_key` row or at least one `node_auth.secret` row.

### Hub changes

- `createHostClient` (`hostclient.ts`) changes from `token: () => Promise<string>` to a function that builds the authorization header for one request: `(req: { method, pathAndQuery, body }) => Promise<string>`. The secret type returns `Bearer <secret>`. The managed type returns `Hub-Proof <jwt>` signed for `host.ca`'s fingerprint.
- `auth.type = "oidc"` in `[[hosts]]` becomes `auth.type = "hub_key"`. The old value is rejected with a message that names the new one. Managed hosts always use `hub_key`.
- `[hub_auth.oidc]` is no longer used for nodes. The `hasHubAuth` precondition in `hostadmin.ts:88` goes away, and so does the "Add [hub_auth.oidc] first" error.
- `enrollment.ts` drops the token-claims code. It returns the hub public keys.

### Effect on finding 1 and finding 6

- A fake server that gets a proof cannot replay it at a real node: the `aud` is the fake server's fingerprint, not the real node's.
- Finding 6 (a node accepts a JWT with no `exp`) is gone for the OIDC path, because that path no longer exists. The new check requires `exp`.

### Rotation

The hub has one active key. To rotate: delete `hub-key.pem`, restart the hub, then run `claude-rc node setup` again on every node. Nodes are unreachable between the hub restart and each node update. This is a documented procedure, not a tool. A node can hold several `hub_key` rows, so a later change can add a two-step rotation without a config format change.

## Constraints

- Bun and TypeScript, `jose` for JWT work. Match the existing style: small modules, errors as `HttpError` / `HostError`, no secrets in messages.
- The proof code is plain functions that take a clock and a random source, so tests need no sleeping.

## Tests the builder must add

- Proof signing and verification round trip.
- Each of these must be rejected:
  - a wrong `aud`
  - an expired proof
  - a missing `exp`
  - a lifetime over 60 seconds
  - a wrong `htm`, `htu` or `bh`
  - a repeated `jti`
  - a wrong algorithm (including `none` and `HS256`)
  - an unknown `kid`
- A fake HTTPS server that records the `Authorization` header from `host add`. A real node (in the same test) rejects that header. This is the regression test for finding 1.
- `nodeauth.test.ts`, `hostclient.test.ts`, `enrollment.test.ts`, `config.test.ts`, `hostadmin.test.ts` and `nodesetup` tests update for the new shapes.
- The end-to-end test (`e2e.test.ts`) runs a hub and a node with the new setup.

## Docs

Update these README parts:
- the multiple hosts section
- the `[node_auth]` and `[hub_auth]` tables
- the threat notes (lines 29 to 37)
- the manual `host add` steps

A hand-made node needs the hub's public key. Say where the admin reads it.

## Left to the builder

The builder chooses the file layout, the module names, and how the seen-`jti` cache expires. The builder also writes the exact error text, in the existing style.

## Decisions

The user approved this draft on 2026-11-07 with these choices:

1. The OIDC token is replaced. The hub sends only the proof. An admin loses the IdP kill switch for the hub. To cut the hub off, remove its key from the nodes.
2. The `[hub_auth.oidc]` section and its code are deleted. The config loader rejects the section with a message that names the replacement.

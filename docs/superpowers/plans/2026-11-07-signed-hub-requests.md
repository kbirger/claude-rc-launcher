# Hub-signed node requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The hub proves itself to each node with a short-lived signed proof that is valid for that one node only. The hub no longer sends a reusable OIDC token.

**Architecture:** A new module `hubproof.ts` signs and verifies the proofs. `nodeauth.ts` verifies them on the node. `hostclient.ts` signs one proof per request. The hub public key reaches nodes through the existing enrollment step of `node setup`. The OIDC client-credentials code is deleted.

**Tech Stack:** Bun, TypeScript, Hono, `jose` (EdDSA JWTs), `bun:test`.

**Spec:** `docs/superpowers/specs/2026-11-07-signed-hub-requests-design.md`

## Global Constraints

- Algorithm: `EdDSA` with Ed25519 only. Header `Authorization: Hub-Proof <jwt>`. A secret host still uses `Authorization: Bearer <secret>`.
- Claims: `iss` = `claude-rc-hub`. `aud` = `sha256:<hex>` of the node certificate. Also `iat`, `exp` (iat + 30 s), `jti` (random UUID), `htm`, `htu` (path plus query), `bh` (sha256 hex of the exact body bytes).
- Node limits: `exp` required. `exp - iat` at most 60 s. Clock tolerance 5 s. A `jti` is accepted once.
- Hub key file: `<state_dir>/hub-key.pem`, mode 0600. `kid` = first 16 hex characters of sha256 of the 32 raw public key bytes.
- Node configuration: one or more `[[node_auth.hub_key]]` rows with `public_key` (base64url, 32 raw bytes). A node needs at least one `hub_key` row or one `node_auth.secret` row.
- Host `auth.type = "oidc"` becomes `"hub_key"`. `[node_auth.oidc]` and `[hub_auth]` are rejected with a message that names the replacement.
- No fallback to the old bearer token. No migration period.
- Run tests with `export PATH="$HOME/.bun/bin:$PATH"; bun test <path>`. Run `bun run typecheck` at the end of every task.
- Commit steps run only after the user allows commits. Work on branch `feat/multi-host`.

## Review Focus

1. A POST with a JSON body still reaches the route handler after `nodeAuth` read the body to hash it. Expected: 200 and the parsed body.
2. A path with a query that needs encoding (`?path=/a b&x=1`) gives the same `htu` on the hub and on the node. Expected: accepted.
3. A node whose clock is 10 s off rejects the proof. Expected: the hub reports `rejected our credentials`. The README names clock skew as a cause.
4. A hub with an unreadable or corrupt `hub-key.pem` refuses to start. It must not make a new key, because a new key locks out every node.
5. A request body over 1 MiB is rejected with 413 before it is hashed.

---

## File Structure

- Create `server/src/hubproof.ts`: hub key, proof signing, proof verification, fingerprint helper.
- Modify `server/src/nodeauth.ts`: accept `Hub-Proof`, keep the secret path.
- Modify `server/src/config.ts`: node `hubKeys`, host `hub_key` type, remove `hubAuth`.
- Modify `server/src/nodemain.ts`: build `nodeAuth` from the new configuration.
- Modify `server/src/hostclient.ts`, `hubmain.ts`, `hostregistry.ts`, `hostadmin.ts`, `enrollment.ts`, `app.ts`.
- Modify `cli/src/nodecmd.ts` and its callers in `cli/src/nodesetup.ts`.
- Delete `server/src/clientcreds.ts`, `server/test/clientcreds.test.ts`, `scripts/authentik-probe.ts` and its test `server/test/probe.test.ts`.
- Modify `README.md`, `deploy/node.config.example.toml`, `deploy/install-binary.sh`.

### Task 1: Hub key and proof module

**Files:**
- Create: `server/src/hubproof.ts`
- Test: `server/test/hubproof.test.ts`

**Interfaces:**
- Produces:
  - `type HubKey = { privateKey: CryptoKey; publicKey: string; kid: string }`
  - `type ProofRequest = { method: string; pathAndQuery: string; body: string }`
  - `class ProofError extends Error`
  - `loadOrCreateHubKey(dir: string): Promise<HubKey>`
  - `certFingerprint(pem: string): string` returns `sha256:<hex>`.
  - `signProof(key: HubKey, req: ProofRequest, aud: string, o?: { now?: () => number; jti?: () => string }): Promise<string>`
  - `createProofVerifier(o: { keys: string[]; selfFingerprint: string; now?: () => number }): (jwt: string, req: ProofRequest) => Promise<void>`

- [ ] **Step 1: Write the failing tests** in `server/test/hubproof.test.ts`. Use a fixed `now` and a counter for `jti`. Tests:
  - `round trip: a signed proof verifies`.
  - Each of these rejects with `ProofError`:
    - a wrong `aud`
    - an expired proof (`now` + 40 s)
    - a missing `exp`
    - `exp - iat` = 61 s
    - a changed method, `pathAndQuery` or body
    - the same `jti` twice
    - an `HS256` token signed with the public key bytes
    - an `alg: none` token
    - an unknown `kid`
  - `accepts clock skew of 4 s and rejects 6 s`.
  - `loadOrCreateHubKey creates the file with mode 0600 and returns the same kid on the second call`.
  - `loadOrCreateHubKey throws and does not overwrite when the file is corrupt`.
  - `kid is 16 hex characters`.
- [ ] **Step 2: Run** `bun test server/test/hubproof.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** the interfaces above in `server/src/hubproof.ts`. Approach: `generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true })`. Store with `exportPKCS8`. Read with `importPKCS8`. Take `x` from `exportJWK` as `publicKey`. The verifier imports each key with `importJWK({ kty: "OKP", crv: "Ed25519", x })` and picks one by `kid`. Pass `algorithms: ["EdDSA"]` to `jwtVerify`, then read the claims by hand. The seen-`jti` map drops entries after their `exp`.
- [ ] **Step 4: Run** the test file. Expected: PASS. Run `bun run typecheck`.
- [ ] **Step 5: Commit** `feat: hub-signed proofs for node requests`.

### Task 2: Node verifies the proof

**Files:**
- Modify: `server/src/nodeauth.ts`
- Test: `server/test/nodeauth.test.ts`

**Interfaces:**
- Consumes: `createProofVerifier`, `ProofError` from Task 1.
- Produces: `NodeAuthSettings = { hubKeys: string[]; selfFingerprint: string; secretHashes: string[]; now?: () => number }` and `nodeAuth(s): MiddlewareHandler`. The caller name for a valid proof is `hub`.

- [ ] **Step 1: Rewrite the OIDC tests** in `nodeauth.test.ts`. Keep the shared-secret tests as they are. New tests:
  - `valid proof -> 200 and caller is "hub"`.
  - `Bearer <jwt> is treated as a secret and rejected`.
  - `Hub-Proof with no hubKeys configured -> 401`.
  - `POST with a JSON body: the handler can still read the body` (Review Focus 1).
  - `query with a space and an ampersand is accepted` (Review Focus 2).
  - `body over 1 MiB -> 413` (Review Focus 5).
  - `clock 10 s off -> 401` (Review Focus 3).
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement** the new `nodeAuth`. The scheme name picks the verifier. Remove the dot-counting rule and all `oidc` code. Read the body with `await c.req.text()`. Hono caches it, so later `c.req.json()` calls work. Build `pathAndQuery` from `new URL(c.req.url)`.
- [ ] **Step 4: Run** the file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(node): verify hub proofs instead of bearer tokens`.

### Task 3: Configuration

**Files:**
- Modify: `server/src/config.ts`, `server/src/nodemain.ts`, `server/src/hostclient.ts` (types only)
- Test: `server/test/config.test.ts`, `server/test/hostclient.test.ts` (the `[[hosts]] config` block)

**Interfaces:**
- Produces:
  - `NodeConfig.auth = { hubKeys: string[]; secretHashes: string[] }`
  - `HostAuth = { type: "hub_key" } | { type: "secret"; secret: string }`
  - `Config` no longer has `hubAuth`.

- [ ] **Step 1: Write the failing tests:**
  - a node file with two `[[node_auth.hub_key]]` rows parses to `hubKeys` in order.
  - `public_key` that is not base64url of 32 bytes is a problem that names the key path.
  - `[node_auth.oidc]` fails with a message that contains `node_auth.hub_key`.
  - a node file with neither `hub_key` nor `secret` fails.
  - a hub file with `[hub_auth]` fails with a message that says the section was removed.
  - a host with `auth.type = "hub_key"` parses. `"oidc"` fails and names `hub_key`.
- [ ] **Step 2: Run** `bun test server/test/config.test.ts server/test/hostclient.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** in `config.ts`: replace `parseHubAuth` with a rejection, update `parseNode` and `parseHosts`, remove the `ClientCredsSettings` import. In `nodemain.ts`, pass `hubKeys` and `selfFingerprint: "sha256:" + cert.fingerprintSha256` to `nodeAuth`.
- [ ] **Step 4: Run** the two files and `nodeapp.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(config): hub_key replaces oidc for nodes and hosts`.

### Task 4: Hub signs each request

**Files:**
- Modify: `server/src/hostclient.ts`, `server/src/hubmain.ts`, `server/src/hostregistry.ts`
- Test: `server/test/hostclient.test.ts`, `server/test/hostregistry.test.ts`

**Interfaces:**
- Consumes: `signProof`, `certFingerprint`, `loadOrCreateHubKey`.
- Produces:
  - `type Authorizer = (req: { method: string; pathAndQuery: string; body: string }) => Promise<string>`
  - `createHostClient(host: HostConfig, authorize: Authorizer, o?: { fetch?: typeof fetch }): HostClient`
  - `hubAuthorizer(key: HubKey, host: HostConfig): Authorizer` in `hostclient.ts`. It returns `Hub-Proof <jwt>` with `aud` from `certFingerprint(host.ca)`.
  - `secretAuthorizer(secret: string): Authorizer` returns `Bearer <secret>`.

- [ ] **Step 1: Write the failing tests:**
  - the client sends `Authorization: Hub-Proof ...` and the proof verifies with `createProofVerifier` for the fingerprint of `host.ca` (use a recording fake `fetch`).
  - the same proof fails against a verifier with a different `selfFingerprint`.
  - a POST proof has `bh` equal to sha256 of the JSON string that was sent.
  - an authorizer that throws gives `HostError(..., "rejected our credentials")`.
  - `HostRegistry.load` rebuilds managed hosts with `auth: { type: "hub_key" }`.
- [ ] **Step 2: Run** the two files. Expected: FAIL.
- [ ] **Step 3: Implement.** Replace the `token` parameter. In `hubmain.ts`, load the key once with `loadOrCreateHubKey(cfg.stateDir)` at the start of `startHub`. Build one authorizer per host. Delete `managedClientFactory`'s token logic and all `TokenSource` code.
- [ ] **Step 4: Run** the two files and `hosts.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hub): sign a proof for each node request`.

### Task 5: Enrollment, host add, and the regression test for finding 1

**Files:**
- Modify: `server/src/enrollment.ts`, `server/src/hostadmin.ts`, `server/src/app.ts`, `server/src/hubmain.ts`
- Test: `server/test/enrollment.test.ts`, `server/test/hostadmin.test.ts`, `server/test/cli-routes.test.ts`, `server/test/e2e.test.ts`

**Interfaces:**
- Produces:
  - `enrollmentApi(o: { hubKeys: string[] }): Hono`. `GET /` returns `{ hub_keys: [{ public_key: string }] }`.
  - `CliDeps` drops `hasHubAuth`. Its `enrollment` field becomes `{ hubKeys: string[] }`.
  - `hostAdminApi` drops the `hasHubAuth` option.

- [ ] **Step 1: Write the failing tests:**
  - enrollment returns the hub public key.
  - `host add` works with no hub credential configured.
  - **Regression for finding 1:** start a fake HTTPS server with its own certificate. Call `host add` with that server's real fingerprint. Record the `Authorization` header that the fake server receives. Start a real node (with `startNode`) and send it that same header on the same path. Expected: the node answers 401.
  - e2e: a hub and a node, set up with the hub key from enrollment, list instances through the hub.
- [ ] **Step 2: Run** the four files. Expected: FAIL.
- [ ] **Step 3: Implement.** Remove the `hasHubAuth` guard at `hostadmin.ts:88`. Rewrite `enrollment.ts` without any IdP code. Wire `hubKeys: [key.publicKey]` in `hubmain.ts`.
- [ ] **Step 4: Run** the four files. Expected: PASS.
- [ ] **Step 5: Commit** `feat: enroll nodes with the hub public key`.

### Task 6: CLI writes the hub key into the node configuration

**Files:**
- Modify: `cli/src/nodecmd.ts`, `cli/src/nodesetup.ts`
- Test: `cli/test/nodecmd.test.ts`, `cli/test/nodesetup.test.ts`

**Interfaces:**
- Produces: `type Enrollment = { hub_keys: { public_key: string }[] }`. `renderNodeConfig` writes one `[[node_auth.hub_key]]` table per key.

- [ ] **Step 1: Update the tests.** The rendered file contains `[[node_auth.hub_key]]` and `public_key = "..."`. It does not contain `node_auth.oidc`. The comment line says that the key is public.
- [ ] **Step 2: Run** `bun test cli`. Expected: FAIL.
- [ ] **Step 3: Implement** the new type and renderer. `nodesetup.ts` needs only the type change.
- [ ] **Step 4: Run** `bun test cli`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): node setup writes the hub key`.

### Task 7: Delete the OIDC client-credentials code

**Files:**
- Delete: `server/src/clientcreds.ts`, `server/test/clientcreds.test.ts`, `scripts/authentik-probe.ts`, `server/test/probe.test.ts`
- Modify: any file that `bun run typecheck` still flags.

- [ ] **Step 1: Run** `grep -rn "clientcreds\|authentik-probe" --exclude-dir=node_modules --exclude-dir=.git .`. Remove each remaining reference.
- [ ] **Step 2: Delete** the four files.
- [ ] **Step 3: Run** `bun run typecheck && bun test server web/src ./cli`. Expected: no type errors, no new failures. The sandbox-only failures in the `bun-not-on-path` memory are known.
- [ ] **Step 4: Commit** `chore: remove the hub OIDC client credential`.

### Task 8: Documentation and deploy files

**Files:**
- Modify: `README.md`, `deploy/node.config.example.toml`, `deploy/install-binary.sh`, `deploy/config.example.toml`
- Test: `server/test/install.test.ts`

- [ ] **Step 1: Update** `install.test.ts`: a node file with `[[node_auth.hub_key]]` lets the installer proceed. A file with only `[node_auth.oidc]` does not.
- [ ] **Step 2: Run** `bun test server/test/install.test.ts`. Expected: FAIL.
- [ ] **Step 3: Update** the grep at `install-binary.sh:144` and its message to accept `hub_key` or `secret`. Replace the OIDC block in `node.config.example.toml` with a `[[node_auth.hub_key]]` example. If `deploy/config.example.toml` has `[hub_auth]`, remove it.
- [ ] **Step 4: Update the README:**
  - the multiple hosts section and the `[node_auth]` and `[hub_auth]` tables
  - the threat notes (lines 29 to 37): the hub no longer sends a reusable credential, and revocation now means removing the key from the nodes
  - the manual `host add` steps: where to read the hub public key (the `node-enrollment` response or the log line the hub prints at start)
  - the rotation procedure from the spec
  - clock skew: hub and node clocks must agree within 5 seconds
- [ ] **Step 5: Make the hub print its key.** At start, `startHub` logs `hub key <kid> public_key=<base64url>`. Add a small test in `e2e.test.ts` that captures the log line.
- [ ] **Step 6: Run** `bun run typecheck && bun test server web/src ./cli`. Expected: PASS apart from the known sandbox-only failures.
- [ ] **Step 7: Commit** `docs: hub-signed node requests`.

---

## Self-Review

- Spec coverage is complete. Each spec section maps to a task:
  - hub key and proof rules: Tasks 1 and 2
  - node configuration: Task 3
  - hub changes: Tasks 3, 4 and 5
  - enrollment: Tasks 5 and 6
  - removal of `hub_auth`: Tasks 3 and 7
  - the fake-server test: Task 5
  - docs and rotation: Task 8
- The spec's non-goals (probe SSRF, `/probe` audit, admin gate) have no task on purpose.
- Types: `HubKey`, `ProofRequest`, `Authorizer` and `NodeAuthSettings` have one definition each, and later tasks use the same names.

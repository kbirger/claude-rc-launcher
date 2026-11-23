# SSH Delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A session on a node can reach a target machine over SSH for a limited time. The owner must approve on the phone and unlock the key first.

**Architecture:** The hub holds one encrypted Ed25519 key for each target and signs only while an approved grant is active. Each node runs a small SSH agent socket with no key. The socket sends sign requests to the hub on the existing node event stream. The hub answers with a signed call to the node. The owner approves and unlocks in the web UI with a passkey (WebAuthn PRF) or a passphrase.

**Tech Stack:** Bun, TypeScript and Hono. Crypto comes from `node:crypto`. Tests use `bun test` for the server and CLI, and vitest for the SvelteKit web UI.

**Spec:** `docs/superpowers/specs/2026-11-23-ssh-delegation-design.md`. Background: `docs/superpowers/specs/2026-11-23-authsock-warden-assessment.md`.

## Global Constraints

- Keys are Ed25519. One key for each target. The key comment is `claude-rc:<target id>`.
- A grant lasts 60 minutes by default and 480 minutes at most. A grant cannot be extended.
- A test grant lasts 1 minute.
- Every grant needs a new unlock. The hub keeps no unlock after the grant ends.
- Only an `admin` approves, unlocks, adds a target, or revokes. A `write` user can list targets and grants.
- A hub restart ends all grants. A node that loses its event stream ends its grants.
- The line for the target is `from="<node addresses>",restrict ssh-ed25519 <key> claude-rc:<target id>`.
- A target id matches `^[a-z0-9][a-z0-9-]{0,31}$` (the pattern in `server/src/hostid.ts`).
- Linux nodes only for sessions. A Windows node refuses the grant routes with 501, but it can be a managed target.
- System types are `linux`, `windows`, `synology` and `dropbear`.
- The own SSH key of the owner stays on the machine that runs the CLI. It never goes to the hub.
- Code style: before each commit, run `bun run typecheck` and `bun run lint`. Doc comments follow the style of `server/src/namememory.ts`.
- Commit messages use the `feat:` and `fix:` prefixes. End each message with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Tests: `bun test server ./cli` for the server and CLI. `bun run --cwd web test` for the web UI.

## Review Focus

- A sign request for an ended grant, or for a different key, gets a failure and no signature. Task 6 and Task 8 test this.
- An oversize or cut frame closes that one connection. The agent keeps running. Task 1 and Task 7 test this.
- A wrong unlock secret leaves the grant `pending` and puts no key in memory. Task 11 tests this.
- Two approvals of one grant give one `active` grant and a 409 for the second. Task 6 tests this.
- When a node comes back after a hub restart, the hub tells it to close every socket. Task 11 tests this.
- The CLI never sends the identity key to the hub, and it trusts only the pinned host key for the install. Task 13 tests this.

## File Structure

Server files are flat in `server/src`, with the prefix `ssh`, as the existing code does.

- `sshagentproto.ts`: the SSH agent wire format and OpenSSH key text. Used by the hub and the node.
- `sshwrap.ts`: key derivation and encryption helpers.
- `sshkeystore.ts`: the encrypted key file on the hub.
- `sshtargets.ts`: target records and the `authorized_keys` line.
- `sshprovision.ts`: the scripts that add a key line to `authorized_keys` for each system type. Used by the CLI and by managed nodes.
- `sshgrants.ts`: the grant state machine and the audit lines.
- `sshnodeagent.ts`: the agent socket for one grant, on a node.
- `sshnodecontrol.ts`: the control socket for one instance, on a node.
- `sshnodeapi.ts`: the node routes under `/ssh`.
- `sshservice.ts`: the hub logic that joins the stores, the grants and the nodes.
- `sshapi.ts`: the hub routes under `/api/ssh`.
- `cli/src/sshcmd.ts`: the `claude-rc ssh` commands for sessions.
- `cli/src/sshtarget.ts`: the `claude-rc ssh target add` command for the owner.
- `web/src/lib/features/ssh/`: the web UI feature. `web/src/routes/ssh/`: the pages.

---

## Phase A: hub building blocks

### Task 1: SSH agent wire format

**Files:**
- Create: `server/src/sshagentproto.ts`
- Test: `server/test/sshagentproto.test.ts`

**Interfaces:**
- Produces:
  - `MAX_FRAME = 262144`
  - `class AgentProtocolError extends Error`
  - `type AgentRequest = { type: "identities" } | { type: "sign"; keyBlob: Uint8Array; data: Uint8Array; flags: number } | { type: "other"; code: number }`
  - `publicKeyBlob(raw: Uint8Array): Uint8Array`
  - `publicKeyLine(raw: Uint8Array, comment: string, options?: string): string`
  - `keyFingerprint(blob: Uint8Array): string` (form `SHA256:<base64 without padding>`)
  - `class FrameReader { push(chunk: Uint8Array): Uint8Array[] }` (returns whole payloads, throws `AgentProtocolError` over `MAX_FRAME`)
  - `parseRequest(payload: Uint8Array): AgentRequest`
  - `identitiesAnswer(items: { blob: Uint8Array; comment: string }[]): Uint8Array`
  - `signAnswer(rawSignature: Uint8Array): Uint8Array`
  - `failureAnswer(): Uint8Array`
  - The three answer functions return a complete frame with the 4-byte length.

- [ ] **Step 1: Write the failing tests.**
  Test names:
  - `publicKeyLine has the OpenSSH form`
  - `keyFingerprint matches ssh-keygen -lf`. If `ssh-keygen` is missing, skip this test.
  - `ssh-keygen`
  - `FrameReader joins a frame split over chunks`
  - `FrameReader returns two frames from one chunk`
  - `FrameReader throws over MAX_FRAME`
  - `parseRequest maps type 11 to identities and 13 to sign`
  - `parseRequest returns other for type 17`
  - `parseRequest throws on a cut sign request`
  - `signAnswer carries the ssh-ed25519 name and 64 bytes`
- [ ] **Step 2: Run** `bun test server/test/sshagentproto.test.ts`. Expect FAIL (module missing).
- [ ] **Step 3: Implement the interface above.** The key blob is the string `ssh-ed25519` followed by the 32-byte key, each with a 4-byte big-endian length. The sign answer is message type 14 with a string that holds `ssh-ed25519` and the signature.
- [ ] **Step 4: Run the same command.** Expect PASS.
- [ ] **Step 5: Commit** `feat: SSH agent wire format`.

### Task 2: Key wrapping helpers

**Files:**
- Create: `server/src/sshwrap.ts`
- Test: `server/test/sshwrap.test.ts`

**Interfaces:**
- Produces:
  - `type Sealed = { iv: string; ct: string }` (base64url)
  - `deriveWrapKey(method: "prf" | "passphrase", secret: Uint8Array, salt: Uint8Array): Promise<Uint8Array>` (32 bytes. HKDF-SHA256 for `prf`. scrypt with N=32768 for `passphrase`)
  - `seal(wrapKey: Uint8Array, plain: Uint8Array, aad: string): Sealed` (AES-256-GCM)
  - `unseal(wrapKey: Uint8Array, sealed: Sealed, aad: string): Uint8Array` (throws `WrapError` on a wrong key or changed `aad`)
  - `newRecovery(): { publicKey: string; code: string }` (X25519. `code` is the private key in groups of four, base32)
  - `sealToRecovery(publicKey: string, plain: Uint8Array, aad: string): string`
  - `openWithRecovery(code: string, sealed: string, aad: string): Uint8Array`
  - `class WrapError extends Error`

- [ ] **Step 1: Write the failing tests.**
  Test names:
  - `seal and unseal round trip`
  - `unseal throws with a wrong key`
  - `unseal throws with a different aad`
  - `the same secret with two salts gives two keys`
  - `passphrase and prf give different keys for the same bytes`
  - `recovery round trip`
  - `recovery code with a typo throws`
  - `two seals of one plain text differ`
- [ ] **Step 2: Run** `bun test server/test/sshwrap.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** with `node:crypto` only. Use a fresh 12-byte IV for each seal. For the recovery copy, derive a one-time X25519 key pair. Run ECDH with the recovery public key, then HKDF on the result. Seal with that key.
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `feat: SSH key wrapping helpers`.

### Task 3: Encrypted key store

**Files:**
- Create: `server/src/sshkeystore.ts`
- Test: `server/test/sshkeystore.test.ts`

**Interfaces:**
- Consumes: `sshwrap.ts`, `sshagentproto.ts`.
- Produces:
  - `interface UnlockSecret { method: "prf" | "passphrase"; secret: Uint8Array }`
  - `interface UnlockedKey { fingerprint: string; publicBlob: Uint8Array; sign(data: Uint8Array): Uint8Array; destroy(): void }`
  - `class KeyError extends Error` with `code: "wrong-unlock" | "no-key" | "not-set-up"`
  - `class SshKeyStore { constructor(file?: string); setup(input: { method: "prf" | "passphrase"; credentialId?: string; recoveryPublicKey: string }): Promise<void>; isSetUp(): boolean; method(): "prf" | "passphrase" | undefined; credentialId(): string | undefined; saltFor(targetId: string): Promise<string>; create(targetId: string, unlock: UnlockSecret): Promise<{ publicLine: string; fingerprint: string }>; open(targetId: string, unlock: UnlockSecret): Promise<UnlockedKey>; rewrapWithRecovery(targetId: string, code: string, unlock: UnlockSecret): Promise<void>; remove(targetId: string): Promise<void> }`
  - `UnlockedKey.destroy()` overwrites the private key bytes with zeros. After `destroy`, `sign` throws.

- [ ] **Step 1: Write the failing tests.**
  Test names:
  - `create then open signs data that the public key verifies`
  - `open with a wrong secret throws wrong-unlock and returns no key`
  - `the file has mode 600`
  - `the file never holds the private key bytes`. Search the file for the raw seed in hex, base64 and base64url.
  - `a key has a passkey copy and a recovery copy`
  - `rewrapWithRecovery lets a new secret open the key`
  - `a missing or corrupt file is an empty store`
  - `saltFor returns the same salt on each call for one target`
  - `sign after destroy throws`
  - `remove deletes the key and its salt`
- [ ] **Step 2: Run** `bun test server/test/sshkeystore.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** Store JSON in `<state_dir>/ssh/keys.json`. Write through a temporary file and a rename, as `server/src/namememory.ts` does. Use the target id as the `aad` for `seal`. Cap the file at 1 MiB and the number of keys at 200.
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `feat: encrypted SSH key store`.

### Task 4: Target store

**Files:**
- Create: `server/src/sshtargets.ts`
- Test: `server/test/sshtargets.test.ts`

**Interfaces:**
- Produces:
  - `type SystemType = "linux" | "windows" | "synology" | "dropbear"`
  - `type TargetState = "draft" | "ready" | "disabled" | "retired"`
  - `interface Target { id: string; address: string; port: number; account: string; systemType: SystemType; nodes: string[]; managedHost?: string; hostKey?: string; keyFingerprint?: string; state: TargetState }`
  - `interface NodeAccess { enabled: boolean; sourceAddress: string }`
  - `class TargetStore { constructor(file?: string); list(): Target[]; get(id: string): Target | undefined; add(input: Omit<Target, "state" | "hostKey" | "keyFingerprint">): Promise<Target>; setKeyFingerprint(id: string, fingerprint: string): Promise<void>; setHostKey(id: string, line: string): Promise<void>; setState(id: string, state: TargetState): Promise<void>; remove(id: string): Promise<void>; nodeAccess(hostId: string): NodeAccess | undefined; setNodeAccess(hostId: string, access: NodeAccess): Promise<void> }`
  - `authorizedKeysLine(publicLine: string, sourceAddresses: string[]): string`
  - `installNotes(systemType: SystemType): string[]`
  - `class TargetError extends Error` with `status: 400 | 404 | 409`

- [ ] **Step 1: Write the failing tests.**
  Test names:
  - `add rejects an id that does not match the pattern`
  - `add rejects a duplicate id with 409`
  - `add rejects a port outside 1 to 65535`
  - `a new target is draft`
  - `authorizedKeysLine puts from and restrict before the key`
  - `authorizedKeysLine with no source address throws`
  - `installNotes for dropbear names the Authorized Keys page`
  - `installNotes for windows names administrators_authorized_keys`
  - `add rejects a managedHost that is not a host id`
  - `setNodeAccess rejects an empty source address when enabled`
  - `data survives a reload from the file`
- [ ] **Step 2: Run** `bun test server/test/sshtargets.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** with the same file approach as Task 3, in `<state_dir>/ssh/targets.json`. The text of `installNotes` comes from the "Target setup" section of the spec.
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `feat: SSH target store`.

### Task 5: Provisioning scripts

**Files:**
- Create: `server/src/sshprovision.ts`
- Test: `server/test/sshprovision.test.ts`

**Interfaces:**
- Consumes: `SystemType` from Task 4.
- Produces:
  - `type Script = { shell: "sh" | "powershell"; script: string }`
  - `provisionScript(systemType: SystemType, line: string, options?: { account?: string }): Script`
- The script adds `line` to the right `authorized_keys` file once. It creates the folder and sets the permissions. It prints nothing on success and exits with a code other than 0 on failure. The `account` option is for the Windows script of a managed target, which names the account whose profile receives the key. The shell scripts ignore it.
- The scripts for each type, from the spec:
  - `linux` and `dropbear`: `~/.ssh/authorized_keys`, folder mode 700, file mode 600.
  - `synology`: the same, and remove group and other write from the home folder.
  - `windows`: for an administrator, `C:\ProgramData\ssh\administrators_authorized_keys` with `icacls` limited to SYSTEM and Administrators. For any other account, `%USERPROFILE%\.ssh\authorized_keys`.

- [ ] **Step 1: Write the failing tests.**
  Test names:
  - `the sh script adds the line once when it runs twice`. Run it with `sh` and a temporary `HOME`.
  - `the sh script sets mode 700 on .ssh and 600 on the file`
  - `the sh script keeps the other keys in the file`
  - `a line with a single quote or a dollar sign arrives unchanged`
  - `the synology script removes group and other write from the home folder`
  - `the dropbear script writes the same file as the linux script`
  - `the windows script names administrators_authorized_keys and icacls`
  - `the windows script parses as PowerShell`. If `pwsh` is missing, skip this test.
- [ ] **Step 2: Run** `bun test server/test/sshprovision.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** `provisionScript`. Put the line in a single-quoted shell string, and replace each single quote with `'\''`. In PowerShell, use a single-quoted string and double each single quote.
- [ ] **Step 4: Run.** Expect PASS. The Windows script also needs a hand test on a real Windows machine. Write the result in the commit message.
- [ ] **Step 5: Commit** `feat: SSH provisioning scripts`.

### Task 6: Grant state machine

**Files:**
- Create: `server/src/sshgrants.ts`
- Test: `server/test/sshgrants.test.ts` (use `server/test/faketimers.ts`)

**Interfaces:**
- Consumes: `UnlockedKey` from Task 3.
- Produces:
  - `type GrantState = "pending" | "active" | "ended"`
  - `type EndReason = "expired" | "revoked" | "denied" | "node-lost" | "target-disabled" | "hub-restart"`
  - `interface Grant { id: string; nodeId: string; instanceId: string; targetId: string; minutes: number; reason?: string; test: boolean; state: GrantState; requestedAt: number; approvedAt?: number; endsAt?: number; approvedBy?: string; endReason?: EndReason }`
  - `class GrantError extends Error` with `status: 400 | 404 | 409 | 403`
  - `class GrantStore { constructor(options: { now?: () => number; timers?: Timers; audit: (line: string) => void; onEnd: (grant: Grant) => void; defaultMinutes?: number; maxMinutes?: number }); request(input: { nodeId: string; instanceId: string; targetId: string; minutes?: number; reason?: string; test?: boolean }): Grant; approve(id: string, by: string, key: UnlockedKey, minutes?: number): Grant; deny(id: string, by: string): Grant; revoke(id: string, by: string): Grant; endWhere(match: (grant: Grant) => boolean, reason: EndReason): Grant[]; sign(id: string, keyBlob: Uint8Array, data: Uint8Array): Uint8Array; get(id: string): Grant | undefined; list(): Grant[] }`
  - `Timers` is the type from `server/src/changesource.ts`.
  - When a grant ends, the store calls `key.destroy()` and then `onEnd`.

- [ ] **Step 1: Write the failing tests.**
  Test names:
  - `request gives a pending grant with the default 60 minutes`
  - `request clamps minutes to 480`
  - `a test grant is 1 minute`
  - `approve makes the grant active with an end time`
  - `a second approve throws 409 and keeps one active grant`
  - `sign on a pending grant throws 403`
  - `sign with another key blob throws 403`
  - `sign after the end time throws 403 and the key is destroyed`
  - `revoke ends the grant and destroys the key`
  - `endWhere ends every matching active grant`
  - `deny ends a pending grant with reason denied`
  - `every transition writes one audit line`
  - `an audit line for a sign holds the key fingerprint and no data`
- [ ] **Step 2: Run** `bun test server/test/sshgrants.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** Keep grants in memory only. Use one timer for each active grant, set with `timers.setTimeout`. Audit lines have the form `audit ssh grant=<id> event=<event> node=<node> target=<target> by=<user>`. Use `logToken` from `server/src/roles.ts` for every value that a user can set.
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `feat: SSH grant state machine`.

---

## Phase B: node side

### Task 7: Agent socket for one grant

**Files:**
- Create: `server/src/sshnodeagent.ts`
- Test: `server/test/sshnodeagent.test.ts`

**Interfaces:**
- Consumes: `sshagentproto.ts`.
- Produces: `class GrantAgent { constructor(options: { dir: string; grantId: string; publicBlob: Uint8Array; comment: string; forwardSign: (keyBlob: Uint8Array, data: Uint8Array, flags: number) => Promise<Uint8Array>; uid?: number; gid?: number; signTimeoutMs?: number }); start(): Promise<string>; stop(): Promise<void> }`
- `start` creates `<dir>/<grantId>.sock` with mode 600 and returns the path. If `uid` and `gid` are given, the socket belongs to them. `forwardSign` returns the raw 64-byte signature.

- [ ] **Step 1: Write the failing tests** with a real Unix socket in a temporary folder.
  Test names:
  - `identities returns the one public key and its comment`
  - `sign calls forwardSign and returns the signature`
  - `sign for another key blob gets a failure`
  - `sign gets a failure when forwardSign rejects`
  - `sign gets a failure after signTimeoutMs`
  - `any other request type gets a failure`
  - `a frame over MAX_FRAME closes that connection and a second client still works`
  - `a cut frame then a close does not crash the agent`
  - `the socket file has mode 600`
  - `stop removes the socket file and refuses new connections`
- [ ] **Step 2: Run** `bun test server/test/sshnodeagent.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** with `Bun.listen({ unix })`. Use one `FrameReader` for each connection. Default `signTimeoutMs` is 10000.
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Add a test** `ssh-add -L reads the key` that runs the real `ssh-add` with `SSH_AUTH_SOCK` set. If `ssh-add` is missing, skip this test. Otherwise run it and expect PASS.
- [ ] **Step 6: Commit** `feat: node SSH agent socket`.

### Task 8: Node routes for grants

**Files:**
- Create: `server/src/sshnodeapi.ts`
- Modify: `server/src/updateevents.ts` (the `NodeEvent` union), `server/src/app.ts` (in `createNodeApp`, mount the routes at `/ssh` and write the new events in the `/events` handler)
- Test: `server/test/sshnodeapi.test.ts`

**Interfaces:**
- Consumes: `GrantAgent` (Task 7).
- Produces: `sshNodeApi(options: { dir: string; events: NodeEvents; resolveUser?: (instanceId: string) => { uid: number; gid: number } | undefined; keyscan?: (address: string, port: number) => Promise<string[]> }): Hono`
- Routes, all behind the existing node auth:
  - `GET /status` returns `{ ssh: boolean; dir: boolean }`. The field `ssh` tells whether the `ssh` program exists.
  - `POST /grants` takes `{ grantId, instanceId, targetId, publicKey, address, port, account, hostKey, endsAt }`. It starts a `GrantAgent`, writes `<dir>/<grantId>.config` and `<dir>/<grantId>.known_hosts`, and returns `{ socket, config }`.
  - `DELETE /grants/:id` stops the agent and removes the three files.
  - `POST /sign-result` takes `{ signId, signature?: string, error?: string }` and settles the waiting sign request.
  - `POST /reset` stops every agent.
  - `POST /scan` takes `{ address, port }` and returns `{ keys: { line: string; fingerprint: string }[] }`.
- New node events: `{ type: "ssh.request"; requestId: string; instanceId: string; targetId: string; minutes?: number; reason?: string }` and `{ type: "ssh.sign"; signId: string; grantId: string; keyBlob: string; data: string; flags: number }` (blobs in base64).
- The config file has exactly these lines for a target: `Host <id>`, `HostName <address>`, `Port <port>`, `User <account>`, `IdentityAgent <socket>`, `UserKnownHostsFile <known_hosts path>`, `GlobalKnownHostsFile /dev/null`, `StrictHostKeyChecking yes`, `ControlMaster no`, `ControlPath none`.

- [ ] **Step 1: Write the failing tests** with `createNodeApp` and a fake auth.
  Test names:
  - `POST /grants returns a socket path that answers identities`
  - `POST /grants writes a config with the lines above and StrictHostKeyChecking yes`
  - `a known_hosts line for a port other than 22 uses the [host]:port form`
  - `DELETE /grants removes the socket and both files`
  - `a sign request emits one ssh.sign event and waits for sign-result`
  - `sign-result with an error gives the ssh client a failure`
  - `an unknown signId in sign-result gives 404`
  - `reset stops every agent`
  - `scan returns the fingerprint of each key line`
  - `a Windows node answers 501`. If the Windows app in `server/src/win/` mounts the routes, use it. Otherwise test the guard function.
  - `server/src/win/`
- [ ] **Step 2: Run** `bun test server/test/sshnodeapi.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement the routes.** Write the two new events the way the `/events` handler writes `sessions` events (`server/src/app.ts` near line 422). For `scan`, run `ssh-keyscan -t ed25519 -p <port> <address>` with a 5-second limit. Put it behind the `keyscan` option, so that tests use a fake.
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `feat: node SSH routes and events`.

### Task 9: Managed targets on the node

**Files:**
- Modify: `server/src/sshnodeapi.ts`
- Test: `server/test/sshnodeapi-managed.test.ts`

**Interfaces:**
- Consumes: `provisionScript` (Task 5), and the user switch in `server/src/asuser.ts`.
- Adds two options to `sshNodeApi`: `hostKeyFile?: string` (default `/etc/ssh/ssh_host_ed25519_key.pub` on Linux, `C:\ProgramData\ssh\ssh_host_ed25519_key.pub` on Windows) and `runAs?: (account: string, script: Script) => Promise<{ code: number; stderr: string }>`.
- Adds two routes behind the node auth:
  - `GET /hostkey` returns `{ keys: { line: string; fingerprint: string }[] }`.
  - `POST /authorize` takes `{ account, systemType, line }` and answers 204.
- These routes also work on a Windows node. Only the grant routes of Task 8 answer 501 there.

- [ ] **Step 1: Write the failing tests** with a fake `runAs` and a temporary key file.
  Test names:
  - `GET /hostkey returns the line and the fingerprint of the key file`
  - `GET /hostkey gives 404 with the text "sshd has no ed25519 host key" when the file is missing`
  - `POST /authorize runs the script for the account and answers 204`
  - `POST /authorize passes the line to the script unchanged`
  - `POST /authorize rejects an account with a slash or a space with 400`
  - `POST /authorize answers 500 with the error text of the script when it fails`
  - `POST /authorize rejects a line that does not start with from= or ssh-ed25519 with 400`
- [ ] **Step 2: Run** `bun test server/test/sshnodeapi-managed.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the routes. The account must match `^[A-Za-z0-9._][A-Za-z0-9._-]{0,31}$`. On Linux, `runAs` runs `sh -s` with the script on stdin as that account, through `asuser.ts`. On Windows, it runs `powershell -NoProfile -NonInteractive -Command -` with the script on stdin, and passes the account as the `account` option.
- [ ] **Step 4: Run.** Expect PASS. The Windows route needs a hand test on a Windows node.
- [ ] **Step 5: Commit** `feat: managed SSH targets on the node`.

### Task 10: Control socket and the `claude-rc ssh` commands

**Files:**
- Create: `server/src/sshnodecontrol.ts`, `cli/src/sshcmd.ts`
- Modify: `cli/src/index.ts` (add the `ssh` command)
- Test: `server/test/sshnodecontrol.test.ts`, `cli/test/sshcmd.test.ts`

**Interfaces:**
- Produces:
  - `class SshControl { constructor(options: { dir: string; instanceId: string; uid?: number; gid?: number; targets: () => { id: string; account: string; address: string }[]; request: (input: { instanceId: string; targetId: string; minutes?: number; reason?: string }) => Promise<{ socket: string; config: string; endsAt: number }>; }); start(): Promise<string>; stop(): Promise<void> }`
  - The control socket is `<dir>/<instanceId>/control.sock`, mode 600. It speaks one JSON object for each line: requests `{ op: "targets" }` and `{ op: "request", targetId, minutes?, reason? }`. Answers `{ ok: true, ... }` or `{ ok: false, error }`.
  - `sshTargets(options: { control: string; out: (line: string) => void }): Promise<void>`
  - `sshRequest(options: { control: string; targetId: string; minutes?: number; reason?: string; out: (line: string) => void }): Promise<void>` prints `waiting for approval`, then `socket: <path>`, `config: <path>` and `ssh -F <config> <target>`.
  - Both commands read the control path from `CLAUDE_RC_SSH_CONTROL`. If it is unset, they exit with code 1 and the message `SSH access is not turned on for this instance`.

- [ ] **Step 1: Write the failing tests.**
  Server test names, in `server/test/sshnodecontrol.test.ts`:
  - `targets lists names, accounts and addresses and no key`
  - `request passes the instance id of the socket that was used`
  - `a bad JSON line gets ok false and the socket stays open`
  - `a request line over 16 KiB closes the connection`
  - `stop removes the socket`

  CLI test names, in `cli/test/sshcmd.test.ts`:
  - `ssh targets prints one line for each target`
  - `ssh request prints the waiting line, then the paths`
  - `ssh request without the environment variable exits 1 with the message above`
  - `ssh request prints the error text when the answer is ok false`
- [ ] **Step 2: Run** `bun test server/test/sshnodecontrol.test.ts cli/test/sshcmd.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** Follow the argument handling in `cli/src/args.ts` and the registration of commands in `cli/src/index.ts`.
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `feat: SSH control socket and claude-rc ssh`.

---

## Phase C: hub side

### Task 11: Hub service and node events

**Files:**
- Create: `server/src/sshservice.ts`
- Modify: `server/src/nodewatcher.ts` (new options `onSsh`, `onOnline`, `onOffline`)
- Test: `server/test/sshservice.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 4, 6. `HostClient` from `server/src/hostclient.ts`.
- Produces: `class SshService { constructor(deps: { keys: SshKeyStore; targets: TargetStore; grants: GrantStore; client: (hostId: string) => HostClient | undefined; audit: (line: string) => void }); onNodeEvent(hostId: string, event: string, data: unknown): void; onNodeOnline(hostId: string): Promise<void>; onNodeOffline(hostId: string): void; approve(grantId: string, by: string, unlock: UnlockSecret, minutes?: number): Promise<Grant>; revoke(grantId: string, by: string): Promise<Grant>; scanHostKey(targetId: string, hostId: string): Promise<{ line: string; fingerprint: string }[]>; pinManaged(targetId: string): Promise<{ line: string; fingerprint: string }[]>; authorizeManaged(targetId: string): Promise<void>; test(targetId: string, hostId: string, by: string, unlock: UnlockSecret): Promise<Grant> }`
- `onNodeEvent` handles `ssh.request` (creates a pending grant) and `ssh.sign` (signs with the grant key and calls `POST /ssh/sign-result` on the node).
- `approve` opens the key, activates the grant, then calls `POST /ssh/grants` on the node. If the node call fails, the grant ends with reason `node-lost` and the key is destroyed.
- `pinManaged` reads the host key with `GET /ssh/hostkey` on the managed host and stores it. `authorizeManaged` calls `POST /ssh/authorize` on the managed host with the account, the system type and the install line. Both throw `TargetError` with status 409 for an external target.
- `onNodeOnline` calls `POST /ssh/reset`. `onNodeOffline` ends the active grants of that node with reason `node-lost`.

- [ ] **Step 1: Write the failing tests** with a fake `HostClient` that records calls.
  Test names:
  - `an ssh.request event makes a pending grant for that node and instance`
  - `an ssh.request for a target that does not list the node is dropped and audited`
  - `an ssh.request for a disabled target is dropped`
  - `approve with a wrong unlock leaves the grant pending and holds no key`
  - `approve activates and calls POST /ssh/grants once`
  - `approve when the node call fails ends the grant with node-lost`
  - `an ssh.sign event for an active grant calls sign-result with a signature`
  - `an ssh.sign event for an ended grant calls sign-result with an error`
  - `onNodeOnline calls POST /ssh/reset`
  - `onNodeOffline ends the active grants of that node`
  - `test makes a one-minute grant, approves it and returns it`
  - `pinManaged stores the host key from GET /ssh/hostkey`
  - `authorizeManaged sends the account, the system type and the install line`
  - `pinManaged and authorizeManaged on an external target throw 409`
- [ ] **Step 2: Run** `bun test server/test/sshservice.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement the service.** Decode the `ssh.sign` blobs from base64. Sign the data with `UnlockedKey.sign`. Return the raw 64-byte signature in base64. The node builds the agent answer with `signAnswer`.
- [ ] **Step 4: Modify `nodewatcher.ts`.** In the event loop, send every event whose name starts with `ssh.` to `options.onSsh`. Call `options.onOnline` where the loop calls `publish("online"` and `options.onOffline` where presence leaves `online`. Add a test in `server/test/nodewatcher.test.ts` named `ssh events reach onSsh and offline reaches onOffline` (follow the existing tests in that file).
- [ ] **Step 5: Run** `bun test server/test/sshservice.test.ts server/test/nodewatcher.test.ts`. Expect PASS.
- [ ] **Step 6: Commit** `feat: hub SSH service`.

### Task 12: Hub routes and roles

**Files:**
- Create: `server/src/sshapi.ts`
- Modify: `server/src/roles.ts` (add the rows to `RULES`)
- Modify: `server/src/app.ts` (mount `api.route("/ssh", ...)` near `api.route("/hosts", forwarding())`, and mount the same router on `cliApi` so that the CLI can reach it)
- Modify: `server/src/hubmain.ts` (build the stores in `<state_dir>/ssh/` and the service, then pass `onSsh`, `onOnline` and `onOffline` to `createNodeWatchers`)
- Test: `server/test/sshapi.test.ts`

**Interfaces:**
- Produces: `sshApi(options: { service: SshService; keys: SshKeyStore; targets: TargetStore; grants: GrantStore; user: (context: Context) => string }): Hono`. Request bodies carry the unlock as `{ method: "prf" | "passphrase"; secret: string }` with the secret in base64url.
- Routes and minimum roles (a route that is not set up answers 409 `SSH access is not set up`, except `GET /status` and `POST /setup`):
  - `write`: `GET /status`, `GET /targets`, `GET /grants`
  - `admin`, setup: `POST /setup` (returns the recovery code once) and `PUT /nodes/:host`.
  - `admin`, targets: `POST /targets`, `GET /targets/:id`, `PATCH /targets/:id`, `DELETE /targets/:id`, `GET /targets/:id/salt`, `POST /targets/:id/key`, `POST /targets/:id/test`.
  - `admin`, host key: `POST /targets/:id/scan`, `POST /targets/:id/pin` and `POST /targets/:id/pin-managed`.
  - `admin`, install: `GET /targets/:id/provision` (returns `{ shell, script }` for the install line) and `POST /targets/:id/authorize` (managed targets only).
  - `admin`, grants: `POST /grants/:id/approve`, `POST /grants/:id/deny` and `POST /grants/:id/revoke`.

- [ ] **Step 1: Write the failing tests.**
  Test names:
  - `every ssh route has a row in RULES with the role above`. Loop over the routes and call `requiredRole`.
  - `GET /status before setup says not set up`
  - `POST /setup returns a recovery code once and a second call gives 409`
  - `POST /targets/:id/key returns the authorized_keys line with from and restrict`
  - `POST /targets/:id/key with a wrong unlock gives 403 and creates no key`
  - `POST /grants/:id/approve with a wrong unlock gives 403 and the grant stays pending`
  - `POST /grants/:id/approve twice gives 409 the second time`
  - `a write user gets 403 on approve`
  - `every write route writes an audit line with the user`
  - `PATCH /targets/:id to disabled ends its active grants`
  - `GET /targets/:id/provision returns a shell and a script that holds the install line`
  - `POST /targets/:id/authorize on an external target gives 409`
  - `the same routes answer under /cli/api/ssh`
- [ ] **Step 2: Run** `bun test server/test/sshapi.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the routes, the `RULES` rows and the wiring.
- [ ] **Step 4: Run** `bun test server`. Expect PASS for the whole server suite.
- [ ] **Step 5: Commit** `feat: hub SSH routes`.

### Task 13: The `claude-rc ssh target add` command

**Files:**
- Create: `cli/src/sshtarget.ts`
- Modify: `cli/src/index.ts` (route `ssh target add`, and the usage text)
- Test: `cli/test/sshtarget.test.ts` (follow `cli/test/hostcmd.test.ts` for the fake hub)

**Interfaces:**
- Consumes: the hub routes of Task 12 under `/cli/api/ssh`, and `HubClient` from `cli/src/hub.ts`.
- Produces: `sshTargetAdd(options: { id: string; flags: Flags; hub: HubClient; readLine: (prompt: string) => Promise<string>; readSecret: (prompt: string) => Promise<string>; runLocal: (argv: string[], stdin: string) => Promise<{ code: number; stderr: string }>; out: (line: string) => void; sleep?: (ms: number) => Promise<void> }): Promise<void>`
- Flags:
  - `--type`: required, one of `linux`, `windows`, `synology`, `dropbear`.
  - `--address` and `--port` (default 22). A managed target takes the address from its host.
  - `--account`: required.
  - `--node`: required, a comma list of host ids.
  - `--identity`: a private key file, for an external target only.
  - `--managed`: the host id of a managed target.
  - `--fingerprint` and `--no-test`.
- The usage text is `usage: claude-rc ssh target add <id> --type <type> --account <user> --node <ids> (--address <host> --identity <file> | --managed <host id>) [--port <n>] [--fingerprint <f>] [--no-test]`.

- [ ] **Step 1: Write the failing tests.**
  Test names:
  - `--managed together with --identity exits 1 with the usage text`
  - `an external add without --type, --address, --account, --node or --identity exits 1 with the usage text`
  - `an unknown --type exits 1 and names linux, windows, synology and dropbear`
  - `an external add runs ssh with the identity and the provision script on stdin`
  - `the ssh call trusts only the pinned host key (StrictHostKeyChecking yes and a temporary known_hosts file)`
  - `a managed add calls the authorize route and runs no local ssh`
  - `a managed add pins through pin-managed and asks no question`
  - `with the passphrase method the command asks for the passphrase and sends it with the key route`
  - `with the passkey method the command prints the link and polls until the key exists`
  - `the command exits 1 when the key does not exist after 10 minutes`
  - `a fingerprint that differs from --fingerprint exits 1 and pins nothing`
  - `without --fingerprint the command asks, and an answer other than y exits 1 and pins nothing`
  - `a failed provision prints the ssh error text and leaves the target in draft`
  - `--no-test skips the test route`
  - `the identity path and the key text never appear in a request body to the hub`
- [ ] **Step 2: Run** `bun test cli/test/sshtarget.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the command with the five steps of "Add a target from the command line" in the spec. For an external target, take the script from `GET /cli/api/ssh/targets/:id/provision`. Run `ssh -i <identity> -o IdentitiesOnly=yes -o UserKnownHostsFile=<temporary file> -o StrictHostKeyChecking=yes -p <port> <account>@<address> <command>`. The command is `sh -s` for the `sh` shell and `powershell -NoProfile -NonInteractive -Command -` for `powershell`. Do not set `BatchMode`, so that `ssh` can ask for a key passphrase. Delete the temporary file at the end.
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `feat: claude-rc ssh target add`.

### Task 14: Instance opt-in

**Files:**
- Modify: `server/src/instancesettings.ts` (field `sshRequests`), `server/src/unit.ts` (`renderUnit`, `parseUnitSettings`), `server/src/instances.ts` (patch handling), `server/src/nodemain.ts` (create `SshControl` sockets for opted-in instances)
- Test: `server/test/instancesettings.test.ts`, `server/test/unit.test.ts`

**Interfaces:**
- `InstanceSettings` gets `sshRequests: boolean`, default `false`. `SettingsPatch` accepts it. `SETTINGS_HELP` gets an entry with the label `Allow SSH requests`.
- When `sshRequests` is true, `renderUnit` adds `Environment="CLAUDE_RC_SSH_CONTROL=/run/claude-rc-ssh/<instance id>/control.sock"`. `parseUnitSettings` sets the field from that line.

- [ ] **Step 1: Write the failing tests.**
  Test names:
  - `default settings have sshRequests false`
  - `renderUnit adds the CLAUDE_RC_SSH_CONTROL line only when sshRequests is true`
  - `parseUnitSettings reads sshRequests from that line`
  - `a unit from before this change parses as false`
  - `a patch with sshRequests true restarts the instance`
- [ ] **Step 2: Run** `bun test server/test/instancesettings.test.ts server/test/unit.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the setting. In `nodemain.ts`, create the folder `/run/claude-rc-ssh` with mode 755. For each opted-in instance, create a subfolder with mode 700, owned by the instance user, and one `SshControl`. If the instance opts out, stop its control.
- [ ] **Step 4: Run** `bun test server`. Expect PASS.
- [ ] **Step 5: Commit** `feat: per-instance SSH opt-in`.

---

## Phase D: web UI

### Task 15: Passkey helper

**Files:**
- Create: `web/src/lib/features/ssh/prf.ts`
- Test: `web/src/lib/features/ssh/prf.test.ts`

**Interfaces:**
- Produces:
  - `registerPasskey(options: { rpId?: string }): Promise<{ credentialId: string; prf: boolean }>` (`rpId` defaults to `location.hostname`. `credentialId` is base64url)
  - `unlockWithPasskey(credentialId: string, salt: string): Promise<string>` (returns the PRF secret in base64url. `salt` is base64url)
  - `class UnlockError extends Error`

- [ ] **Step 1: Write the failing tests** with a fake `navigator.credentials`.
  Test names:
  - `registerPasskey asks for the prf extension and reports prf true when enabled`
  - `registerPasskey reports prf false when the extension result is missing`
  - `unlockWithPasskey passes the salt as eval.first and returns the first result`
  - `unlockWithPasskey throws UnlockError with the text "This passkey does not return a PRF secret" when no result`
  - `unlockWithPasskey maps NotAllowedError to UnlockError "The passkey prompt was cancelled"`
- [ ] **Step 2: Run** `bun run --cwd web test -- prf`. Expect FAIL.
- [ ] **Step 3: Implement** using the calls from the spike: `userVerification: "required"`, `extensions: { prf: { eval: { first: salt } } }`.
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `feat(web): passkey PRF helper`.

### Task 16: SSH feature API and setup page

**Files:**
- Create: `web/src/lib/features/ssh/api.ts`, `queries.ts`, `mutations.ts`, `index.ts`, `SetupForm.svelte`, `web/src/routes/ssh/+page.svelte`
- Modify: the menu in `web/src/lib/shell/MenuSheet.svelte` (link `SSH access`, shown to `admin` only)
- Test: `web/src/lib/features/ssh/api.test.ts`, `SetupForm.test.ts`

**Interfaces:**
- Produces: functions in `api.ts` with one function for each route of Task 12, typed with the same field names. Follow the shape of `web/src/lib/features/permissions/api.ts` and its `queries.ts` and `mutations.ts`.
- `SetupForm` has the three steps of "Hub setup" in the spec: choose a method, register and test the passkey, show the recovery code once and ask for part of it back.

- [ ] **Step 1: Write the failing tests.**
  In `api.test.ts`:
  - `each function calls its route with the right method and path`

  In `SetupForm.test.ts`:
  - `a passkey with no PRF shows the message and offers the passphrase`
  - `the recovery code is shown once and the form asks for the first group back`
  - `the form refuses to finish until the group matches`
- [ ] **Step 2: Run** `bun run --cwd web test -- ssh`. Expect FAIL.
- [ ] **Step 3: Implement** the files above.
- [ ] **Step 4: Run.** Expect PASS. Run `bun run --cwd web lint` and `bun run --cwd web check`. Expect no errors.
- [ ] **Step 5: Commit** `feat(web): SSH access setup`.

### Task 17: Targets and node access

**Files:**
- Create: `web/src/lib/features/ssh/TargetWizard.svelte`, `TargetList.svelte`, `NodeAccessToggle.svelte`
- Modify: `web/src/routes/ssh/+page.svelte`, the node card in `web/src/lib/features/hosts/NodeList.svelte` (add `NodeAccessToggle`)
- Test: `TargetWizard.test.ts`, `TargetList.test.ts`, `NodeAccessToggle.test.ts`

**Interfaces:**
- `TargetWizard` runs the steps of "Target setup" in the spec, in this order: the form, the unlock that creates the key, the host key scan with a fingerprint compare, the install, and the test. The install step shows the line and the notes for the system type.
- The wizard asks for the unlock with `unlockWithPasskey` or a passphrase field, depending on the method from `GET /status`.
- The form offers the system types `linux`, `windows`, `synology` and `dropbear`, and a choice between an external target and a managed target. For a managed target, the wizard shows an Install on the node button and no paste step. For an external target, it shows the install line and the notes. The CLI does the install for an external target.
- The page accepts `?target=<id>`. The wizard then resumes at the first step that is not done: no key means the unlock step, no pinned host key means the pin step, and a draft state means the install and test step.

- [ ] **Step 1: Write the failing tests.**
  Test names:
  - `the wizard does not show the install line before the key exists`
  - `the wizard blocks the pin step until the admin selects "They match"`
  - `the wizard shows the notes for the chosen system type`
  - `the wizard resumes at the unlock step for a target with no key`
  - `a managed target shows Install on the node and no paste step`
  - `the type list holds linux, windows, synology and dropbear and nothing else`
  - `a failed test shows the ssh error text and keeps the target in draft`
  - `a passed test shows ready`
  - `TargetList shows state and offers Disable, Rotate and Retire`
  - `NodeAccessToggle requires a source address before it turns on`
- [ ] **Step 2: Run** `bun run --cwd web test -- ssh`. Expect FAIL.
- [ ] **Step 3: Implement** the components. Use the dialog and sheet components in `web/src/lib/ui` as `RuleSheet.svelte` does.
- [ ] **Step 4: Run** the tests, `bun run --cwd web lint` and `bun run --cwd web check`. Expect PASS.
- [ ] **Step 5: Commit** `feat(web): SSH targets and node access`.

### Task 18: Approvals, revoke and instance toggle

**Files:**
- Create: `web/src/lib/features/ssh/GrantList.svelte`, `ApproveSheet.svelte`
- Modify: `web/src/lib/features/instances/InstanceSettingsFields.svelte` (field `Allow SSH requests`), `web/src/routes/ssh/+page.svelte`
- Test: `GrantList.test.ts`, `ApproveSheet.test.ts`, and the existing `InstanceList.test.ts` (it lists the instance fields)

**Interfaces:**
- `ApproveSheet` shows the node, the instance, the target, the account, the minutes and this warning text: `This gives the full power of the account on the target. The target cannot limit it to read-only.` It shows the instance name as `claimed by the session`.
- While the page is open, the list polls every 5 seconds. Use the refetch helper that other features use. The menu shows a badge with the number of pending grants.

- [ ] **Step 1: Write the failing tests.**
  Test names:
  - `ApproveSheet shows the warning text exactly`
  - `ApproveSheet sends the unlock with the approval`
  - `a wrong unlock shows the error and the sheet stays open`
  - `GrantList shows pending before active and ended last`
  - `Revoke asks for no unlock and calls the revoke route`
  - `the menu badge shows the number of pending grants`
  - `the instance settings fields show Allow SSH requests off by default`
- [ ] **Step 2: Run** `bun run --cwd web test`. Expect FAIL on the new tests only.
- [ ] **Step 3: Implement** the components and the field.
- [ ] **Step 4: Run** `bun run --cwd web test`, `bun run --cwd web lint` and `bun run --cwd web check`. Expect PASS.
- [ ] **Step 5: Commit** `feat(web): SSH approvals and instance opt-in`.

---

## Phase E: documentation and a real run

### Task 19: Docs and an end-to-end test

**Files:**
- Create: `docs/ssh-delegation.md`, `server/test/ssh-e2e.test.ts`
- Modify: `README.md` (one feature line), `docs/security.md` (a section `SSH delegation`), `docs/web-ui.md` (the SSH access page), `docs/cli.md` (the commands `claude-rc ssh` and `claude-rc ssh target add`)

- [ ] **Step 1: Write the end-to-end test.** Name: `a session signs through the node agent while a grant is active and fails after revoke`. Start a hub and a node in process. Copy the setup from `server/test/e2e.test.ts`. Start a local `sshd` on a free port, with a temporary host key and the `authorized_keys` line from the hub. Run the grant flow through the routes. Then run `ssh -F <config> <target> true` and expect exit code 0. Revoke the grant and expect the next `ssh` to fail. If `sshd` is missing, skip the test.
- [ ] **Step 2: Run** `bun test server/test/ssh-e2e.test.ts`. Expect PASS.
- [ ] **Step 3: Write the docs** from the spec sections "Onboarding", "Design" and "Open risks". Write in the plain style of the existing pages. State that a router cannot enforce read-only access and that open SSH connections outlive a grant. In `docs/cli.md`, give one example of an external add and one of a managed add.
- [ ] **Step 4: Run** `bun run typecheck`, `bun run lint` and `bun run test`. Expect all PASS.
- [ ] **Step 5: Commit** `docs: SSH delegation`.

## Not in this plan

- Other hub-side CLI commands. The CLI only adds targets (Task 13). Every other change stays in the web UI.
- A certificate authority, Windows nodes, and ending open SSH connections.
- Push messages for pending requests. Task 18 adds a badge only.
- The Dropbear test on the router. After the build, the owner runs the target wizard against the router. The result decides the text of `installNotes("dropbear")`.

# Update all nodes from the hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The command `claude-rc update --all-nodes` updates every node, then the hub, then the local client. Each machine gets its service and its client. The command prints one result per machine.

**Architecture:** One shared module downloads a release asset and replaces a binary with a backup. A server module uses it to update the machine it runs on and exposes `GET /node` and `POST /update` on the shared host API. The hub forwards both routes to each node. The CLI runs the loop over the hosts.

**Tech Stack:** Bun, TypeScript, Hono, `bun:test`, systemd.

**Spec:** `docs/superpowers/specs/2026-11-08-update-all-nodes-design.md`

## Global Constraints

- Installed service paths: binary `/usr/local/bin/claude-rc-launcher`, unit `/etc/systemd/system/claude-rc-launcher.service`, systemd unit name `claude-rc-launcher`. System scope only.
- `release` must match `^v?\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$`. Any other value is a 400. The download base URL is the constant `https://github.com/kbirger/claude-rc-launcher/releases`. The only request value in a URL is a tag that matches this pattern.
- Assets: service `claude-rc-launcher-linux-x64` or `-arm64`, client `claude-rc-<platform>-<cpu>`, plus `SHA256SUMS` from the same release. A mismatch of the checksum installs nothing.
- Backups: `<file>.prev` next to every replaced file. The new file is written as `<file>.new` and moved into place.
- Client copies: `which claude-rc` with the service's own `PATH`, plus `~/.local/bin/claude-rc` for `service_home` of the configuration and for `/root`. Each real file is updated once. No copy found is not an error.
- Rollback watchdog: the new service must stay active for 30 seconds, otherwise the `.prev` service binary comes back and the service restarts. No process of the old service takes part.
- `POST /update` answers `202` before the restart. A second call during a run gets `409`. The hub forwards `POST /update` with a 180 second timeout.
- CLI polling: every 2 seconds, up to 90 seconds, for the version to change.
- Statuses: `updated`, `up-to-date`, `skipped (offline)`, `failed (<reason>)`, `rolled back`, `no answer`, `cannot update remotely`.
- Order: remote hosts one after the other, then the hub (`local`), then the local client. A failure never stops the run. If any machine is not `updated` or `up-to-date`, the exit code is 1.
- `--binary` with `--all-nodes` is an error. Any logged-in CLI user can run it.
- Run tests with `export PATH="$HOME/.bun/bin:$PATH"; bun test <path>`. Use `bun test ./cli` for the CLI tests. Run `bun run typecheck` at the end of every task.
- Commit steps run only after the user allows commits. Work on branch `feat/update-all-nodes`.

## Review Focus

1. A forwarded `POST /update` takes longer than 10 seconds on a slow link. Expected: the hub call uses the 180 second timeout, not the default.
2. The client is a symlink (`/usr/bin/claude-rc` to `/usr/local/bin/claude-rc`). Expected: the real file is updated once.
3. The service binary is current but a client copy is old. Expected: the client is updated, the service is not restarted, and the report says so.
4. Two `POST /update` calls at once, and a call right after a failed one. Expected: one `409`, and the lock is released after a failure.
5. A `release` such as `v1.0.0/../../x` or `latest`. Expected: `400`, and nothing is downloaded.
6. The watchdog script, run in a real shell with a fake `systemctl`. Expected: if the service never stays active, the script rolls back. If it stays active, the new binary stays.

---

## File Structure

- Create `server/src/release.ts`: shared download, checksum and replace-with-backup code.
- Create `server/src/serviceupdate.ts`: client discovery, the watchdog script and `createServiceUpdater`.
- Modify `server/src/requests.ts`: `parseUpdateRequest`.
- Modify `server/src/app.ts`: `GET /node` and `POST /update` in `instanceApi`, new `update` dependency.
- Modify `server/src/hosts.ts`: forward both routes, `version` in `HostInfo`.
- Modify `server/src/hubmain.ts` and `server/src/nodemain.ts`: build the updater from the real machine.
- Modify `cli/src/nodesetup.ts` and `cli/src/update.ts`: use the shared module.
- Create `cli/src/updateall.ts`, modify `cli/src/args.ts` and `cli/src/index.ts`.
- Modify `README.md`.

### Task 1: Shared release module

**Files:**
- Create: `server/src/release.ts`
- Test: `server/test/release.test.ts`

**Interfaces:**
- Produces:
  - `RELEASE_REPO = "kbirger/claude-rc-launcher"`, `RELEASE_TAG_RE`.
  - `type RunResult = { code: number; stdout: string; stderr: string }`.
  - `interface ReleaseIo { fetch: typeof fetch; run(args: string[], opts?: { timeoutMs?: number }): RunResult; writeTemp(name: string, data: Uint8Array): string; removeTemp(path: string): void }`. The caller decides about `sudo` inside `run`.
  - `class ReleaseError extends Error`.
  - `sha256(b: Uint8Array): string`.
  - `downloadAsset(io: Pick<ReleaseIo, "fetch">, asset: string, release?: string): Promise<Uint8Array>`.
  - `installWithBackup(io: ReleaseIo, target: string, binary: Uint8Array): void`. It runs `install -m 755 <tmp> <target>.new`, `cp -p <target> <target>.prev`, `mv -f <target>.new <target>`. On any failure it removes `<target>.new` and throws `ReleaseError`.
  - `restorePrevious(io: ReleaseIo, target: string): boolean`. It runs `mv -f <target>.prev <target>` and returns whether that worked.

- [ ] **Step 1: Write the failing tests** in `server/test/release.test.ts`. Use a fake `fetch` and a recording fake `run`. Tests:
  - `downloadAsset fetches <base>/<asset> and <base>/SHA256SUMS` for `latest/download` and for `download/<tag>`.
  - `downloadAsset throws ReleaseError when the checksum does not match` with the message `the checksum of <asset> does not match SHA256SUMS. Nothing was installed`.
  - `downloadAsset throws ReleaseError for HTTP 404` with `cannot download <url>: HTTP 404`.
  - `downloadAsset rejects a release that does not match RELEASE_TAG_RE` before any request.
  - `installWithBackup runs install, cp -p, mv in that order` and returns normally.
  - `installWithBackup removes <target>.new and throws when install fails`, with the message `installing the binary failed (install exit 1): <stderr>`.
  - `installWithBackup leaves .prev alone when the first step fails`.
  - `restorePrevious returns false when mv fails`.
- [ ] **Step 2: Run** `bun test server/test/release.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `server/src/release.ts` with the interfaces above. Copy the exact error texts from `obtainBinary` and `get` in `cli/src/nodesetup.ts` and from the `step` helper in `cli/src/update.ts`. The module imports only `node:` modules.
- [ ] **Step 4: Run** the test file. Expected: PASS. Run `bun run typecheck`.
- [ ] **Step 5: Commit** `feat: shared release download and replace code`.

### Task 2: The CLI uses the shared module

**Files:**
- Modify: `cli/src/nodesetup.ts` (`obtainBinary`, `get`, `nodeUpdate`), `cli/src/update.ts` (`selfUpdate`)
- Test: `cli/test/nodeupdate.test.ts`, `cli/test/selfupdate.test.ts`, `cli/test/nodesetup.test.ts` (existing, must stay green)

**Interfaces:**
- Consumes: `downloadAsset`, `installWithBackup`, `restorePrevious`, `ReleaseError`, `ReleaseIo` from Task 1.
- Produces: `obtainBinary(sys, flags, asset, out)` keeps its signature and messages. It reads `--binary` itself and calls `downloadAsset` for a release. A `ReleaseError` becomes `ExitError(message, 1)`.

- [ ] **Step 1: Run** `bun test ./cli --timeout 60000` and write down the result. Expected: all pass. This is the baseline.
- [ ] **Step 2: Refactor.** Remove the local `get`, the checksum code and the `install`/`cp`/`mv` sequences. Build a `ReleaseIo` from `Sys` in each caller: `run` is `sys.sudo` for `nodeUpdate`, and the plain-or-sudo choice for `selfUpdate`. Keep the health check and rollback decisions in the callers.
- [ ] **Step 3: Run** `bun test ./cli --timeout 60000` and `bun run typecheck`. Expected: the same results as the baseline. No test file changes except imports.
- [ ] **Step 4: Run** `grep -n "SHA256SUMS\|install -m\|\.prev" cli/src/*.ts`. Expected: no remaining copy of the download or replace sequence.
- [ ] **Step 5: Commit** `refactor(cli): update commands use the shared release code`.

### Task 3: Service updater

**Files:**
- Create: `server/src/serviceupdate.ts`
- Test: `server/test/serviceupdate.test.ts`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces:
  - `type ClientResult = { path: string; status: "updated" | "up-to-date" | "failed"; from?: string; to?: string; error?: string }`.
  - `type UpdateReport = { status: "restarting" | "up-to-date" | "clients-only" | "failed"; from: string; to?: string; clients: ClientResult[]; error?: string }`.
  - `interface UpdateEnv extends ReleaseIo { platform: string; arch: string; execPath: string; version: string; scope: "system" | "user"; exists(p: string): boolean; readFile(p: string): Uint8Array; realpath(p: string): string; pathEnv: string; homes: string[]; startWatchdog(script: string): void }`.
  - `class UpdateRefused extends Error { status: 409 | 400 }`.
  - `findClients(o: { pathEnv: string; homes: string[]; exists(p: string): boolean; realpath(p: string): string }): string[]`.
  - `watchdogScript(o: { bin: string; unit: string; waitSeconds: number }): string`.
  - `createServiceUpdater(env: UpdateEnv): { run(release?: string): Promise<UpdateReport> }`.

- [ ] **Step 1: Write the failing tests.** Use a fake `UpdateEnv` with an in-memory file map and recorded `run` calls.
  - `findClients` finds a copy on `PATH`, a copy in a home `~/.local/bin`, no copy, and two different copies.
  - `findClients` returns one entry for a symlink pair (Review Focus 2).
  - `run` refuses with 409 in each of these cases:
    - `execPath` is not `/usr/local/bin/claude-rc-launcher`
    - `scope` is `user`
    - the unit file is missing
    - `platform` is not `linux`
  - `run` rejects a release that does not match `RELEASE_TAG_RE` before any download (Review Focus 5).
  - `run` with a new service binary: downloads, replaces with backup, updates clients first, returns `restarting`, and calls `startWatchdog` once with the script.
  - `run` with the same service binary and an old client: returns `clients-only`, does not call `startWatchdog` (Review Focus 3).
  - `run` with everything current returns `up-to-date`.
  - A client whose new file fails `--version` is restored and reported `failed`, and the service is still updated.
  - A second `run` during the first gets `UpdateRefused` 409, and a call after a failed run works (Review Focus 4).
  - `watchdogScript` in a real shell (`sh`) with a temp directory, a fake `systemctl` and a fake `mv`-able binary (Review Focus 6): a service that never stays active ends with the `.prev` file back in place and a second `restart`. A service that stays active leaves the new file.
- [ ] **Step 2: Run** `bun test server/test/serviceupdate.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces. `run` does the steps of the spec section "What each machine does" in order. Client copies are replaced before the service. A client `--version` smoke test uses `env.run([path, "--version"])`. The watchdog script restarts the unit after a short delay, polls `systemctl is-active` for `waitSeconds`, and moves `<bin>.prev` back on failure. `startWatchdog` is given the script text. The real environment starts it with `systemd-run --collect --unit claude-rc-update-<time> /bin/sh -c <script>`.
- [ ] **Step 4: Run** the test file. Expected: PASS. Run `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(server): update this machine from a release`.

### Task 4: Routes, forwarding and wiring

**Files:**
- Modify: `server/src/requests.ts`, `server/src/app.ts`, `server/src/hosts.ts`, `server/src/hubmain.ts`, `server/src/nodemain.ts`
- Create: `server/src/realupdate.ts` (builds the real `UpdateEnv`)
- Test: `server/test/requests.test.ts`, `server/test/hosts.test.ts`, `server/test/app.test.ts`, `server/test/e2e.test.ts`

**Interfaces:**
- Consumes: `createServiceUpdater`, `UpdateReport` from Task 3.
- Produces:
  - `parseUpdateRequest(body: unknown): { release?: string }` in `requests.ts`. A non-object is 400 `body must be an object`. A bad `release` is 400 `release must be a version tag such as v1.2.3`.
  - `InstanceApiDeps` gets `update?: { run(release?: string): Promise<UpdateReport> }`.
  - `instanceApi` serves `GET /node` returning `{ ok: true, name, version }` (version from `server/src/version.ts`) and `POST /update`. Without `update`, `POST /update` answers `501` with `update is not available on this host`. `createNodeApp` no longer defines its own `/node`.
  - `HostInfo` gets `version?: string`. The list route fills it from the probe body.
  - The hub forwards `GET /:host/node` and `POST /:host/update` for remote hosts. The `POST` call uses `timeoutMs: 180_000`.
  - `createApp` and `createNodeApp` take `update`, and the mains pass `createServiceUpdater(realUpdateEnv(cfg))`.

- [ ] **Step 1: Write the failing tests.**
  - `requests.test.ts`: `parseUpdateRequest` accepts `{}` and `{ release: "v1.2.3" }`, rejects `[]`, `{ release: 5 }`, `{ release: "latest" }`, `{ release: "v1.0.0/../../x" }`.
  - `hosts.test.ts` covers these cases:
    - the host list carries `version` for `local` and for a node
    - `GET /api/hosts/nas/node` and `GET /api/hosts/local/node` return the version
    - `POST .../update` reaches the node updater with the accepted body only, and an unknown field is dropped
    - a bad release gets the same 400 from `local` and from a remote host
    - the remote call uses `timeoutMs: 180_000` (Review Focus 1)
    - an older node that answers 404 gives a 404 through the hub
    - the audit line is logged
  - `app.test.ts`: `POST /update` without an updater is 501.
  - `e2e.test.ts`: a real hub and a real node over TLS, each with a fake updater that records its release. `POST /cli/api/hosts/<node>/update` reaches the node updater through the Hub-Proof path.
- [ ] **Step 2: Run** the four files. Expected: FAIL.
- [ ] **Step 3: Implement.** `realUpdateEnv(cfg)` in `realupdate.ts` fills `UpdateEnv` from `process`, `node:fs`, `Bun.spawnSync` and the configuration: `homes` is `[cfg.serviceHome, "/root"]`, `pathEnv` is `process.env.PATH`, `scope` is `cfg.scope`. Keep this file free of logic that needs a test beyond a smoke test of its field types.
- [ ] **Step 4: Run** the four files, then `bun test server --timeout 60000`. Expected: PASS apart from the known sandbox failure `mkdir owner > dirOwner is forwarded to makeDir` (chown EPERM). Run `bun run typecheck`.
- [ ] **Step 5: Commit** `feat: update routes on every host, forwarded by the hub`.

### Task 5: The CLI command

**Files:**
- Create: `cli/src/updateall.ts`
- Modify: `cli/src/args.ts` (`"all-nodes"` boolean flag), `cli/src/index.ts` (the `update` branch and the help text)
- Test: `cli/test/updateall.test.ts`, `cli/test/commands.test.ts` (flag parsing), existing `cli/test/selfupdate.test.ts`

**Interfaces:**
- Consumes: `HubClient` from `cli/src/hub.ts`, `selfUpdate` from `cli/src/update.ts`, `table` from `cli/src/format.ts`.
- Produces: `updateAll(o: { flags: Flags; hub: HubClient; out: (s: string) => void; sys?: Sys }): Promise<void>`. It prints the table. If any row is not `updated` or `up-to-date`, it then throws `ExitError("<n> of <m> machines were not updated", 1)`.

- [ ] **Step 1: Write the failing tests** in `cli/test/updateall.test.ts` with a fake `HubClient` and a fake `Sys` clock (`sleep` advances `now`). Tests:
  - all machines updated. The calls go to remote hosts in list order, then `local`, then the local client. The table has one row per machine with before and after versions.
  - one host is `offline` in the list. It is skipped and the others still run.
  - `POST .../update` answers 404. The row says `cannot update remotely` and names `claude-rc node update`.
  - `POST .../update` fails with another error: `failed (<message>)`, the others still run.
  - the version never changes within 90 seconds: `no answer`. Use the fake clock.
  - the version is unchanged after a restart report: `rolled back`.
  - the node answers `up-to-date`. There is no polling.
  - the node answers `clients-only`. There is no polling, and the row says `updated` with the client paths.
  - the hub (`local`) is updated after every remote host.
  - the exit code. Any failed row gives `ExitError` with code 1, and all good rows give none.
  - `--binary` with `--all-nodes` is an error before any request. `--release v1.2.3` is passed to every machine.
  - a second run in which all report `up-to-date` succeeds.
  - `index.ts`: `update --all-nodes` without a login gives the login message (exit 2). `update` without `--all-nodes` still needs no login.
- [ ] **Step 2: Run** `bun test ./cli/test/updateall.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `updateAll` and the wiring. If `flags["all-nodes"]` is set, the `update` branch in `index.ts` calls `updateAll` once the hub client exists. The help text lists `update [--release tag] [--all-nodes]`.
- [ ] **Step 4: Run** `bun test ./cli --timeout 60000` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): update --all-nodes`.

### Task 6: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document** these points in the README, in sentences of at most 25 words with no semicolons or contractions:
  - the command, its output and its exit code
  - the order: nodes, then the hub, then the local client
  - the statuses
  - the client discovery rule
  - the four limits from the spec section "Limits to document in the README"
- [ ] **Step 2: Run** `bun run typecheck && bun test server web/src ./cli --timeout 60000`. Expected: PASS apart from the known sandbox failure.
- [ ] **Step 3: Commit** `docs: update --all-nodes`.

---

## Self-review

- Spec coverage:
  - per-machine steps: Tasks 1 and 3
  - routes and forwarding: Task 4
  - CLI command and statuses: Task 5
  - shared code with the existing commands: Task 2
  - README limits: Task 6
  - tests listed in the spec: spread over Tasks 1 to 5
- Non-goals have no task on purpose: no schedule, no `--binary` push, no `--host`, no user scope, no web UI.
- Types: `ReleaseIo`, `UpdateEnv`, `UpdateReport` and `ClientResult` are each defined once and used by name in later tasks.

# Restricted Windows Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a Windows node whose service account is an administrator, a session runs with a restricted token by default, and the user dropdown offers `<user>` and `<user> (admin)`.

**Architecture:** A new module `server/src/win/token.ts` builds the restricted token and starts a process with it, through `bun:ffi`. `WinInstances` picks the spawner by the chosen entry, stores the choice in the state file and lists two users. `index.win.ts` wires the pieces. Task order follows the dependency: token module, instance backend, wiring and docs.

**Tech Stack:** Bun, TypeScript, `bun:ffi`, `bun test`. The token tests run only on Windows (the CI `windows` job).

**Spec:** `docs/superpowers/specs/2026-11-10-restricted-sessions-design.md` (findings in `spikes/win-token/FINDINGS.md` on branch `spike/win-token`, files `spike2.ts` and `spike3.ts` hold working FFI code to copy from: `git show origin/spike/win-token:spikes/win-token/spike2.ts`)

## Global Constraints

- Windows only. No helper program and no new dependency. `token.ts` must import safely on Linux: call `dlopen` inside functions only.
- The restricted token: `CreateRestrictedToken(own, LUA_TOKEN | DISABLE_MAX_PRIVILEGE)`, then `SetTokenInformation` for `TokenDefaultDacl` (user and SYSTEM `GENERIC_ALL`) and `TokenOwner` (the user), then `TokenIntegrityLevel` `S-1-16-8192`, then `CreateProcessAsUserW`. All four are required (see the spike findings).
- The two entries: `<user>` (restricted, the default) and `<user> (admin)` (exactly one space before the parenthesis). `GET /users` lists both with `selectable: true` only when the service token has the Administrators group enabled. Otherwise it returns today's single entry with `selectable: false`.
- No fallback to the full token: a failed token step never starts the process.
- A saved session without `admin: true` restores restricted (on an administrator service).
- Run `bun test server web/src ./cli`, `bun run typecheck` and `bun run --cwd web check` from the repo root. Known sandbox-only failures: slow `install-binary.sh` tests.

## Review Focus

- A restricted child must never hold Administrators enabled, High integrity or more than `SeChangeNotifyPrivilege` (a Windows CI test asserts it).
- Any `user` value other than the bare user and `<user> (admin)`, for example `<user>(admin)`, `<USER> (ADMIN)` or `<user> (admin) `, must be a 400.
- A standard service account must see one entry and start as today, with no token work.
- Stopping a restricted session must end it and its children (`taskkill /T`), and handles must be closed so that restarts do not leak them.
- The "folder not trusted" 428 retry, in the web and in the CLI, must keep the chosen entry.

---

### Task 1: The token module

**Files:**
- Create: `server/src/win/token.ts`
- Test: `server/test/win-token.test.ts`

**Interfaces:**
- Consumes: `Spawned` and `WinDeps["spawn"]` from `server/src/win/instances.ts` (same signature as `bunSpawn()`: `(cmd: string, args: string[], o: { cwd: string; logFile: string }) => Spawned`).
- Produces:
  - `export class RestrictedTokenError extends Error` (a token step failed: permanent, retrying cannot help).
  - `export function serviceIsAdmin(): boolean` is true when the Administrators group is enabled in this process's token (`CheckTokenMembership`). It returns `false` on any failure and on non-Windows.
  - `export function restrictedSpawn(): WinDeps["spawn"]` builds a restricted token per call, starts the process with it with output appended to `logFile`, closes every handle it opened, and returns `{ pid, exited }`. A failed token step throws `RestrictedTokenError`. A failed `CreateProcessAsUserW` (for example the file is missing) throws a plain `Error` with the Win32 error code.

- [ ] **Step 1: Write the failing tests** (`describe.skipIf(process.platform !== "win32")`): `serviceIsAdmin()` is a boolean. A child started with `restrictedSpawn()` that runs `cmd.exe /c whoami /groups & whoami /priv` writes to the log file: `BUILTIN\Administrators` with `Group used for deny only` (only when `serviceIsAdmin()` is true; skip the group assertion otherwise), a `Medium Mandatory Level` line, and exactly one privilege line `SeChangeNotifyPrivilege`. `whoami /groups` itself succeeds (the default DACL step). A missing program throws a plain `Error`, not `RestrictedTokenError`. `exited` resolves with the exit code of `cmd.exe /c exit 7` (7). After the child ends, handles are closed (call 200 times and check the process handle count with `Get-Process -Id $PID | Select HandleCount` stays within +100). A test that runs on every platform: importing `token.ts` on Linux does not throw.
- [ ] **Step 2: Run** `bun test server/test/win-token.test.ts`. Expected: FAIL (module not found) on Linux the import test fails, the others skip.
- [ ] **Step 3: Implement** `token.ts` from the spike code. How the child's output reaches `logFile` (inheritable handles with `STARTF_USESTDHANDLES`) and how `exited` learns of the exit (poll `GetExitCodeProcess` about every 250 ms and treat `STILL_ACTIVE` 259 as running) are the builder's choice. Use `CREATE_UNICODE_ENVIRONMENT`, `CREATE_NO_WINDOW` and an environment block from `CreateEnvironmentBlock` of the restricted token.
- [ ] **Step 4: Run** the same command and `bun run typecheck`. On Linux the Windows tests skip and the import test passes. State in the report that the Windows tests ran only in CI (push the branch and read the CI `windows` job result before reporting DONE, if the controller allows pushing; otherwise say they did not run).
- [ ] **Step 5: Commit** `feat(windows): start a process with a restricted copy of the service token`.

### Task 2: The instance backend

**Files:**
- Modify: `server/src/win/instances.ts`
- Test: `server/test/win-instances.test.ts`

**Interfaces:**
- Consumes: `RestrictedTokenError` (Task 1).
- Produces:
  - `WinInstanceOptions` gains `serviceIsAdmin?: boolean` (default `false`).
  - `WinDeps` gains `spawnRestricted?: WinDeps["spawn"]`. When `serviceIsAdmin` is true, the restricted entry uses `spawnRestricted` (required then; the constructor throws if it is missing). The `(admin)` entry and a standard service use `spawn`.
  - `users()` returns, for an administrator service, `{ selectable: true, default: serviceUser, users: [{ name: serviceUser }, { name: serviceUser + " (admin)" }] }`, else today's answer.
  - `checkUser(user)` accepts `undefined`, `serviceUser` and (only for an administrator service) exactly `serviceUser + " (admin)"`. It is used by every endpoint that takes `user`, as today.
  - `Instance.user` is set (to the entry) only for an administrator service. `Entry` gains `admin: boolean`.
  - `instances.json` entries gain optional `admin: true`. `restore()` reads it, and an entry without it restores restricted.
  - The 428 `untrusted` payload carries `user` = the chosen entry (the bare `serviceUser` for the default).
  - A `RestrictedTokenError` from a spawn is permanent: `start()` answers 500 `failed to start claude: <message>` as for any start failure, and `supervise` sets the state to `failed`, logs the cause once and stops retrying that instance (the entry stays in the list and in the state file).

- [ ] **Step 1: Write the failing tests** (fake `spawn` and `spawnRestricted`, as the file's `make()` does): administrator service: `users()` has two entries, default first; `start({ user: undefined })` and `start({ user: "svc" })` call `spawnRestricted`, `start({ user: "svc (admin)" })` calls `spawn`; `Instance.user` is `svc` and `svc (admin)`; every wrong value (`"svc(admin)"`, `"SVC (ADMIN)"`, `"svc (admin) "`, `"other"`) is 400 from `start`, `dirOwnerFor` and `trustFilter`. Standard service: one entry, `selectable: false`, `Instance.user` unset, `start({ user: "svc (admin)" })` is 400, `spawnRestricted` never called, no constructor error without `spawnRestricted`. State file: `admin: true` round-trips through `persist` and `restore`; a file without the field restores through `spawnRestricted`. 428: for `svc (admin)` the payload `user` is `svc (admin)`. A `RestrictedTokenError` from `spawnRestricted`: `start()` is 500 and nothing is listed or saved; a restored instance goes to `failed`, `spawnRestricted` is called once (not every 10 s: advance the fake `sleep` several times), and the error is logged once.
- [ ] **Step 2: Run** `bun test server/test/win-instances.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as described. Keep one `spawnFor(entry)` that chooses the spawner.
- [ ] **Step 4: Run** the file, `bun test server` and `bun run typecheck`. Expected: PASS (known failures excepted).
- [ ] **Step 5: Commit** `feat(windows): restricted sessions by default, an (admin) entry per session`.

### Task 3: Wiring, the retry paths and docs

**Files:**
- Modify: `server/src/index.win.ts`, `README.md`
- Check, and fix only if it drops the entry: `cli/src/commands.ts` (the 428 retry hint), `web/src/lib/trustprompt.ts`
- Test: `server/test/win-instances.test.ts` or a new `server/test/win-wiring.test.ts` as fits; `cli/test/*` and `web/src/lib/trustprompt.test.ts` for any fix

**Interfaces:**
- Consumes: `serviceIsAdmin`, `restrictedSpawn` (Task 1); `WinInstanceOptions.serviceIsAdmin`, `WinDeps.spawnRestricted` (Task 2).
- Produces: no code interface.

- [ ] **Step 1: Write the failing tests**: if the web or CLI drops the entry on the trust retry, a test that the retry sends the 428 payload's `user` unchanged (`trustStartArgs` already uses `prompt.user`: add a test with `svc (admin)`, and a CLI test that the printed `--force` hint keeps `--user 'svc (admin)'` quoted).
- [ ] **Step 2: Run** `bun test web/src ./cli`. Expected: FAIL only where a fix is needed.
- [ ] **Step 3: Implement** the wiring in `index.win.ts`: compute `const admin = serviceIsAdmin()` once at start, pass `serviceIsAdmin: admin` and `{ spawnRestricted: restrictedSpawn() }` (only when `admin`), and log one line at start: `sessions run restricted by default (service account is an administrator)` or `sessions run as the service account (no administrator rights to drop)`. Update the README Windows section: the two entries, what restricted means (one privilege, Administrators deny-only, Medium), the cost (access that only the Administrators group gave is gone), that saved sessions of an administrator service restart restricted after this release, and that `(admin)` keeps today's behavior. README style: short sentences, no contractions, no em-dashes, no semicolons.
- [ ] **Step 4: Run** `bun test server web/src ./cli`, `bun run typecheck` and `bun run --cwd web check`. Expected: PASS (known failures excepted).
- [ ] **Step 5: Commit** `feat(windows): wire restricted sessions and document them`.

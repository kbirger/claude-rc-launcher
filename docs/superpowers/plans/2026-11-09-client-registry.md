# Client Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A node reports the client versions that its installers recorded in a root-owned file, and a Windows node finds its client without that file. The UI tells "no client" from "client not reported".

**Architecture:** A small reader (`server/src/installs.ts`) parses a text registry and enforces a trust rule. `findClients` returns registered paths first and then a platform-aware scan. The hub adds `noClient` to host entries. Two installers write the registry. The web labels use the new field.

**Tech Stack:** Bun, TypeScript, POSIX sh, PowerShell, Svelte 5, `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-09-client-registry-design.md` (extends `2026-11-09-web-version-check-design.md`)

## Global Constraints

- Registry file: Linux `/etc/claude-rc-launcher/installs`, Windows `%ProgramData%\claude-rc-launcher\installs`. Plain text, one entry per line: `client <absolute path>`. Blank lines and lines that start with `#` are ignored. Unknown line kinds are ignored.
- Trust rule on Linux: read the file only if it is owned by uid 0 and `mode & 0o022 === 0`, and its directory passes the same check. Otherwise ignore the whole file and log one line that names the file and the reason. On Windows the installer sets the ACL (Administrators and SYSTEM full control, Users read only, inheritance off). The node does not check an ACL.
- Entries must be absolute paths of a file named `claude-rc` (Linux) or `claude-rc.exe` (Windows, any letter case). Anything else is ignored.
- `findClients` returns registered paths first, then scanned paths, each real file once. Windows scan: split PATH on `;`, look for `claude-rc.exe`, and also `%ProgramFiles%\claude-rc\claude-rc.exe`. Linux scan: unchanged.
- A broken, missing or untrusted registry never stops the service or the host list.
- The registry lists client copies only. The Windows updater never updates a client. `claude-rc update` and `claude-rc node update` write no registry line.
- `GET /node` keeps `clients: { path, version? }[]`. A node that omits the field is old. The hub sets `noClient: true` only for an empty array. UI labels: the version, else "no client" when `noClient`, else "client not reported".
- Tests need no real `/etc`, no real ProgramData and no root. Run `bun test server web/src ./cli` and `bun run typecheck` from the repo root and `bun run --cwd web check`.

## Review Focus

- A registry file that a user without administrator rights can write must be ignored (group-writable, world-writable, wrong owner, writable directory).
- A registry entry that points outside a client file name (a directory, a different file name, a relative path, a path with `..`) must never be run or returned.
- An old node (no `clients` field) must show "client not reported", never "no client".
- Running an installer twice must not add a second line.
- A Windows path with spaces (`C:\Program Files\claude-rc\claude-rc.exe`) must work through the whole lookup.

---

### Task 1: Registry reader

**Files:**
- Create: `server/src/installs.ts`
- Test: `server/test/installs.test.ts`

**Interfaces:**
- Produces:
  - `registryPath(platform: string, env: Record<string, string | undefined>): string` returns `/etc/claude-rc-launcher/installs` for any platform except `win32`, and `<ProgramData>\claude-rc-launcher\installs` for `win32` (ProgramData from `env.ProgramData`, default `C:\ProgramData`).
  - `type RegistryIo = { platform: string; env: Record<string, string | undefined>; readFile(p: string): string; stat(p: string): { uid: number; mode: number } | undefined }`
  - `readRegisteredClients(io: RegistryIo, log?: (line: string) => void): string[]` returns the valid client paths in file order, or `[]`. It never throws: a read error other than "missing" is logged and gives `[]`.

- [ ] **Step 1: Write the failing tests** in `installs.test.ts` with a fake `RegistryIo`: a root-owned 0644 file with two valid lines gives both paths in order. Mode `0o664` and mode `0o666` give `[]` and one log line that names the file. Owner uid 1000 gives `[]` and a log line. A directory with mode `0o777` gives `[]`. A missing file gives `[]` and no log line. Comments, blank lines and `tool /x` lines are ignored. A relative path, `client /usr/bin/other`, `client /a/../b/claude-rc` and `client /usr/local/bin/` are ignored. On `win32` (no owner or mode check) `client C:\Program Files\claude-rc\claude-rc.exe` is accepted and `client C:\x\CLAUDE-RC.EXE` is accepted (letter case) and `client C:\x\claude-rc` is ignored. A read error gives `[]` and a log line.
- [ ] **Step 2: Run** `bun test server/test/installs.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `installs.ts` as specified. Use `path.posix` and `path.win32` for the absolute-path and file-name checks, and reject any path segment equal to `..`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): read the client registry with a trust check`.

### Task 2: Use the registry in the client lookup, and report `noClient`

**Files:**
- Modify: `server/src/serviceupdate.ts` (`findClients`, `UpdateEnv`, callers)
- Modify: `server/src/realupdate.ts` (`realUpdateEnv`)
- Modify: `server/src/hosts.ts` (`HostInfo`, the host list handler)
- Test: `server/test/serviceupdate.test.ts`, `server/test/realupdate.test.ts`, `server/test/hosts.test.ts`

**Interfaces:**
- Consumes: `readRegisteredClients`, `registryPath` (Task 1).
- Produces:
  - `findClients(o: { pathEnv: string; homes: string[]; exists(p: string): boolean; realpath(p: string): string; platform?: string; programFiles?: string; registered?: string[] }): string[]`. It keeps today's behavior when the three new fields are missing. `UpdateEnv` extends this input type, so `findClients(env)` still compiles; `UpdateEnv` gains `registeredClients?(): string[]` and `programFiles?: string`.
  - Every call of `findClients(env)` passes `registered: env.registeredClients?.() ?? []` (a small helper in `serviceupdate.ts` is fine, so there is one place).
  - `realUpdateEnv` sets `registeredClients` to `() => readRegisteredClients({ platform: process.platform, env: process.env, readFile: (p) => readFileSync(p, "utf8"), stat: ... }, console.warn)` and `programFiles` from `process.env.ProgramFiles`.
  - `HostInfo` gains `noClient?: true`, set in the host list handler (for `local` and for nodes) exactly when the machine's `/node` body has `clients` as an empty array.

- [ ] **Step 1: Write the failing tests.** `serviceupdate.test.ts`: registered paths come first, then scanned paths, each real file once (a registered path that is also on PATH appears once). Windows: `pathEnv: "C:\\Windows;C:\\tools"` with `claude-rc.exe` in `C:\tools` is found by `;` split. `programFiles: "C:\\Program Files"` finds `C:\Program Files\claude-rc\claude-rc.exe` with no PATH entry. A Linux call with `platform` missing behaves as before (existing tests stay green). `createClientVersions` over a registry with a path that has spaces returns its version (fake `runAsync`). `realupdate.test.ts`: `realUpdateEnv(...).registeredClients` returns `[]` when the registry file is missing. `hosts.test.ts`: a node answering `clients: []` gives `noClient: true`; a node with no `clients` field gives no `noClient`; a node whose client has no version gives no `noClient`; the `local` entry follows the same rule.
- [ ] **Step 2: Run** `bun test server/test/serviceupdate.test.ts server/test/realupdate.test.ts server/test/hosts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it as specified. Keep one implementation of the lookup.
- [ ] **Step 4: Run** the three files, `bun test server` and `bun run typecheck`. Expected: PASS (known sandbox-only failures excepted: the slow `install-binary.sh` tests).
- [ ] **Step 5: Commit** `feat(server): find clients from the registry and on Windows, report noClient`.

### Task 3: Installers write the registry

**Files:**
- Modify: `install-cli.sh`
- Modify: `deploy/windows/install.ps1`
- Test: `cli/test/install-cli.test.ts`, `server/test/win-install.test.ts` (extend the existing tests; read both first to see how they fake `sudo`, directories and PowerShell)

**Interfaces:**
- Consumes: the file format and trust rule in Global Constraints.
- Produces: no code interface.

- [ ] **Step 1: Write the failing tests.** `install-cli.test.ts`: with a fake `sudo` that runs the command and a temp directory standing in for `/etc/claude-rc-launcher` (add an environment variable `CLAUDE_RC_REGISTRY_DIR` that defaults to `/etc/claude-rc-launcher`, so the test can redirect it), a run that installs through `sudo` creates the file with the line `client <DIR>/claude-rc`, mode 0644, and the directory with mode 0755. A second run adds no second line. A run where the install directory is writable by a non-root user and no `sudo` is used writes nothing. `win-install.test.ts`: follow what the existing tests assert about `install.ps1` (read it first; if it tests by text checks of the script, add checks that the script contains the `icacls` call with Administrators and SYSTEM full control, Users read only, `/inheritance:r`, the folder `claude-rc-launcher` under `%ProgramData%`, the line `client <ClientDir>\claude-rc.exe`, an idempotence check before it appends, and that `-NoClient` skips all of it).
- [ ] **Step 2: Run** `bun test ./cli server/test/win-install.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the registry write in `install-cli.sh` after the install. It runs only when the install used `sudo` or when the user is root. It creates the directory and file when missing, sets owner root and the modes, and appends the line once (a `grep -Fxq` check). Implement the Windows part in `install.ps1` right after the client install: create `%ProgramData%\claude-rc-launcher`, apply the ACL with `icacls`, create or append the file once (a case-insensitive exact-line check), and skip all of it for `-NoClient`.
- [ ] **Step 4: Run** the same command. Expected: PASS. Run `sh -n install-cli.sh` for a syntax check. PowerShell cannot run here: state that in the commit message body.
- [ ] **Step 5: Commit** `feat: record the installed client in a root-owned registry`.

### Task 4: Web labels and documentation

**Files:**
- Modify: `web/src/lib/api.ts` (`HostInfo` gains `noClient?: boolean`)
- Modify: `web/src/lib/HostPicker.svelte`, `web/src/lib/HubVersionLine.svelte`
- Create: `web/src/lib/clientlabel.ts` and `web/src/lib/clientlabel.test.ts`
- Modify: `README.md`

**Interfaces:**
- Produces: `clientLabel(h: Pick<HostInfo, "clientVersion" | "noClient">): string` returns the `clientVersion` when present, else "no client" when `noClient`, else "client not reported". Both components use it, so there is one wording.

- [ ] **Step 1: Write the failing tests** in `clientlabel.test.ts`: `{ clientVersion: "0.8.4" }` gives `"0.8.4"`; `{ noClient: true }` gives `"no client"`; `{}` gives `"client not reported"`; `{ clientVersion: "0.8.4", noClient: true }` gives `"0.8.4"`.
- [ ] **Step 2: Run** `bun test web/src/lib/clientlabel.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `clientLabel` and use it in the picker label and the hub line (replace the existing "no client" and "client none" text). Update the README section "Version check and updates in the web UI": describe the registry file, its two paths, the trust rule, who writes it, the Windows default folder, and the three labels, in the README's own style (short sentences, no contractions, no em-dashes, no semicolons).
- [ ] **Step 4: Run** `bun test web/src`, `bun run --cwd web check` and `bun run --cwd web build` (restore any tracked file the build rewrites). Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): label a missing client and an unreported client differently`.

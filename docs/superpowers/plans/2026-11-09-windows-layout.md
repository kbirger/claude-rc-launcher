# Windows layout and registry key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On Windows, one parent folder holds both programs, and the installer records the client in `HKLM\SOFTWARE\claude-rc`, which the node reads. This replaces the Windows registry file.

**Architecture:** The reader in `installs.ts` gets a Windows branch that asks the registry through an injected `regQuery`. `install.ps1` derives `bin` and `service` from `-InstallDir`, writes the registry value, and migrates the old client. Tasks follow the dependency: the reader first, then the installer and the docs.

**Tech Stack:** Bun, TypeScript, PowerShell 5.1 and 7, `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-09-windows-layout-design.md` (replaces the Windows parts of `2026-11-09-client-registry-design.md`)

## Global Constraints

- Registry: `HKLM\SOFTWARE\claude-rc`, value `Client`, `REG_SZ`, the absolute path of `claude-rc.exe`. Read with `%SystemRoot%\System32\reg.exe query HKLM\SOFTWARE\claude-rc /v Client /reg:64`, timeout 2 seconds.
- Folders: `<InstallDir>` default `C:\Program Files\claude-rc`, with `bin` (client, on PATH) and `service`. The service account gets Modify on `service` only.
- `install.ps1` loses `-ClientDir` and `-RegistryDir`. It gains `-ClientRegistryKey` (default `HKLM:\SOFTWARE\claude-rc`, tests only). `-InstallDir` and `-DataDir` stay.
- The Windows registry file, its ACL code, `Test-TrustedOwner`, `Set-AdminOwner` and `Test-ReparsePoint` (if nothing else uses them) are removed. The Linux file and its trust rule do not change.
- A missing or broken registry value never stops the service or the host list. Entry rules do not change: local drive path, no `..`, file name `claude-rc.exe`.
- README style: short sentences, no contractions, no em-dashes, no semicolons.
- Run `bun test server web/src ./cli`, `bun run typecheck` and `bun run --cwd web check` from the repo root. `pwsh` is available here for script tests, but the Windows-only tests skip.

## Review Focus

- A user without administrator rights must not be able to change the value that the node reads (the key lives under `HKLM\SOFTWARE`).
- A value that is a UNC path, a relative path, has `..` or names another file must never be run.
- A machine that has the old layout (client in `C:\Program Files\claude-rc\claude-rc.exe`, service in `C:\Program Files\claude-rc-launcher`) must keep its service running through a reinstall, with the client moved and the PATH fixed.
- Running the installer twice must change nothing the second time.
- `C:\Program Files\claude-rc` has a space: it must work through the PATH entry, the registry value and the version lookup.

---

### Task 1: Read the client from the Windows registry

**Files:**
- Modify: `server/src/installs.ts`, `server/src/realupdate.ts`, `server/src/serviceupdate.ts`
- Test: `server/test/installs.test.ts`, `server/test/serviceupdate.test.ts`, `server/test/realupdate.test.ts`

**Interfaces:**
- Consumes: `readRegisteredClients(io, log)` and `findClients` from the current branch.
- Produces:
  - `RegistryIo` gains `regQuery?(key: string, value: string): { status: "ok"; data: string } | { status: "missing" } | { status: "error"; message: string }`. On `win32` the reader calls it with `HKLM\SOFTWARE\claude-rc` and `Client`. The win32 `readFile` and file path are gone.
  - `registryPath` returns the Linux path only for non-`win32` platforms and is no longer used for `win32` (remove the win32 branch and its test).
  - `findClients` on Windows also looks at `<programFiles>\claude-rc\bin\claude-rc.exe` and `<programFiles>\claude-rc\claude-rc.exe`.
  - `realUpdateEnv` supplies `regQuery` using `Bun.spawnSync` of `%SystemRoot%\System32\reg.exe` (default `C:\Windows`), args `query HKLM\SOFTWARE\claude-rc /v Client /reg:64`, timeout 2000 ms. It parses the line `Client    REG_SZ    <path>`. Exit 1 with no output is `missing`. A timeout or any other failure is `error`.

- [ ] **Step 1: Write the failing tests.** `installs.test.ts`: remove the Windows file tests. With a fake `regQuery`: `ok` with `C:\Program Files\claude-rc\bin\claude-rc.exe` gives that path. `missing` gives `[]` and no log. `error` gives `[]` and one log line, logged once for repeated calls. `ok` with `\\\\srv\\share\\claude-rc.exe`, `C:\\a\\..\\claude-rc.exe`, `claude-rc.exe`, `C:\\x\\other.exe` and a value with a control character each give `[]`. A value with `CLAUDE-RC.EXE` in another letter case is accepted. `serviceupdate.test.ts`: the two Program Files defaults are found with no PATH entry, and each real file appears once. `realupdate.test.ts`: the parser gives the path from a sample `reg query` output with spaces in the path, `missing` for exit 1, and `error` for a thrown spawn.
- [ ] **Step 2: Run** `bun test server/test/installs.test.ts server/test/serviceupdate.test.ts server/test/realupdate.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above. Keep the entry validation (`parse`) and the log-once rule. Update the README section "Version check and updates in the web UI" so that the Windows part names the registry value and the two default places (do this with Task 2's README work if you prefer, but it must be done before the branch is final).
- [ ] **Step 4: Run** the three files, `bun test server` and `bun run typecheck`. Expected: PASS (the known slow `install-binary.sh` tests excepted).
- [ ] **Step 5: Commit** `feat(server): read the Windows client from the registry`.

### Task 2: Installer layout, registry value and migration

**Files:**
- Modify: `deploy/windows/install.ps1`, `README.md`
- Test: `server/test/win-install.test.ts`, `server/test/win-path.test.ts`, `server/test/win-bootstrap.test.ts` (update calls that pass `-ClientDir` or `-RegistryDir`)

**Interfaces:**
- Consumes: the registry contract from Task 1.
- Produces: no code interface.

- [ ] **Step 1: Write the failing tests.** Text checks (they run here): `install.ps1` has no `$RegistryDir`, no `-ClientDir` parameter and no `claude-rc-registry`. It has `$ClientRegistryKey` with the default `HKLM:\SOFTWARE\claude-rc`, `Set-ItemProperty ... -Name Client` and the `service` and `bin` folders under `$InstallDir`. The Modify grant targets the service folder only. Windows-only tests (skipped here): after `-NoService -InstallDir <tmp>` with a throwaway `-ClientRegistryKey` under `HKCU`, the files are in `<tmp>\service` and `<tmp>\bin`, the value `Client` holds `<tmp>\bin\claude-rc.exe`, and a second run leaves everything the same. With a pre-made `<tmp>\claude-rc.exe`, the installer deletes it and moves the PATH entry (use `-PathRegistryKey` with a throwaway key). With `-InstallDir` not given and a pre-made old service folder, the service stays there. `-NoClient` writes no value. `-ClientOnly` writes `bin`, the PATH entry and the value. `-Uninstall` removes both PATH entries and keeps the value and the files. Update the existing win tests that pass `-ClientDir` or `-RegistryDir` to the new options.
- [ ] **Step 2: Run** `bun test server/test/win-install.test.ts server/test/win-path.test.ts server/test/win-bootstrap.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the installer as the spec describes. Derive `$ClientDir = Join-Path $InstallDir 'bin'` and `$ServiceDir = Join-Path $InstallDir 'service'` (the old service folder in the reinstall case). Replace `Register-Client` with a function that creates the key if needed and sets `Client` with `Set-ItemProperty`, only when `-NoClient` is not set, and warns (does not fail the install) when it cannot write. Remove the registry-file code. Update the file header text, the README Windows section (folders, the registry value, the migration note, uninstall) and the sentence about `-Uninstall`.
- [ ] **Step 4: Run** the same command, `bun test server` and `bun run typecheck`. Run `pwsh -NoProfile -Command "[scriptblock]::Create((Get-Content -Raw deploy/windows/install.ps1)) | Out-Null"` as a syntax check. Expected: PASS. State in the commit message that the Windows-only tests did not run here.
- [ ] **Step 5: Commit** `feat(windows): one parent folder and an HKLM registry key for the client`.

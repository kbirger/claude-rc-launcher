# Instance Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each instance gets two settings, "create a session at start" and "session folders". The user chooses them at start and changes them later in the web page and in the CLI. A change restarts the instance. The Linux node and the Windows node behave the same way.

**Architecture:** A small pure module turns two settings into `claude remote-control` flags and back. The Linux backend keeps the flags in the unit file. The Windows backend keeps them in its instance record. Both backends share one change routine with a wait and an undo. The node serves the routes and the explanation text. The hub forwards them. The page and the CLI render the node text.

**Tech Stack:** Bun, TypeScript, Hono, Svelte 5, TanStack Query.

**Spec:** `docs/superpowers/specs/2026-11-17-instance-settings-design.md`. Read it first.

## Global Constraints

- Run `export PATH=$HOME/.bun/bin:$PATH` first. The checks are `bun test server web/src ./cli`, `bun run typecheck` and `bun run --cwd web check`.
- Setting names in the API: `createSession` (boolean, default `true`) and `spawnMode` (`"same-dir"` or `"worktree"`, default `"same-dir"`).
- Flags: always `--spawn <mode>`. When `createSession` is `false`, add `--no-create-session-in-dir`. Otherwise add no such flag. The other operator flags in `claude_rc_args` stay.
- The wait after a change is 20 seconds. The refusal exit code is 69. The refusal text is "already served".
- All new routes need the `write` role, except the help route, which needs `read`.
- Keep CRLF in `server/src/index.win.ts` and `deploy/windows/install.ps1`. Count with `grep -c $'\r' <file>`.
- Add each new Windows-relevant test file to the `windows` job list in `.github/workflows/ci.yml`. `win-instances.test.ts` and `win-config.test.ts` are in it already.
- Write docs in plain English. Use short sentences and put conditions first. Do not use contractions, semicolons or em-dashes.
- End each commit message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Never commit `run.sh`, `.oidc/`, `.serena/` or `HANDOVER.md`.
- Treat node text as untrusted. Render it as text in the page and strip control characters in the CLI.

## Review Focus

1. A user turns `createSession` off on an instance that has a recoverable session. The server exits 69. The node undoes the change, answers 409 with the reason, and the old settings stay. Task 4 and Task 5 own the test.
2. A user chooses `worktree` for a folder that is not a git repository. The node answers 400 before it changes any file. Task 4 owns the test.
3. An old unit file has an operator list with `--spawn worktree`, extra flags and a name with a space. Reading and rewriting it loses nothing. Task 3 owns the test.
4. Two changes to one instance arrive together. The second gets 409 and the first finishes. Task 4 owns the test.
5. An old node has no settings route. The hub answers 404 and the page shows no settings controls and no error banner. Task 9 owns the test.

---

### Task 0: Spikes

**Files:**
- Create: `docs/superpowers/specs/2026-11-17-instance-settings-spikes.md`

No code changes. Use a throwaway git folder that the user trusted. Start the server in the background and write its output to a log file.

- [ ] **Step 1: SIGTERM restore.** Start `claude remote-control --name t --spawn same-dir` with default flags. Note the session id. Send `kill -TERM`. Start it again. Record whether the same session id returns.
- [ ] **Step 2: Worktree without commits.** Run `git init` with no commit. Start the server with `--spawn worktree`. Record whether it starts and what it prints.
- [ ] **Step 3: Exit code.** Create the "already served" refusal. Under systemd, record `ExecMainStatus`. Ask the user to run the same test on the Windows node and record the exit code and the log text.
- [ ] **Step 4: Write the three results in the spikes file. If a result differs from the spec, stop and tell the user. Commit the file.**

### Task 1: Settings module

**Files:**
- Create: `server/src/instancesettings.ts`
- Test: `server/test/instancesettings.test.ts`

**Interfaces:**
- Produces: `type SpawnMode = "same-dir" | "worktree"`, `type InstanceSettings = { createSession: boolean; spawnMode: SpawnMode }`, `type SettingsPatch = Partial<InstanceSettings>`, `const DEFAULT_SETTINGS: InstanceSettings`, `function settingsFromArgs(args: string[]): InstanceSettings`, `function argsWith(base: string[], s: InstanceSettings): string[]`, `type SettingsHelp`, `const SETTINGS_HELP: SettingsHelp`.

- [ ] **Step 1: Write the failing tests.** Names and assertions:
  - `settingsFromArgs(["--spawn","same-dir","--no-create-session-in-dir"])` equals `{createSession:false, spawnMode:"same-dir"}`.
  - `settingsFromArgs([])` equals `DEFAULT_SETTINGS`. `settingsFromArgs(["--spawn=worktree"])` has `spawnMode: "worktree"`.
  - `argsWith(["--spawn","same-dir","--no-create-session-in-dir","--permission-mode","plan"], {createSession:true, spawnMode:"worktree"})` equals `["--permission-mode","plan","--spawn","worktree"]`.
  - `argsWith([], {createSession:false, spawnMode:"same-dir"})` equals `["--spawn","same-dir","--no-create-session-in-dir"]`.
  - `SETTINGS_HELP` has two settings. Each value has a non-empty `explanation`. The `worktree` entry says that the folder must be a git repository.
- [ ] **Step 2: Run `bun test server/test/instancesettings.test.ts`. Expected: FAIL, module not found.**
- [ ] **Step 3: Implement the module.** `argsWith` removes `--spawn <v>`, `--spawn=<v>`, `--create-session-in-dir` and `--no-create-session-in-dir` from `base`, then appends the flags for `s`. The explanation text is the meaning in the spec, section "The two settings".
- [ ] **Step 4: Run the test. Expected: PASS.**
- [ ] **Step 5: Commit** `feat: instance settings module`.

### Task 2: Defaults and docs

**Files:**
- Modify: `server/src/config.ts:414`, `README.md` (lines near 340 and 463), `deploy/config.example.toml:21`
- Test: `server/test/config.test.ts:42`, `server/test/win-config.test.ts:36`, `server/test/unit.test.ts:42,74`

- [ ] **Step 1: Change the four test expectations.** The default `claudeRcArgs` becomes `["--spawn","same-dir"]`. The `ExecStart` lines in `unit.test.ts` lose the flag.
- [ ] **Step 2: Run the three test files. Expected: FAIL on those lines.**
- [ ] **Step 3: Change the default in `config.ts`. Update the README table row and the README unit example. Update the comment in `config.example.toml`.** Add one README sentence that says why the flag is gone: a server with the flag refuses to restart while its folder has a recoverable session.
- [ ] **Step 4: Run the three test files. Expected: PASS. Commit** `feat: new instances create a session at start by default`.

### Task 3: Linux unit render and parse

**Files:**
- Modify: `server/src/unit.ts` (`renderUnit` at line 70), `server/src/instances.ts` (`Instance` type, `describe`)
- Test: `server/test/unit.test.ts`, `server/test/instances.test.ts`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces: `renderUnit(cfg, absPath, name, runAs?, settings?: InstanceSettings): string`. Without `settings` the output is unchanged. Also `parseUnitSettings(content: string): InstanceSettings` in `unit.ts`. The `Instance` type gets `settings?: InstanceSettings`.

- [ ] **Step 1: Write the failing tests.**
  - Round trip: render a unit with name `my proj` and `{createSession:false, spawnMode:"worktree"}`. `parseUnitSettings` returns the same values. `nameFromUnit` still returns `my proj`.
  - An old unit with `--spawn same-dir --no-create-session-in-dir` reads as `{createSession:false, spawnMode:"same-dir"}`. A unit with no flags reads as the defaults.
  - An operator list `["--spawn","worktree","--permission-mode","plan"]` plus settings `{createSession:true, spawnMode:"same-dir"}` keeps `--permission-mode plan`.
  - `describe` output carries `settings`.
- [ ] **Step 2: Run the tests. Expected: FAIL.**
- [ ] **Step 3: Implement `parseUnitSettings`.** It splits the `ExecStart` value into words. It must undo `execWord` quoting exactly, so read `execWord` first. Then it calls `settingsFromArgs` on the words after `--name <value>`. When `settings` is given, `renderUnit` uses `argsWith(cfg.claudeRcArgs, settings)`.
- [ ] **Step 4: Run the tests. Expected: PASS. Commit** `feat: read and write instance settings in the unit file`.

### Task 4: Linux start, restart and update

**Files:**
- Create: `server/src/instancechange.ts`
- Modify: `server/src/instances.ts` (the `Instances` interface and `InstanceService`)
- Test: `server/test/instancechange.test.ts`, `server/test/instances.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 3.
- Produces in `instancechange.ts`: `waitSettled(probe: () => Promise<"up" | "refused" | "down">, o: { timeoutMs: number; intervalMs: number; sleep?: (ms: number) => Promise<void> }): Promise<"ok" | "refused" | "failed">`. If the probe says `up` for the whole window, the result is `ok`. Also `class ChangeLock { tryLock(id: string): (() => void) | undefined }`.
- Produces in the `Instances` interface: `start` input gets `settings?: SettingsPatch`. New optional members `restart?(id: string): Promise<void>` and `update?(id: string, patch: SettingsPatch): Promise<{ instance: Instance; previous: InstanceSettings }>`.
- A failed change throws `HttpError(409, reason, { code: "settings_refused" | "settings_failed", settings: previous })`. A change in progress throws `HttpError(409, "change in progress")`.

- [ ] **Step 1: Write the failing tests.**
  - `waitSettled` with a probe that returns `up` for the whole window gives `ok`. A probe that returns `refused` once gives `refused` at once. Use a fake `sleep`.
  - With a fake runner, `start` with `{spawnMode:"worktree"}` in a folder that is not a git repository throws 400 and writes no unit file.
  - Call `update` with `{createSession:false}`. The runner `show` reports `ExecMainStatus=69`. The old unit file bytes come back. `restart` runs twice. The call throws 409 with code `settings_refused`.
  - `update` with a healthy runner rewrites the unit file, runs `daemon-reload` then `restart`, and returns `{instance, previous}`.
  - Two `update` calls for one id together: the second throws 409 `change in progress`.
  - A patch equal to the current settings does nothing and does not restart.
- [ ] **Step 2: Run the tests. Expected: FAIL.**
- [ ] **Step 3: Implement.** `start` tests `worktree` with `repoKind(real)` from `server/src/repokind.ts`. `update` follows the spec section "A change with undo". Write the new unit to `<file>.tmp` and rename it. The probe reads `ActiveState` and `ExecMainStatus` through the existing `show`. `restart` uses the existing `change` helper with `["restart"]`.
- [ ] **Step 4: Run the tests. Expected: PASS. Commit** `feat: change instance settings on the Linux node`.

### Task 5: Windows backend

**Files:**
- Modify: `server/src/win/instances.ts` (`Entry`, `persist`, `restore`, `spawnFor`, `supervise`, `start`)
- Test: `server/test/win-instances.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 4 (`waitSettled`, `ChangeLock`, the interface members).
- Produces: `WinInstances.restart(id)` and `WinInstances.update(id, patch)` with the same results and errors as Task 4. `Entry` gets `settings: InstanceSettings` and `lastExit?: { code: number | null }`. The state file record gets `createSession` and `spawnMode`. A record without them reads as the defaults. The result of `list` and `start` carries `settings`.

- [ ] **Step 1: Write the failing tests with the fake spawn.**
  - A state file with no settings fields restores with the defaults. After `update`, the file has both fields.
  - `spawnFor` passes `argsWith(claudeRcArgs, entry.settings)` to the spawn function.
  - `update` with a spawn that exits 69 inside the window restores the old record and throws 409 `settings_refused`.
  - `restart` kills the tree once and the supervisor starts a new process at once, with no wait.
- [ ] **Step 2: Run `bun test server/test/win-instances.test.ts`. Expected: FAIL.**
- [ ] **Step 3: Implement.** Record the exit code in `supervise`. Add a flag on the entry that skips the wait for one respawn. The probe maps `active` to `up`, exit code 69 or the log text "already served" to `refused`, and everything else to `down`.
- [ ] **Step 4: Run the test file. Expected: PASS. Commit** `feat: instance settings on the Windows node`.

### Task 6: Node routes

**Files:**
- Modify: `server/src/requests.ts` (`StartRequest`, new `parseSettingsPatch`), `server/src/app.ts` (near lines 111 to 140)
- Test: `server/test/requests.test.ts`, `server/test/app.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 4.
- Produces: `POST /api/instances` accepts `createSession` and `spawnMode`. `PATCH /api/instances/:id` returns `{ instance, previous }`. `POST /api/instances/:id/restart` returns 204. `GET /api/instance-settings` returns `SETTINGS_HELP`. `parseSettingsPatch(body: unknown): SettingsPatch` throws `HttpError(400)` for an empty body, a wrong type, an unknown value or an unknown field.

- [ ] **Step 1: Write the failing tests.** `parseSettingsPatch` cases: `{}`, `{createSession:"yes"}`, `{spawnMode:"tree"}` and `{x:1}` each throw 400. Route cases: PATCH answers 200 with `previous`. A backend with no `update` gives 501. GET returns the help object. POST start passes the settings to the backend.
- [ ] **Step 2: Run the tests. Expected: FAIL.**
- [ ] **Step 3: Implement the routes** in the style of the `pause` route.
- [ ] **Step 4: Run the tests. Expected: PASS. Commit** `feat: node routes for instance settings`.

### Task 7: Hub

**Files:**
- Modify: `server/src/hosts.ts` (near lines 262 and 330), `server/src/roles.ts` (lines 80 to 106)
- Test: `server/test/hosts.test.ts`, `server/test/roles-routes.test.ts`, `server/test/roles.test.ts`

**Interfaces:**
- Consumes: Task 6 routes.
- Produces: hub routes `PATCH /hosts/:host/instances/:id` (write), `POST /hosts/:host/instances/:id/restart` (write), `GET /hosts/:host/instance-settings` (read). One audit line for each PATCH, in the format of the existing rule-edit line. It has the user, role, host, instance, the old values and the new values.

- [ ] **Step 1: Write the failing tests.** A read user gets 403 on PATCH and restart. A write user is forwarded. The audit line holds both value sets and no token or path. A node answer of 404 for the help route reaches the caller as 404.
- [ ] **Step 2: Run the tests. Expected: FAIL.**
- [ ] **Step 3: Implement the forwards and the role rows.**
- [ ] **Step 4: Run the tests. Expected: PASS. Commit** `feat: hub routes and audit line for instance settings`.

### Task 8: CLI

**Files:**
- Modify: `cli/src/args.ts` (`Flags` and the option list), `cli/src/commands.ts` (`start`, `list`, new `settings`), `cli/src/index.ts` (`INSTANCE_COMMANDS`)
- Test: `cli/test/commands.test.ts`

**Interfaces:**
- Consumes: Task 7 routes.
- Produces: flags `--create-session`, `--no-create-session`, `--spawn <mode>` and `--yes`. Commands `start <path> [flags]`, `settings <id>` and `settings <id> [flags]`.

- [ ] **Step 1: Write the failing tests.** `start` sends the two fields. `--create-session` with `--no-create-session` fails with a clear error. `--spawn tree` fails. `settings <id>` prints both values and the node explanations. `settings <id> --no-create-session` without `--yes` asks first and sends nothing on "no". `list` shows a settings column.
- [ ] **Step 2: Run `bun test cli/test/commands.test.ts`. Expected: FAIL.**
- [ ] **Step 3: Implement.** Strip control characters from node text before printing.
- [ ] **Step 4: Run the tests. Expected: PASS. Commit** `feat(cli): instance settings`.

### Task 9: Web page

**Files:**
- Modify: `web/src/lib/features/instances/api.ts`, `mutations.ts`, `model.svelte.ts`, `InstanceList.svelte`, `web/src/lib/startflow.svelte.ts`, `web/src/routes/instances/+page.svelte`
- Create: `web/src/lib/features/instances/InstanceSettingsFields.svelte`, `InstanceSettingsDialog.svelte`
- Test: `api.test.ts`, `model.test.ts`, `InstanceList.test.ts`, `web/src/lib/startflow.test.ts` (same folders)

**Interfaces:**
- Consumes: Task 7 routes.
- Produces: `Instance.settings?`, `getInstanceSettingsHelp(host)`, `updateInstanceSettings(host, id, patch)`, `restartInstance(host, id)` in `api.ts`. The fields component takes the help object and a value and shows each explanation under its choice.

- [ ] **Step 1: Write the failing tests.** The start form sends both settings. The dialog shows the restart text from the spec and sends nothing until the user agrees. A 409 shows the node reason in the dialog. A 404 from the help route hides the controls and shows no error banner. Node text renders as text.
- [ ] **Step 2: Run `bun test web/src`. Expected: FAIL.**
- [ ] **Step 3: Implement** with the existing mutation and model patterns, and the shadcn components already in the project.
- [ ] **Step 4: Run `bun test web/src` and `bun run --cwd web check`. Expected: PASS. Commit** `feat(web): instance settings in the start form and a settings dialog`.

### Task 10: README and full run

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a README section "Instance settings".** It names the two settings, the CLI flags, the restart, the undo and the Windows note.
- [ ] **Step 2: Run `bun test server web/src ./cli`, `bun run typecheck` and `bun run --cwd web check`. Expected: all pass.**
- [ ] **Step 3: Add any new Windows test file to the `windows` job list. Commit** `docs: instance settings`.
- [ ] **Step 4: Tell the user the manual checks that only they can do: change a setting on a live Linux instance, change one on the Windows node, and make a refusal happen on purpose.**

# Manual Session Resume Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to run this plan task by task. Steps use checkbox (`- [ ]`) syntax.

Goal: A node finds a session that lost its process and offers a Resume. Resume starts `claude remote-control --session-id <bridge id>` as a tracked child, restarts it after a drop, and sends one continue message to a session that stopped midflight.

Architecture: The session catalog marks lost sessions. A new class `SessionResumer` on the node supervises the children. New routes on the node and the hub start, read and stop a resume. A restart route covers folders with a server. The CLI and the web page call the routes. The Windows node gets its process functions from a small factory.

Tech Stack: Bun, TypeScript, Hono, Svelte 5, `bun:test`, vitest for the web.

Spec: `docs/superpowers/specs/2026-11-17-manual-session-resume-design.md`

## Global Constraints

- Set the path for Bun first: `export PATH=$HOME/.bun/bin:$PATH`.
- Run `bun test server web/src ./cli`, `bun run typecheck` and `bun run --cwd web check` at the end of every task that changes code.
- The bridge id never reaches the web page, a log line, an error or a test snapshot. A test must prove this for each new route.
- The socket path and the peer token never leave `livesessions.ts` and `nudge.ts`.
- Process output and transcript text are not trusted. Cut them and match them. Never show them.
- A resume never starts a second process for a session that already runs.
- `server/src/index.win.ts` and `deploy/windows/install.ps1` use CRLF line endings. Count them with `grep -c $'\r' <file>` before and after an edit.
- Add each new Windows-relevant test file to the `windows` job list in `.github/workflows/ci.yml`.
- Never commit `run.sh`, `.oidc/` or `.serena/`.
- End each commit message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Text in the README and in messages follows the simple-english rules.
- If a test fails only in the sandbox, run it at the base commit before you call it a sandbox failure.

## Review Focus

- A `lost` answer that holds the bridge id, in any field, route or log line.
- A second resume that races the first. Expect one child and a 409 for the other.
- A restart loop that survives a stop. Expect no new start after `stop`.
- A continue message that repeats after a restart. Expect one message for each entry.
- A transcript tail that is cut in the middle of a line. Expect `null`, not a crash.
- A child that exits with 69 or with "already served" in its log. Expect `blocked` and no retry.
- A node shutdown. Expect that all children end.
- The Windows node. Expect no continue message, no Restart button, and the same token as the instance.

---

### Task 0: Run the spikes

The design lists nine open questions. Answer the ones that change the build before Task 4. Do not change product code in this task.

Files:
- Modify: `docs/superpowers/specs/2026-11-17-manual-session-resume-design.md` (record each result under "Open questions")
- Scratch only: a throwaway script outside the repository

- [ ] Make a scratch folder with `git init` and one empty commit. Ask the user to accept workspace trust for it once. Do not edit `~/.claude.json` yourself.
- [ ] Spike 5: stop the unit of a scratch server with `systemctl stop`. Start it again. Record whether its sessions come back.
- [ ] Spike 3: run `kill -9` on a scratch server with default flags. Start it again. Record whether its sessions come back.
- [ ] Spike 1: get two sessions in the scratch folder. Run the server for one and `--session-id` for the other. Record whether both run.
- [ ] Spike 2: with no server, run two `--session-id` processes for two sessions of the folder. Record the result.
- [ ] Spike 6: record the exit code of a refused `--session-id` process.
- [ ] Spike 4: copy a transcript, resume it in the scratch folder, and compare the sizes and the record counts.
- [ ] Spike 7 and spike 8: try a work tree session and a session that is one day old. Record the folder and the error text.
- [ ] Write each result into the design under its question. Mark each question as answered.
- [ ] If spike 1 shows that a single-session process runs beside a server, stop. Report this to the user. The decision flow changes.
- [ ] Stop every scratch process. Delete the scratch folder.
- [ ] Commit the design update.

### Task 1: Find the bridge id of a session

Files:
- Modify: `server/src/sessionchains.ts`
- Test: `server/test/sessionchains.test.ts`

Interfaces:
- Produces `SessionChains.bridgeOf(sessionId: string): Promise<string | undefined>`.
- The id must match `^session_[A-Za-z0-9]{10,64}$`. Any other value gives `undefined`.

- [ ] Write the failing tests. Cases: a known pair gives the bridge id. An unknown id gives `undefined`. Two bridges that hold the same id give the newest one. A `link:` key never counts as a bridge id. A key that does not match the pattern gives `undefined`. A store that lives only in memory works.
- [ ] Run the tests and see them fail.
- [ ] Implement `bridgeOf`. Load the store. Walk the entries from the newest key to the oldest. Skip keys that start with `link:`. Return the first key that holds the id and matches the pattern.
- [ ] Run the tests and see them pass.
- [ ] Commit: `feat: find the bridge id of a session`.

### Task 2: Tell midflight from finished

Files:
- Create: `server/src/sessionstate.ts`
- Test: `server/test/sessionstate.test.ts`

Interfaces:
- Produces `lastTurnState(fs: TranscriptFs, file: string): Promise<"midflight" | "finished" | null>`.
- Uses `fs.tail?.(file, 256 * 1024)` (the same window as `sessionnames.ts`) and `parse` from `server/src/transcript.ts`.

- [ ] Write fixtures as arrays of JSON lines. Cases: the last conversation record is an assistant record with `stop_reason: "end_turn"` (finished). It ends with a `tool_use` and no later `user` record (midflight). It is a `user` prompt with no answer (midflight). It is a `user` tool result with no answer (midflight). Trailing records of the ignored types do not change the answer. A record with `isSidechain: true` is ignored. A tail that starts in the middle of a line gives the right answer for the whole lines. An empty tail, a file with no conversation record and a tail with only broken lines give `null`. A `fs` without `tail` gives `null`.
- [ ] Run the tests and see them fail.
- [ ] Implement `lastTurnState`. Ignore the types `attachment`, `system`, `session-owner`, `atis-latch`, `tools-used`, `queue-operation`, `last-prompt`, `cost-state` and `pr-link`. Skip a first line that does not parse. Never throw.
- [ ] Run the tests and see them pass.
- [ ] Commit: `feat: tell midflight from finished in a transcript`.

### Task 3: Configuration keys for resume

Files:
- Modify: `server/src/config.ts`
- Test: `server/test/config.test.ts`, `server/test/win-config.test.ts`

Interfaces:
- Adds `resumeWindowHours: number` (default 24) and `resumeMax: number` (default 4) to `Config`.
- The keys in the `[instance]` table are `resume_window_hours` and `resume_max`. Each is a positive integer.

- [ ] Write the failing tests: the defaults, a valid value, a zero, a negative number, a text value and a value over 168 for the window.
- [ ] Run the tests and see them fail.
- [ ] Read the keys next to `claude_rc_args` in `config.ts`. Reject a bad value with the existing error style.
- [ ] Run the tests and see them pass.
- [ ] Add the two keys to `deploy/config.example.toml` and to the README table of keys.
- [ ] Commit: `feat: configuration keys for session resume`.

### Task 4: The lost field in the session list

Files:
- Modify: `server/src/sessioncatalog.ts`, `server/src/sessionapi.ts`
- Test: `server/test/sessioncatalog.test.ts`, `server/test/sessionapi.test.ts`

Interfaces:
- `SessionSummary.lost?: { midflight: boolean | null; server: "running" | "none" | "unknown" }`.
- `InstanceSessions.list(o?: { server?: "running" | "none" | "unknown"; windowMs?: number; now?: () => number })`.
- `InstanceSessions.lostInfo(id: string, o)` gives the same value for one session. Both use one private function.

- [ ] Write the failing tests for the catalog. If a session is not live, has a bridge id and has a write inside the window, the catalog marks it lost. The catalog does not mark a session lost in four cases. The session is live. It has no bridge id. It is older than the window. A newer transcript of its chain holds it. `midflight` follows `lastTurnState`: `true`, `false` and `null`. `server` passes through. The JSON of a list never holds the bridge id.
- [ ] Write the failing tests for the route. The `GET /` handler asks `instances.list()` for the state of its instance. The states `active` and `activating` give `running`. Any other state gives `none`. A missing instance gives `unknown`.
- [ ] Run the tests and see them fail.
- [ ] Implement the private function in `sessioncatalog.ts`. It uses `chains.bridgeOf`, `readLive` and `lastTurnState`. Do not read the transcript for a session that cannot be lost.
- [ ] Pass `server`, `windowMs` from `cfg.resumeWindowHours` and the clock from `sessionapi.ts`.
- [ ] Run the tests and see them pass.
- [ ] Update the field list in `docs/session-files.md`.
- [ ] Commit: `feat: mark sessions that lost their process`.

### Task 5: The SessionResumer state machine

Files:
- Create: `server/src/sessionresume.ts`
- Test: `server/test/sessionresume.test.ts`

Interfaces:
- `type ResumeState = "starting" | "active" | "waiting" | "blocked" | "failed" | "finished"`.
- `type ResumeEntry = { sessionId: string; state: ResumeState; attempts: number; startedAt: string | null; midflight: boolean | null }`. It never holds the bridge id.
- `type Launched = { pid: number; exited: Promise<number | null> }`.
- `type ResumeSeams = { launch(spec: { argv: string[]; cwd: string; logFile: string; identity?: Identity }): Launched; stop(pid: number): Promise<void>; readLive(home: string): Promise<ReadonlyMap<string, LiveInfo>>; nudge: typeof nudge; readLog(file: string): Promise<string>; now(): number; sleep(ms: number): Promise<void> }`.
- `class SessionResumer` with `start(input)`, `get(sessionId)`, `stop(sessionId)` and `stopAll()`.
- `class ResumeError extends Error` with `status` and `code`. Codes: `already_running`, `already_resuming`, `resume_limit`, `bad_bridge`.
- Constants: `RESTART_DELAYS_MS = [5000, 15000, 45000]`, `SUCCESS_TIMEOUT_MS = 30000`, `STABLE_MS = 120000`, `FAILURE_WINDOW_MS = 600000`, `LOG_MAX = 256 * 1024`.

- [ ] Write the failing tests with fake seams and a fake clock. The argv is `[claudeBin, "remote-control", "--session-id", bridgeId]` with no shell. A bad bridge id gives `bad_bridge`. When `readLive` shows the session, the state becomes `active`. The state becomes `failed` after 30 seconds with no live entry, and the child ends.
- [ ] Write more failing tests. Exit code 69 gives `blocked` and no retry. The text "already served" in the log gives `blocked`. Exit code 0 gives `finished`. Any other exit gives `waiting`, then a start after 5, 15 and 45 seconds. Three failures in 10 minutes give `failed`. A run that stays `active` for 2 minutes resets the count.
- [ ] Write more failing tests. `stop` ends the child and cancels a wait, and no new start follows. `stopAll` ends every child. A live session gives `already_running`. An entry gives `already_resuming`. If `resumeMax` is 4, the fifth entry gives `resume_limit`. The log is cut at `LOG_MAX`.
- [ ] Run the tests and see them fail.
- [ ] Implement `SessionResumer`. Follow the loop in `WinInstances.supervise` in `server/src/win/instances.ts`: a flag for stop, a wait that a stop can wake, and a state for each step.
- [ ] Run the tests and see them pass.
- [ ] Commit: `feat: supervise resumed session processes`.

### Task 6: The continue message

Files:
- Modify: `server/src/sessionresume.ts`
- Test: `server/test/sessionresume.test.ts`

Interfaces:
- `export const CONTINUE_TEXT = "The process that ran this session was restarted. If you were in the middle of a task, continue it. If the task was already finished, reply with the single word done."`.
- Uses `nudge({ home, sessionId, message, identity })` from `server/src/nudge.ts`.

- [ ] Write the failing tests. If `midflight` is `true` and the live status is `idle`, the node sends the text once after the first `active`. If `midflight` is `false` or `null`, it sends nothing. If the status is `busy`, it sends nothing. It does not send again after a restart. A `nudge` result of `unsupported`, `not_live`, `socket_refused` or `send_failed` does not change the state. A `nudge` that throws does not change the state. The log line has no socket path and no session text.
- [ ] Run the tests and see them fail.
- [ ] Implement the send. Keep the `continueSent` flag in the entry. Log one fixed line with the result word.
- [ ] Run the tests and see them pass.
- [ ] Commit: `feat: send one continue message to a resumed session`.

### Task 7: Node routes and roles

Files:
- Modify: `server/src/sessionapi.ts`, `server/src/app.ts`, `server/src/roles.ts`
- Test: `server/test/sessionapi.test.ts`, `server/test/roles.test.ts`, `server/test/roles-routes.test.ts`

Interfaces:
- `POST /instances/:id/sessions/:sid/resume`: 201 with a `ResumeEntry`.
- `GET /instances/:id/sessions/:sid/resume`: 200 with the entry, or 404.
- `DELETE /instances/:id/sessions/:sid/resume`: 204.
- A 409 for a folder with a server has the body `{ error, code: "server_running", explanation }`. The `explanation` is the fixed text from the design. The web page and the CLI print it.
- The roles rows: `write` for `POST` and `DELETE`, `read` for `GET`, with the pattern `${SESSION}/resume`.

- [ ] Write the failing route tests. A bad instance id or session id gives 400. An unknown session or a session that is not lost gives 404. A lost session in a folder with a running server gives 409 `server_running`. A live session gives 409 `already_running`. A second `POST` gives 409 `already_resuming`. A good `POST` gives 201. `GET` and `DELETE` follow the entry. No body holds the bridge id.
- [ ] Write the failing audit tests. Each `POST` and `DELETE` writes one line `audit user=... action=resume ...` or `action=resume-stop`. The line has no bridge id and no path.
- [ ] Write the failing roles tests. A `read` user gets 403 for `POST` and `DELETE`. The route-table walk in `roles-routes.test.ts` passes.
- [ ] Run the tests and see them fail.
- [ ] Implement the routes. Use `instances.claudeHome(id)` for the folder, the home and the identity. Use the real-root test of `PinnedRoot.pin` for a work tree session. Use `catalog.chains.bridgeOf` for the bridge id.
- [ ] Build one `SessionResumer` in `app.ts` next to `sessionCatalogFor`. Share it by the hub `local` host and by the node app.
- [ ] End all children at shutdown in `server/src/nodemain.ts` and `server/src/hubmain.ts`.
- [ ] Run the tests and see them pass.
- [ ] Commit: `feat: routes to resume a lost session`.

### Task 8: Restart a server instance

Files:
- Modify: `server/src/app.ts`, `server/src/roles.ts`
- Test: `server/test/sessionapi.test.ts` (or the instance route tests next to it), `server/test/roles-routes.test.ts`

Interfaces:
- `POST /instances/:id/restart`: 204. It runs `pause` and then `resume` of the backend.
- If the backend has no `pause` or no `resume`, the route answers 501.
- The roles row is `write`.

- [ ] Write the failing tests: a good restart calls `pause` and then `resume` in that order. A bad id gives 400. A backend with no `pause` gives 501. A failure of `pause` does not call `resume`. A failure of `resume` gives 500 with the existing error style.
- [ ] Run the tests and see them fail.
- [ ] Implement the route next to the `pause` and `resume` routes in `app.ts`.
- [ ] Run the tests and see them pass.
- [ ] Commit: `feat: restart route for a server instance`.

### Task 9: Hub forwarding and audit

Files:
- Modify: `server/src/hosts.ts`
- Test: `server/test/hosts-sessions.test.ts`

Interfaces:
- Hub routes `POST`, `GET` and `DELETE` for `/hosts/:host/instances/:id/sessions/:sid/resume`, and `POST /hosts/:host/instances/:id/restart`.
- Audit lines in the style of `ruleEdit` (`hosts.ts`): `audit user=<who> role=<role> host=<id> action=resume instance=<id> session=<session id>`. The actions `resume-stop` and `restart` use the same form.

- [ ] Write the failing tests. The hub forwards each route to the node path. A 409 body passes through unchanged. A node that is down gives the existing error. The audit line has the user, the role, the host, the instance and the session, and nothing else.
- [ ] Run the tests and see them fail.
- [ ] Implement the routes next to the permission routes. Use `forwardJson` for `GET`. Write the audit line for each write before the call.
- [ ] Run the tests and see them pass.
- [ ] Commit: `feat: hub routes to resume a lost session`.

### Task 10: CLI commands

Files:
- Modify: `cli/src/commands.ts`, `cli/src/index.ts`
- Test: `cli/test/commands.test.ts`

Interfaces:
- `claude-rc session list <instance>`, `claude-rc session resume <instance> <session>` and `claude-rc session stop <instance> <session>`.
- All three accept `--host` and `--json`.
- A 409 `server_running` prints the `explanation` from the body. It also prints the hint `restart the instance in the web page`.

- [ ] Write the failing tests. `list` marks a lost session and shows its `midflight` value. `resume` prints the state of the entry. `stop` prints one line. `--json` prints the raw body. A 409 prints the explanation and exits with a non-zero code. A missing argument prints the usage text.
- [ ] Run the tests and see them fail.
- [ ] Implement the commands. Follow the two-word form of `host` and `node` in `index.ts`. Add the usage text to the help.
- [ ] Run the tests and see them pass.
- [ ] Commit: `feat(cli): session list, resume and stop`.

### Task 11: Web page

Files:
- Modify: `web/src/lib/features/sessions/api.ts`, `web/src/lib/features/sessions/SessionList.svelte`
- Create: `web/src/lib/features/sessions/ResumeDialog.svelte`
- Test: `web/src/lib/features/sessions/api.test.ts`, a new `ResumeDialog.test.ts`

Interfaces:
- `Session` gets `lost?: { midflight: boolean | null; server: "running" | "none" | "unknown" }`.
- New functions `resumeSession`, `getResume`, `stopResume` and `restartInstance` in `api.ts`.

- [ ] Write the failing tests. The list shows a "Lost" mark for a lost session. The dialog for `server: "none"` lists the four effects and has a Resume button. The dialog for `server: "running"` shows the `explanation` and a Restart server button, and no Resume button. A `409 server_running` from `POST` shows the same view. While an entry is `starting` or `waiting`, the page polls every 3 seconds. A `blocked` entry shows the `explanation`. A `failed` entry shows a fixed reason. A `midflight: true` session shows the line about one message.
- [ ] Run the tests and see them fail.
- [ ] Implement the functions and the components. Use the existing `request` helper, the `EntityCard` and `Pill` components and the query patterns of the sessions feature.
- [ ] Hide the buttons for a user with the `read` role. Follow how the page hides other controls.
- [ ] Run `bun run --cwd web check` and the web tests. Make them pass.
- [ ] Commit: `feat(web): resume a lost session`.

### Task 12: Windows node

Files:
- Create: `server/src/win/sessionresume.ts`
- Modify: `server/src/index.win.ts` (CRLF), `.github/workflows/ci.yml`
- Test: `server/test/win-sessionresume.test.ts`

Interfaces:
- `winResumeSeams(deps: WinDeps, o: { serviceIsAdmin: boolean; claudeBin: string }): Pick<ResumeSeams, "launch" | "stop">`.
- It uses `bunSpawn`, `spawnRestricted` and `taskkillTree` from `server/src/win/instances.ts`.

- [ ] Write the failing tests with fake `WinDeps`. A normal instance uses `spawnRestricted` on an administrator service. The admin entry uses `spawn`. `stop` calls `killTree`. A missing `spawnRestricted` on an administrator service throws, as `WinInstances` does.
- [ ] Write a test that `nudge` returns `unsupported` on `win32` and that the entry still becomes `active`.
- [ ] Run the tests and see them fail.
- [ ] Implement the factory. Wire it into `index.win.ts` and keep the CRLF endings.
- [ ] Add `win-sessionresume.test.ts` and `sessionresume.test.ts` to the `windows` list in `ci.yml`.
- [ ] Run the tests and see them pass.
- [ ] Commit: `feat(win): resume a lost session on the Windows node`.

### Task 13: Documents

Files:
- Modify: `README.md`, `docs/session-files.md`

- [ ] Add a README section "Resume a lost session". Explain the three cases: a folder with a server, a folder with no server, and a session with no known bridge id.
- [ ] Explain the Restart server advice and the flag `--no-create-session-in-dir` in plain words. State that a node restart ends the resumed processes.
- [ ] Add the two configuration keys to the README table.
- [ ] Add a short section to `docs/session-files.md` about the `lost` field. State that the bridge id stays on the node.
- [ ] Read the new text for the simple-english rules.
- [ ] Commit: `docs: resume a lost session`.

### Task 14: Final run and a real test

- [ ] Run `bun test server web/src ./cli`, `bun run typecheck` and `bun run --cwd web check`. Fix every failure that the change caused.
- [ ] Build the hub on this machine. Make a lost session on a scratch instance. End its server process with `kill -9`, then stop the instance.
- [ ] Make sure that the page shows the session as lost. Press Resume and make sure that Remote Control shows it as active.
- [ ] End the child from the page. Make sure that the session is lost again.
- [ ] Start the instance again. Press Resume. Make sure that the page shows the restart text and no Resume button.
- [ ] If any answer changed, record the result in the design under "Open questions".
- [ ] Ask the user before a release.

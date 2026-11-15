# Permissions Phase 3 (Nudge) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user saves an allow rule for a blocked call. The node then tells the running session to try again. It uses the session inbox socket and needs no restart.

**Architecture:** `livesessions.ts` finds the socket path of a live session after the existing pid checks. A new `nudge.ts` checks that the path is a real socket owned by the instance user, builds a fixed message, and sends one line. On a privileged node the send runs in a child process as the instance user (the binary calls itself with the subcommand `nudge-send`). The rule route runs the nudge only after the file write worked, and adds a `nudge` key to the answer. The sheet shows a checkbox and the result.

**Tech Stack:** Bun, Hono, node:net, Svelte 5, TanStack Query, vitest.

**Spec:** `docs/superpowers/specs/2026-11-14-permissions-design.md`, section "Nudge (Phase 3)". Spike facts: project memory `permissions-spike-results`. Phase 2 plan: `docs/superpowers/plans/2026-11-14-permissions-phase2.md`.

## Global Constraints

- The socket path, the pid, and the `.key` file never reach the web, a log, or an API answer. Nothing in this plan opens a `.key` file.
- The node sends no auth line. Linux only. On any other platform the nudge gives `{ sent: false, reason: "unsupported" }` and the rule is still saved.
- The message is a fixed template. It names the list, the rule, and the file path. It never holds the text or the input of a blocked call.
- The UI says "sent", never "received". A session in bypass mode can hold the message for approval, and the node cannot see that.
- The nudge runs only after a successful add. A failed add (409, 400, 403, 500) never nudges. A remove never nudges.
- Before any connect, the path must pass `lstat`: not a symlink, is a socket, owned by the instance user.
- The connect and the write end within 3 seconds, or the nudge gives `send_failed`.
- Audit lines keep the Phase 2 rules: known-set-or-`?` for fixed words, JSON quote for free text.
- Docs and plan text use short plain sentences. A hook rejects semicolons, em dashes, and contractions in new docs.

## Review Focus

- A symlink named like the socket, a socket owned by root (the Docker socket case), a FIFO or a regular file at the path: none gets a connect. Reason `socket_refused`.
- A reused pid: the session file of a dead process gives no socket. Reason `not_live`.
- A socket path with a symlinked folder in the middle and a real socket at the end: if `realpath` differs from the path, the node refuses it.
- A message that holds a newline or a quote from the rule: it still goes out as one JSON line. The test sends a rule with a quote and a backslash.
- A session that never reads the socket: the call ends at 3 seconds and does not hang the request.
- A failed or conflicting add with `nudge: true`: no connect happens.
- The answer and the audit line never hold the socket path, the pid, or the token.

---

## Files

- `server/src/livesessions.ts`: add `findSessionSocket`. The scan code is shared with `readLiveSessions`.
- `server/src/nudge.ts` (new): `checkSocket`, `nudgeMessage`, `sendLine`, `nudge`, and the child entry `runNudgeSend`.
- `server/src/index.ts`: the `nudge-send` subcommand. `index.win.ts` has none.
- `server/src/permissionsapi.ts`: the `nudge` flag, the nudge call, the audit key.
- `server/src/hosts.ts`: the hub checks the flag, forwards it, and logs it.
- `web/src/lib/features/permissions/`: `api.ts`, `format.ts`, `RuleSheet.svelte`, and the parent that passes `live`.

### Task 1: Find the socket and check it

**Files:**
- Modify: `server/src/livesessions.ts`
- Create: `server/src/nudge.ts` (the `checkSocket` part)
- Test: `server/src/livesessions.test.ts`, `server/src/nudge.test.ts`

**Interfaces:**
- Produces in `livesessions.ts`: `findSessionSocket(o: { home: string; sessionId: string; fs?: LiveFs; alive?: (pid: number) => boolean; proc?: ProcReads }): Promise<string | undefined>`. It applies the same checks as `readLiveSessions`. These are: real home, `.json` only, pid match, `procStart`, and `pidDomain`. It returns `messagingSocketPath` of the newest file for that session id. It returns undefined in these cases: there is no live session, or no `messagingSocketPath`. If the value is not a string, it also returns undefined. The same holds for a path that is not absolute, a path over 1024 characters, or a path with a NUL.
- Produces in `nudge.ts`: `checkSocket(path: string, ownerUid: number, o?: { lstat?: typeof lstat; realpath?: typeof realpath }): Promise<"ok" | "refused">`.
- `LiveInfo` does not change. The socket path stays inside the server.

- [ ] **Step 1: Write the failing tests.** In `livesessions.test.ts`, write these tests:
  - `findSessionSocket returns the socket of the live session`.
  - `findSessionSocket gives undefined for a dead pid`.
  - `findSessionSocket gives undefined for a session id with no file`.
  - `findSessionSocket ignores a socket path that is relative, over 1024 characters, or holds a NUL`.
  - `findSessionSocket never opens a .key file`. The fake `readHead` records every path. The test asserts that none ends in `.key`.
  - `readLiveSessions output has no socket path`. The JSON of the result must not contain the path.

  In `nudge.test.ts`, use real temp files and a real `net.createServer` socket in a temp folder. Write these tests:
  - `checkSocket ok for a socket owned by the given uid`.
  - `checkSocket refused for a symlink to a socket`.
  - `checkSocket refused for a regular file`.
  - `checkSocket refused for a FIFO`.
  - `checkSocket refused for a socket owned by another uid`. Pass `ownerUid + 1`.
  - `checkSocket refused for a path under a symlinked folder`.
  - `checkSocket refused for a missing path`.
- [ ] **Step 2: Run them and see them fail.** Run: `cd server && bun test src/livesessions.test.ts src/nudge.test.ts`. Expected: FAIL, the functions do not exist.
- [ ] **Step 3: Implement `findSessionSocket`.** Move the per-file parse and liveness checks of `readLiveSessions` into one internal function that yields `{ sessionId, info, updatedAt, socketPath? }`. `readLiveSessions` keeps its result type and drops `socketPath`. `findSessionSocket` picks the newest entry for the id.
- [ ] **Step 4: Implement `checkSocket`.** Use `lstat`: must not be a symlink, must be a socket, `uid` must equal `ownerUid`. Then `realpath(path)` must equal `path`. Any error gives `"refused"`.
- [ ] **Step 5: Run the tests.** Run: `cd server && bun test src/livesessions.test.ts src/nudge.test.ts`. Expected: PASS. Then run `bun test` for the whole server. Expected: no new failure.
- [ ] **Step 6: Commit.**

```bash
git add server/src/livesessions.ts server/src/nudge.ts server/src/livesessions.test.ts server/src/nudge.test.ts
git commit -m "feat(server): find a live session socket and check that it is the user's socket"
```

### Task 2: Build the message and send it

**Files:**
- Modify: `server/src/nudge.ts`, `server/src/index.ts`
- Test: `server/src/nudge.test.ts`

**Interfaces:**
- Consumes: `checkSocket`, `findSessionSocket` (Task 1), `Identity` from `asuser.ts`.
- Produces:
  - `type NudgeResult = { sent: true } | { sent: false; reason: "not_live" | "socket_refused" | "send_failed" | "unsupported" }`
  - `nudgeMessage(e: { list: "allow" | "ask" | "deny"; rule: string; path: string }): string`. The text is: `The user added the rule <JSON rule> to the <list> list in <path>. You can try the blocked action again. Do not change any settings.` The result has no newline.
  - `sendLine(socket: string, line: string, o?: { timeoutMs?: number }): Promise<void>`. It connects with `node:net`, writes `line + "\n"`, and ends. It rejects after `timeoutMs` (default 3000) or on any socket error.
  - `nudge(o: { home: string; sessionId: string; message: string; identity?: Identity; platform?: NodeJS.Platform; find?: typeof findSessionSocket; send?: (socket: string, line: string, identity?: Identity) => Promise<void> }): Promise<NudgeResult>`. The line is `JSON.stringify({ type: "user", message: { role: "user", content: message } })`. On `win32` it gives `unsupported` before any other work. The owner for `checkSocket` is `identity.uid`, else `process.getuid()`. Say `identity.uid` is set and differs from `process.getuid()`. Then the default `send` spawns `process.execPath nudge-send <socket>` through `setpriv`. Use `asUser` for the argument list. It writes the line to the child stdin and kills the child at 3 seconds. In every other case it calls `sendLine`.
  - `runNudgeSend(argv: string[], stdin: () => Promise<string>): Promise<number>`. It is the child entry. It reads one line from stdin, calls `sendLine`, and returns exit code 0 or 1. If `process.argv[2]` is `nudge-send`, `index.ts` calls it. The call comes before the config load, and the process exits with its code. On failure the child prints one fixed word and nothing else.

- [ ] **Step 1: Write the failing tests.** Write these tests:
  - `nudgeMessage has no newline for a rule with a quote, a backslash, and a unicode line separator`.
  - `nudgeMessage names the list, the rule, and the path`.
  - `sendLine writes one line to a real unix socket server`. The server records the data.
  - `sendLine rejects at the timeout`. Use `timeoutMs: 100` and a path that nothing listens on.
  - `nudge gives unsupported on win32 and never calls find`.
  - `nudge gives not_live when find gives undefined`.
  - `nudge gives socket_refused for a socket of another uid`. Use a fake `find`, a real socket, and an `identity.uid` that is not the owner.
  - `nudge gives sent for a good socket`. The server receives the exact JSON line.
  - `nudge gives send_failed when send rejects`.
  - `runNudgeSend sends the stdin line and returns 0`.
  - `runNudgeSend returns 1 for a missing argument`.
- [ ] **Step 2: Run them and see them fail.** Run: `cd server && bun test src/nudge.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the functions above in `nudge.ts`.** Add the `nudge-send` branch to `index.ts` next to `gen-secret`.
- [ ] **Step 4: Run the tests.** Run: `cd server && bun test src/nudge.test.ts`, then `bun test`. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add server/src/nudge.ts server/src/index.ts server/src/nudge.test.ts
git commit -m "feat(server): send a fixed message to a live session socket as the instance user"
```

### Task 3: The nudge flag on the node and hub routes

**Files:**
- Modify: `server/src/permissionsapi.ts`, `server/src/hosts.ts`
- Test: `server/src/permissionsapi.test.ts`, `server/src/hosts-sessions.test.ts`

**Interfaces:**
- Consumes: `nudge`, `nudgeMessage`, `NudgeResult` (Task 2).
- Produces:
  - `RuleEdit` gains `nudge: boolean`. `parseRuleEdit(body, scopes, o?: { allowNudge?: boolean })`: a missing `nudge` is false. A value that is not a boolean gives 400. `nudge: true` on a route with `allowNudge` false gives 400 ("nudge needs a session").
  - The node session add route gives `{ ...layer, nudge?: NudgeResult }`. The key `nudge` appears in one case only. The request had `nudge: true` and the add worked. A remove ignores the flag and never nudges. The instance routes (`/permissions/rules`) do not allow the flag.
  - `PermissionsApiDeps` gains `nudge?: typeof nudge` (tests replace it).
  - Node audit line gains ` nudge=<off|sent|not_live|socket_refused|send_failed|unsupported>` at the end. The value comes from the result, never from the request text. The line for a failed edit says `nudge=off`.
  - Hub audit line gains ` nudge=<on|off>` at the end. The value comes from the request flag. The hub forwards `nudge: true` only for a set flag. So an older node gets the same body as before.

- [ ] **Step 1: Write the failing tests.** For the node, write these tests:
  - `add with nudge true calls nudge after the write and returns it under the nudge key`.
  - `the nudge message holds the rule, the list, and the file path`.
  - `a 409 add with nudge true never calls nudge`.
  - `a 400 add never calls nudge`.
  - `a remove with nudge true never calls nudge`.
  - `the user route refuses nudge true with 400`.
  - `nudge with a non boolean value gives 400`.
  - `the answer and the audit line hold no socket path`. The fake `nudge` returns `{ sent: true }`. The fake `find` path is a unique string. The test searches the answer text and the log for it.
  - `audit line ends with nudge=sent`.
  - `audit line ends with nudge=off for a failed add`.

  For the hub, write these tests:
  - `forwards nudge true in the body`.
  - `omits the key when the flag is false`.
  - `audit line ends with nudge=on`.
  - `refuses a non boolean flag with 400 before any forward`.
- [ ] **Step 2: Run them and see them fail.** Run: `cd server && bun test src/permissionsapi.test.ts src/hosts-sessions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `edit()`, call `nudge` once, after `addRule` worked and only for `e.nudge`. Pass `{ home, sessionId: session.id, message: nudgeMessage({ list, rule, path: layer.path }), identity: h.identity }`. The `layer.path` is the path that `addRule` returned. A null path gives `send_failed`. A throw inside `nudge` becomes `send_failed`. It never changes the status of the add.
- [ ] **Step 4: Run the tests.** Run: `cd server && bun test`. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add server/src/permissionsapi.ts server/src/hosts.ts server/src/permissionsapi.test.ts server/src/hosts-sessions.test.ts
git commit -m "feat(server): nudge the session after a rule is added"
```

### Task 4: The sheet checkbox and the result

**Files:**
- Modify: `web/src/lib/features/permissions/api.ts`, `format.ts`, and `RuleSheet.svelte`.
- Modify: the parent that mounts the sheet for a blocked call. Find where `SessionPermissions.svelte` and `BlockedList.svelte` get the session. Pass `live: boolean` from the session summary (`s.live !== undefined`).
- Test: `api.test.ts`, `format.test.ts`, `RuleSheet.test.ts`

**Interfaces:**
- Consumes: the answer key `nudge` from Task 3.
- Produces:
  - `RuleEdit` (web) gains `nudge?: boolean`. `addRule` returns `Layer & { nudge?: NudgeResult }`. `NudgeResult` is the same union as the server type.
  - `format.ts`: `NUDGE_LABEL = "Tell the session to try again"`, `NUDGE_SENT = "Sent to the session. It may still wait for you to approve the message."`, `nudgeFailure(reason): string` with one text for each reason (`not_live`: "The session is not running, so it was not told." and so on). `RETRY_NOTE` is removed.
  - `RuleSheet.svelte` gets a new prop `live?: boolean`. In add mode, the sheet shows a checkbox with `NUDGE_LABEL`. The sheet needs a `call` and a `session` for that. If `live` is true, the box is on by default. If `live` is false, the box is off and disabled. The sheet then shows the text "The session is not running." A save that answers with a `nudge` key keeps the sheet open. The sheet then shows the result line (`role="status"`) and a Close button. A save without the flag closes the sheet as before.

- [ ] **Step 1: Write the failing tests.** `api.test.ts`: `addRule sends nudge true in the body`. `format.test.ts`: `nudgeFailure has a text for each reason`. `RuleSheet.test.ts`: `shows the checkbox on for a live session`, `shows it off and disabled for a session that is not live`, `has no checkbox in remove mode`, `has no checkbox without a blocked call`, `save sends nudge true when the box is on`, `save sends no nudge when the box is off`, `shows the sent text and keeps the sheet open`, `shows the failure text when the answer says not_live`, `the result text never says received` (assert the text does not match `/receiv/i`).
- [ ] **Step 2: Run them and see them fail.** Run: `cd web && bunx vitest run src/lib/features/permissions`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use the existing checkbox style of the sheet (`size-4 w-auto shrink-0 accent-primary`, a label with `min-h-11`). Keep the result line in the same wrap classes as the other notes.
- [ ] **Step 4: Run the tests and the check.** Run: `cd web && bunx vitest run && bun run check`. Expected: PASS and 0 errors. The boundary test must still pass.
- [ ] **Step 5: Commit.**

```bash
git add web/src/lib/features/permissions
git commit -m "feat(web): tell the session to try again after a rule is saved"
```

### Task 5: A live check and the docs

**Files:**
- Modify: `docs/superpowers/specs/2026-11-14-permissions-design.md` (the status line), `docs/superpowers/followups/2026-11-14-permissions-deferred.md`
- Create: none in the repo. The check script lives in `/tmp`.

- [ ] **Step 1: Run the whole loop on the real node code.** Use a throwaway home and a temp git folder.
  - Start `claude -p --input-format stream-json --permission-mode default` with a prompt that runs `touch`. The spike recipe is in the memory file `permissions-spike-results`.
  - When the call is denied, send `POST /instances/:id/sessions/:sid/permissions/rules` with `nudge: true` to a node built from the branch.
  - Expected: the answer has `nudge: { sent: true }` and the session runs the command.
  - If the machine has no credentials, run the same check with a fake socket server. Write down which check ran.
- [ ] **Step 2: Run the refusal checks by hand.** Point a session file at a symlink to a socket, then at a root-owned socket. Expected: `socket_refused`, and the server shows no connect.
- [ ] **Step 3: Update the docs.** Set the spec status line to say that Phase 3 is built. Add these items to the deferred list:
  - The Windows named pipe. It needs the token and a decision on the `.key` file.
  - The busy-session behavior. No test covers it.
  - A nudge after a remove. This is not done on purpose.
  - Anything the live check showed.
- [ ] **Step 4: Run all tests.** Run: `cd server && bun test` and `cd web && bunx vitest run && bun run check`. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add docs/superpowers
git commit -m "docs(permissions): record the nudge and what is left"
```

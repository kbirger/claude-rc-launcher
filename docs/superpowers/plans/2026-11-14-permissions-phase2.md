# Permissions Phase 2 (edit) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user adds, changes, and removes permission rules in three settings files. The user also adds a rule from a blocked call with one tap and a confirmation.

**Architecture:** A shared safe writer in `safefile.ts` does the atomic write with a hash check. `trust.ts` uses it too. `SettingsFile` gets `addRule` and `removeRule`. `permissionsapi.ts` gets POST and DELETE routes, and the hub forwards them. The web feature gets a confirm sheet. The rule list and the blocked list open the sheet. Nudge (tell the session to retry) is Phase 3 and is not in this plan.

**Tech Stack:** Bun, Hono, and bun:test on the server. Svelte 5, TanStack Query, shadcn, Bits UI, and vitest on the web.

**Spec:** `docs/superpowers/specs/2026-11-14-permissions-design.md`. Phase 1 plan: `docs/superpowers/plans/2026-11-14-permissions-phase1.md`.

## Global Constraints

- The node never runs a blocked action.
- The node writes no rule without a user tap. The confirmation shows the exact file path, the list, and the rule.
- The node never reads, logs, or returns `peerToken` or the `.key` file.
- A bad write never leaves a broken file or a file with the wrong owner.
- The write uses a temp file in the same folder. The temp file has a random name, opens with `wx` and mode 0600, gets the old mode and the owner through the handle, and then replaces the file with `rename`.
- Settings files are strict JSON. A write keeps unknown keys, key order, and the indent found (default two spaces). The file ends with one newline.
- The editor changes only `permissions.allow`, `permissions.ask`, and `permissions.deny`.
- Writable scopes are `user`, `project`, and `local`. The scopes `managed` and `legacy-local` are read-only.
- A layer in state `unknown-path` or `invalid` refuses a write and gives the reason.
- A missing file is created only in a folder that exists and that the instance user owns.
- The request carries the hash that the user loaded (`null` for a missing file). A different hash gives 409.
- The size cap `MAX_FILE_BYTES` (1 MiB) applies to the new content.
- A rule has at most 2000 characters, has no control characters, and passes `parseRule`.
- User-visible text has no contractions and no em-dashes.

## Rulings made while planning

- **Symlinks.** A write goes through the link. The writer changes the real file (`resolvedPath`) and the link stays. The temp file lives in the folder of the real file. That folder must belong to the instance user, or the write gives 403. If wrong, a user cannot ask to replace the link. One gap remains. A user can swap a folder for a symlink between the check and the `rename`, because Node has no `renameat`. `trust.ts` has the same gap. The planted file belongs to the instance user and holds only settings JSON.
- **Audit.** The hub writes `audit user=<hub user> host=<id> action=<add|remove> instance=<id> scope=<scope> list=<list> rule=<rule> status=<n>` after the node answers. The node writes `audit caller=<caller> instance=<id> scope=<scope> action=<add|remove> list=<list> rule=<rule> status=<n>`. No line holds file content. The hub does not send its user to the node.
- **No retry checkbox.** The sheet has no nudge option until Phase 3. It tells the user that the session needs a message to try again.
- **Trust warning.** Allow rules in the shared project file work only in a trusted folder. `PinnedRoot` has no trust call today. The sheet shows only the "tracked file" warning for the project file. The trust warning is a deferred minor.

## Review Focus

- Claude Code edits a file between the load and the save. The save gives 409 and the file stays as it was (Tasks 2, 3, 4).
- A file has a 4-space or tab indent, unknown keys, and a special key order. Only the permission list changes (Task 3).
- A rule that is already in the list is not added twice. Removal of an absent rule gives 404 (Tasks 3, 4).
- A symlinked settings file stays a symlink after a write. A link to a file of another user is refused (Task 2).
- A privileged node keeps the old mode and sets the right owner (Task 2).
- The text of a blocked call never enters a log line. Only the confirmed rule does (Tasks 4, 6).
- Two adds to one file at the same time lose no update (Task 2).

---

### Task 1: Spike, does an allow rule clear an auto mode denial?

**Files:**
- Create: `scripts/spike-classifier.sh` (throwaway)
- Modify: the spec, section "What the spike proved" (one paragraph)
- Memory: `permissions-spike-results.md`

**Interfaces:**
- Produces: a recorded answer (yes, no, or inconclusive). Task 6 uses it in the classifier warning.

- [ ] **Step 1:** In a temp git folder, start `claude -p --permission-mode auto`. Ask for a command that the classifier likely denies. Use no real credentials and no production files.
- [ ] **Step 2:** If the classifier denies the call, find the denial in the transcript. Write the matching `allow` rule to the local settings file of the temp folder. Send the retry message through the session inbox socket, as in the earlier spike.
- [ ] **Step 3:** Record the result. The command was still denied, or it ran, or the classifier never denied.
- [ ] **Step 4:** Write the result in the spec and in the memory file. Delete the temp folder and the script.
- [ ] **Step 5: Commit** `docs: record whether an allow rule clears a classifier denial`.

Expected: a one-paragraph answer. An inconclusive result keeps the warning. This task never blocks the others.

---

### Task 2: The safe writer in `safefile.ts`

**Files:**
- Modify: `server/src/safefile.ts`, `server/src/trust.ts`
- Test: `server/test/safefile.test.ts`, `server/test/trust.test.ts` (stays green)

**Interfaces:**
- Consumes: `readUserFile` from the same file.
- Produces:
  ```ts
  export class FileConflict extends Error {}
  export class FileRefused extends Error { constructor(readonly reason: string) }
  export type WriteOpts = {
    ownerUid?: number; gid?: number;
    /** Hash from `readUserFile` that the caller saw, or null for "missing". Omit to skip the check. */
    expectedHash?: string | null;
    follow?: boolean; // write the real file behind a symlink
    chown?: (fh: FileHandle, uid: number, gid: number) => Promise<void>; // tests
    isRoot?: () => boolean; // tests
  };
  export function writeUserFile(file: string, bytes: Buffer, o?: WriteOpts): Promise<{ hash: string; realPath: string }>;
  ```
  The writer runs one write at a time for each real path.

- [ ] **Step 1: Write the failing tests** in `safefile.test.ts`, one for each behavior:
  - a new file gets mode 0600.
  - an existing file keeps its mode.
  - `chown` runs with the uid and gid only when `isRoot()` is true.
  - a stale `expectedHash` throws `FileConflict`, and the file and the folder stay unchanged (no `.tmp` left).
  - `expectedHash: null` against an existing file throws `FileConflict`.
  - with `follow`, a symlink stays a symlink and the target changes.
  - a link to a file of another owner throws `FileRefused`.
  - a real folder of another owner throws `FileRefused`.
  - content over `MAX_FILE_BYTES` throws `FileRefused`.
  - a hard-linked file throws `FileRefused`.
  - two parallel writes with the same hash give one success and one `FileConflict`.
  - a failed rename removes the temp file.
- [ ] **Step 2:** Run `cd server && bun test test/safefile.test.ts`. Expected: FAIL, `writeUserFile` is not exported.
- [ ] **Step 3: Implement `writeUserFile`.** Inside the queue, read again with `readUserFile` (same `follow` and `ownerUid`) and compare the hash. Check the folder with `lstat` just before the open. Then use the temp-file steps of `addOne` in `trust.ts`.
- [ ] **Step 4:** Change `trust.ts` `addOne` to call `writeUserFile`. Remove its own queue if the new queue covers it. The behavior of `trust.ts` stays the same.
- [ ] **Step 5:** Run `cd server && bun test test/safefile.test.ts test/trust.test.ts`. Expected: PASS, no warnings.
- [ ] **Step 6: Commit** `feat(server): shared safe writer with a hash check`.

---

### Task 3: Rule edits in `permrules.ts` and `SettingsFile`

**Files:**
- Modify: `server/src/permrules.ts`, `server/src/settingsfile.ts`
- Test: `server/test/permrules.test.ts`, `server/test/settingsfile.test.ts`

**Interfaces:**
- Consumes: `writeUserFile`, `readUserFile`, `FileConflict`, `FileRefused` (Task 2), and `parseRule`.
- Produces in `permrules.ts` (pure, no I/O):
  ```ts
  export function detectIndent(text: string): string | number; // default 2
  export function withRule(text: string | null, list: RuleList, raw: string): { text: string; changed: boolean };
  export function withoutRule(text: string, list: RuleList, raw: string): { text: string; changed: boolean };
  ```
  `withRule(null, …)` builds `{"permissions":{"<list>":[raw]}}`. Both functions keep unknown keys, key order, and the other lists. They create `permissions` or the list when it is missing. The text ends with a newline. A duplicate gives `changed: false`.
- Produces in `settingsfile.ts`:
  ```ts
  export class SettingsError extends Error { constructor(readonly status: 400 | 403 | 404 | 409 | 422, message: string) }
  // on SettingsFile
  addRule(o: { list: RuleList; raw: string; expectedHash: string | null }): Promise<Layer>;
  removeRule(o: { list: RuleList; raw: string; expectedHash: string }): Promise<Layer>;
  // on ClaudeSettings
  file(scope: LayerScope): SettingsFile | undefined;
  ```
  `writable` is true for `user`, `project`, and `local` when the path is known. Both methods return the layer read back after the write.
  Errors: `unknown-path`, `managed`, and `legacy-local` give 403 with a reason. State `invalid` gives 422. A hash mismatch gives 409. Bad rule text gives 400. A rule that is not present on remove gives 404.

- [ ] **Step 1: Write the failing `permrules` tests:**
  - a 4-space file keeps 4 spaces after an add.
  - a tab-indented file keeps tabs.
  - unknown keys and key order stay.
  - a missing `permissions` key is created.
  - a duplicate gives `changed: false` and the same text.
  - `withRule(null, …)` gives a two-space document with a trailing newline.
  - removing the last rule leaves an empty list, not a missing key.
  - removing an absent rule gives `changed: false`.
  - a document root that is not an object throws.
- [ ] **Step 2:** Run `bun test test/permrules.test.ts`. Expected: FAIL, the functions are missing.
- [ ] **Step 3: Implement** the three functions with `JSON.parse` and `JSON.stringify(doc, null, indent)`. Edit the object in place so key order survives.
- [ ] **Step 4: Write the failing `settingsfile` tests** in a temp folder:
  - an add, then a read, shows the rule with a new hash.
  - a stale `expectedHash` gives `SettingsError` 409 and the file stays unchanged.
  - `expectedHash: null` creates a missing file.
  - `managed`, `legacy-local`, and `unknown-path` give 403.
  - an `invalid` file gives 422 and is not overwritten.
  - bad rule text gives 400.
  - a symlinked file stays a symlink after an add.
  - removing an absent rule gives 404.
- [ ] **Step 5:** Run `bun test test/settingsfile.test.ts`. Expected: FAIL.
- [ ] **Step 6: Implement** `addRule`, `removeRule`, `ClaudeSettings.file`, and the `writable` flag. The write target is `resolvedPath` when the read had one. The new text passes the same size and JSON checks as a read.
- [ ] **Step 7:** Run `bun test test/permrules.test.ts test/settingsfile.test.ts`. Expected: PASS.
- [ ] **Step 8: Commit** `feat(server): add and remove permission rules in a settings file`.

---

### Task 4: Node routes, hub routes, and audit lines

**Files:**
- Modify: `server/src/permissionsapi.ts`, `server/src/pinnedroot.ts`, `server/src/sessioncatalog.ts`, `server/src/hosts.ts`
- Test: `server/test/permissionsapi.test.ts`, `server/test/hosts-sessions.test.ts`, `server/test/sessionwiring.test.ts`

**Interfaces:**
- Consumes: `ClaudeSettings.file`, `SettingsFile.addRule/removeRule`, `SettingsError`.
- Produces on the node, mounted at `/instances/:id`:
  - `POST /permissions/rules` and `DELETE /permissions/rules` (scope `user` only).
  - `POST /sessions/:sid/permissions/rules` and `DELETE /sessions/:sid/permissions/rules` (scopes `user`, `project`, `local`).
  - The body is `{ scope, list, rule, expectedHash }`. The answer is the updated `Layer`. A `SettingsError` becomes its status with `{ error }`.
  - A new `Session.settings({ownerUid})` returns the `ClaudeSettings` of the pinned root. `permissions()` uses it.
  - The audit line goes through a log sink that a test can replace (default `console.log`).
- Produces on the hub: the same four routes under `/hosts/:host/…`, with `forwardJson`. The hub checks the body first. `scope` and `list` must be in their sets. `rule` must be a string that passes the rule limits. `expectedHash` must be a string or null. The hub writes its own audit line.

- [ ] **Step 1: Write the failing node tests:**
  - an add through the user route reads back.
  - an add through the session route to `local` writes at the git root path.
  - scope `managed` gives 403.
  - a bad scope or list gives 400.
  - a stale hash gives 409 and the file stays unchanged.
  - the audit line has the rule and no file content.
  - a session outside the instance gives 404.
- [ ] **Step 2: Write the failing hub tests** in `hosts-sessions.test.ts`:
  - the four routes forward body and status.
  - an invalid body gives 400 and nothing is forwarded.
  - the hub audit line has the user and the rule.
  Add the four routes to the mutation check in `sessionwiring.test.ts`.
- [ ] **Step 3:** Run `bun test test/permissionsapi.test.ts test/hosts-sessions.test.ts test/sessionwiring.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** the node routes and the hub routes. The node middleware already enforces JSON-only writes.
- [ ] **Step 5:** Run the same command. Expected: PASS.
- [ ] **Step 6: Commit** `feat(server): routes to add and remove permission rules`.

---

### Task 5: Suggested rules from a blocked call

**Files:**
- Create: `web/src/lib/features/permissions/suggest.ts` (pure)
- Test: `web/src/lib/features/permissions/suggest.test.ts`

The web app has the call input already, so the suggestion runs there. It never reaches a log.

**Interfaces:**
- Consumes: `BlockedCall` from `api.ts`.
- Produces:
  ```ts
  export type Suggestion = { raw: string; label: string; broad: boolean; note?: string };
  export function suggestRules(call: BlockedCall): Suggestion[];
  ```
  The first item is the exact rule. `broad` is true for a wildcard rule.
  - `Bash`: split the command on `&&`, `||`, `;`, `|`, and newline outside quotes. Each part gets an exact rule `Bash(<part>)` and a prefix rule such as `Bash(git log *)`. The prefix is the first word, or the first two words for `git`, `npm`, `bun`, `docker`, and `kubectl`.
  - `Edit`, `Write`, `Read`, `NotebookEdit`: `Tool(<file_path>)`.
  - `WebFetch`: `WebFetch(domain:<host>)`.
  - Names that start with `mcp__`, and other tools: the bare tool name.

- [ ] **Step 1: Write the failing tests** with exact expected arrays:
  - `git log --oneline -5` gives the exact rule and `Bash(git log *)`.
  - `cd a && npm test` gives rules for two parts.
  - an `&&` inside quotes is not a split.
  - a path with spaces stays whole.
  - a `WebFetch` URL gives its domain.
  - `mcp__srv__tool` gives the bare name.
  - an unknown tool gives the bare tool.
  - an empty command gives no suggestion.
  - a command with a control character gives no suggestion.
- [ ] **Step 2:** Run `cd web && bun run test -- suggest` (use the vitest command in `web/package.json`). Expected: FAIL.
- [ ] **Step 3: Implement** `suggestRules`. The user sees and edits the text. The node checks it with `parseRule`.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): suggest permission rules for a blocked call`.

---

### Task 6: Web mutations and the confirm sheet

**Files:**
- Modify: `web/src/lib/features/permissions/api.ts`, `queries.ts`, `index.ts`, `format.ts`
- Create: `mutations.ts`, `RuleSheet.svelte`, `RuleSheet.test.ts` (and a harness if the sheet needs a query client, as `BlockedListHarness.svelte` does)
- Test: `api.test.ts`, `format.test.ts`

**Interfaces:**
- Consumes: the node routes of Task 4, `Layer` (`writable`, `hash`, `path`, `resolvedPath`), and `suggestRules` (Task 5).
- Produces:
  ```ts
  export type RuleEdit = { scope: "user" | "project" | "local"; list: "allow" | "ask" | "deny"; rule: string; expectedHash: string | null };
  export const addRule = (host, instance, session: string | undefined, e: RuleEdit) => request<Layer>("POST", …);
  export const removeRule = (host, instance, session: string | undefined, e: RuleEdit) => request<Layer>("DELETE", …);
  export const addRuleMutation(host, instance, session, client);    // invalidates permission and blocked queries
  export const removeRuleMutation(host, instance, session, client);
  // RuleSheet props: { open, host, instance, session?, layers: Layer[], mode: "add" | "remove", initial?: { raw, list }, call?: BlockedCall }
  ```
  The mutations follow `features/instances/mutations.ts`. A `session` of `undefined` uses the user routes and offers only the user file.

The sheet shows these parts:
- A file picker with only writable layers in state `ok` or `missing`. Each shows its path, and the real path for a link.
- The list (Allow, Ask, Deny).
- The rule field. It starts with the first suggestion when a call is given. The other suggestions are chips, and a wildcard rule has a "broad" label.
- A confirmation line: "Add `<rule>` to Allow in `<path>`".

The sheet adds these warnings:
- User file: "This applies to every project of this user."
- Project file: "This changes a file that git tracks. You must commit it."
- `user_rejected` call: an extra tap first.
- `classifier` call: the Task 1 result.
- Status 409: "The file changed. Reload." The sheet then fetches the layers again.

An `unknown-path` file shows its reason and offers no write.

- [ ] **Step 1: Write the failing tests:**
  - `api.test.ts`: URL, method, and body, with and without a session.
  - `format.test.ts`: the warning helpers.
  - `RuleSheet.test.ts`: only writable layers are offered. the confirm line shows the exact path and rule. the user and project warnings show. the edited text is what the sheet sends. the save button is off for an empty rule. a 409 shows the reload message. after success the sheet closes and the queries are invalidated.
- [ ] **Step 2:** Run `cd web && bun run test -- permissions`. Expected: FAIL.
- [ ] **Step 3: Implement** the API functions, the mutations, the helpers, and `RuleSheet.svelte`.
- [ ] **Step 4:** Run again. Expected: PASS. Then run `bun run check` for types and the boundary test.
- [ ] **Step 5: Commit** `feat(web): confirm sheet to add and remove a permission rule`.

---

### Task 7: Use the sheet from the lists and the instance page

**Files:**
- Modify: `RuleList.svelte`, `BlockedList.svelte`, `SessionPermissions.svelte`, `PermissionsPage.svelte`, their tests, and `format.ts`

**Interfaces:**
- Consumes: `RuleSheet`, `suggestRules`, `Layer.writable`.
- Produces: `probablyFixed(call: BlockedCall, layers: Layer[]): boolean` in `format.ts`. It is true when an `ok` layer has an allow rule that equals the exact suggestion or is a prefix match of the call, and no deny or ask rule overrides it.

Behavior:
- `RuleList` has an "Add rule" button. A tap on a rule opens the sheet in `remove` mode with one row for each file that holds the rule. A rule from a read-only layer has no remove.
- `BlockedList` shows an "Allow..." button on `needs_approval`, `user_rejected`, and `classifier` calls. The button opens the sheet with `call` set.
- A `deny_rule` call shows the rule that denied it and its file. It has no button. A `safety_check` call has no button.
- A call that `probablyFixed` shows a "probably fixed" mark and keeps its button.
- `PermissionsPage` shows the user file with the same list and sheet, and `session` is undefined.

- [ ] **Step 1: Write the failing tests:**
  - the Allow button shows on a `needs_approval` call and not on `deny_rule` or `safety_check`.
  - a `user_rejected` call needs a second tap.
  - a call with a matching allow rule shows "probably fixed".
  - a rule from `managed` has no remove.
  - the Add rule button opens the sheet.
  - the page for the user file uses the user routes.
  - `probablyFixed` cases in `format.test.ts`: exact match, prefix match, and shadowed by deny gives false.
- [ ] **Step 2:** Run `cd web && bun run test -- permissions`. Expected: FAIL.
- [ ] **Step 3: Implement** the UI changes. The sheet stays closed and fetches nothing until it opens.
- [ ] **Step 4:** Run again, then `bun run test` (the whole web suite) and `bun run check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): add and remove rules from the rule list and the blocked list`.

---

### Task 8: Whole-suite run, a manual check, and notes

**Files:**
- Modify: the spec (status line), `permissions-phase1-branch.md`, `MEMORY.md`

- [ ] **Step 1:** Run `cd server && bun test`, then `cd web && bun run test && bun run check`. Expected: all pass. Report any failure by name.
- [ ] **Step 2: Manual check** in a throwaway folder with a real `claude -p` session in default mode. Open the web app on a local node and find the blocked call. Tap Allow and confirm. Check that the local file has the rule and that its indent and keys are as before. Send a message through the inbox socket, as in the spike, and check that the session retries. Repeat with a symlinked user file. Repeat with a file that you edit by hand between the load and the save (expect the reload message).
- [ ] **Step 3:** Update the spec status and the memory files. Do not merge or deploy without asking.
- [ ] **Step 4: Commit** `docs: phase 2 status`.

## Self-review notes

- Spec coverage: three writable files (Tasks 2, 3, 4), conflict check (Tasks 2, 3), keys and indent (Task 3), suggested rules (Task 5), confirmation and warnings (Task 6), audit log (Task 4), add from a blocked call and buttons by reason (Task 7), "probably fixed" (Task 7), classifier test first (Task 1).
- Out of scope: nudge, the Windows node, the trust warning for the project file, and the `.claude.json` gap in `trust.ts`.

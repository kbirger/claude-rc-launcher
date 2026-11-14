# Permissions Phase 1 (Read-Only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the permission rules that apply to a session and an instance, and the tool calls that were blocked, in the web app. Nothing in this phase writes a file or messages a session.

**Architecture:** The model grows along the existing chain `SessionCatalog`, `InstanceSessions`, `Session`, `PinnedRoot`. `Session` gets two methods, `blocked()` and `permissions()`, next to `touched()`. A new class `SettingsFile` is one settings file. A new class `ClaudeSettings` is the set of files that apply to one home or one session. One safe-open function, `readUserFile`, serves `SettingsFile` and `fileTrust`. The routes call the session, as the file routes do. The hub forwards the routes. The web app adds two session tabs and one instance page. Phase 2 adds writing to `SettingsFile`. Phase 3 adds the message to the session.

**Tech Stack:** Bun, TypeScript, Hono (server). Svelte 5, TanStack Query, shadcn and Bits UI (web). Tests: `bun test` (server) and vitest (web).

**Spec:** `docs/superpowers/specs/2026-11-14-permissions-design.md`

## Global Constraints

- Setup: run `export PATH=$HOME/.bun/bin:$PATH`. Work on a new branch `feat/permissions` made from `main`.
- Check before each commit: `bun test server ./cli`, `bun run typecheck`, `bun run --cwd web check`, `bun run --cwd web test`.
- Files in scope: `~/.claude/settings.json` (user), `<start folder>/.claude/settings.json` (shared project), `<git root>/.claude/settings.local.json` (local project), the legacy `<start folder>/.claude/settings.local.json` (read-only), and the managed file (read-only, Linux path `/etc/claude-code/managed-settings.json`).
- Rule lists are `permissions.allow`, `permissions.ask`, and `permissions.deny`. Order of effect is deny, then ask, then allow. The first match wins.
- Settings files are strict JSON. The read cap is 1 MiB (`MAX_FILE_BYTES` in `safefile.ts`, the old `MAX_DOC_BYTES` of `trust.ts`).
- The messaging token and the socket path never leave the node. This phase does not read them.
- Windows: the Windows node has no new routes. The web app treats a 404 or 501 as "not supported" with `isUnsupported`.
- The node runs as a service account. The instance user owns the files, so every read treats the path as hostile (no symlink, no hard link, no FIFO, size cap).
- Commit messages use the style `feat(permissions): ...`. Do not add a model name to a commit.

## Review Focus

- A settings file that is not valid JSON: the layer shows an error reason and the other layers still show.
- A settings file or its `.claude` folder that is a symlink, a hard link, or a FIFO: refused with a reason, never followed, and the node does not hang.
- `permissions.allow` that is not an array, or has non-string entries: the layer shows the valid rules and a warning.
- A blocked call whose result text is unknown: not listed. A command that failed with `is_error: true` but no denial text: not listed.
- A transcript with a line over 1 MB or a half-written last line: the scan keeps what it read.
- A session folder that is not in a git repository, is the home folder, or is a git work tree: the local file path is `unknown` and the layer says why. The route still answers 200.
- A deny rule and an allow rule for the same tool: the allow rule is marked `shadowedBy` the deny rule.
- A rule string with parentheses or a wildcard inside the specifier, for example `Bash(echo (a) *)`: parsed by the first `(` and the last `)`.

---

## File Structure

- Create `server/src/safefile.ts`: `readUserFile`, the one safe open of a user-controlled file, taken out of `trust.ts`. It reads bytes. It does not parse JSON.
- Create `server/src/permrules.ts`: pure helpers to parse and format a rule, flatten a document into rules, and mark shadowed rules.
- Create `server/src/settingsfile.ts`: the class `SettingsFile` (one file) and the class `ClaudeSettings` (the files of one home or one session).
- Create `server/src/blocked.ts`: the pure helper `blockedIn`, which scans one transcript, as `touched.ts` does for `touchedIn`.
- Modify `server/src/sessioncatalog.ts`: add `Session.blocked()` and `Session.permissions()`.
- Create `server/src/permissionsapi.ts`: the node routes, thin like `sessionapi.ts`.
- Modify `server/src/trust.ts`: use `safefile.ts`. Modify `server/src/app.ts` to mount the routes. Modify `server/src/hosts.ts` to forward them.
- Create `web/src/lib/features/permissions/` with `api.ts`, `queries.ts`, `RuleList.svelte`, `BlockedList.svelte`, `PermissionsPage.svelte`, `index.ts`. Modify `web/src/lib/features/sessions/SessionView.svelte` and `web/src/routes/`.
- Tests next to the existing ones: `server/test/*.test.ts`, `web/src/lib/features/permissions/*.test.ts`.
- Not changed on purpose: `sessionfs.ts` and `pinnedroot.ts`. They serve files inside the session folder. Settings files can sit outside it (the home folder, or a git root above the session folder), so they need their own safe open.

---

### Task 1: One safe open for user-controlled files

**Files:**
- Create: `server/src/safefile.ts`
- Modify: `server/src/trust.ts` (the `ReadResult` type and `readDoc`, about lines 40 to 90)
- Test: `server/test/safefile.test.ts` (new). `server/test/trust.test.ts` must still pass without changes.

**Interfaces:**
- Produces:
  ```ts
  export const MAX_FILE_BYTES = 1024 * 1024
  export type FileRead =
    | { kind: "missing" }
    | { kind: "invalid", reason: string }
    | { kind: "ok", bytes: Buffer, mode: number, hash: string, mtimeMs: number }
  export function readUserFile(file: string): Promise<FileRead>
  ```
  `hash` is the SHA-256 hex of the exact bytes read. Phase 2 uses it for the conflict check. The function reads bytes only. Each caller parses the JSON.

- [ ] **Step 1: Write the failing tests** in `server/test/safefile.test.ts` with a temp folder. Names and assertions: `missing file gives kind missing`. `regular file gives ok with the bytes, a 64 character hash and the mode`. `a symlink gives invalid with reason "it is a symlink"`. `a hard link gives invalid with reason "it has more than one link"`. `a FIFO gives invalid "it is not a regular file" and returns within 1 second`. `a file over 1 MiB gives invalid "it is too large"`. `the same bytes give the same hash`.
- [ ] **Step 2: Run** `bun test server/test/safefile.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `readUserFile` by moving the open and read part of `readDoc` out of `trust.ts` unchanged. Add `hash` with `createHash("sha256")` from `node:crypto`, and `mtimeMs` from the handle stat.
- [ ] **Step 4: Change `trust.ts`.** `readDoc` calls `readUserFile`, then parses the bytes as JSON and keeps its own `invalid` reasons for a non-object and for bad JSON. Keep the behavior and the error texts.
- [ ] **Step 5: Run** `bun test server/test/safefile.test.ts server/test/trust.test.ts` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `refactor(trust): move the safe open of a user file to safefile.ts`.

---

### Task 2: Rule parser and shadow marks

**Files:**
- Create: `server/src/permrules.ts`
- Test: `server/test/permrules.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type RuleList = "allow" | "ask" | "deny"
  export type ParsedRule = { tool: string, specifier?: string }
  export function parseRule(raw: string): ParsedRule | undefined, // undefined for "" or a malformed rule
  export function formatRule(r: ParsedRule): string
  export type Rule = { raw: string, list: RuleList, tool: string, specifier?: string }
  export function rulesOf(doc: Record<string, unknown>): { rules: Rule[], warnings: string[] }
  export type MarkedRule = Rule & { scope: string, shadowedBy?: { scope: string, list: "ask" | "deny", raw: string } }
  export function markShadowed(layers: { scope: string, rules: Rule[] }[]): MarkedRule[]
  ```

- [ ] **Step 1: Write the failing tests.** `parseRule("Bash(git log *)")` gives `{tool:"Bash", specifier:"git log *"}`. `parseRule("Bash")` gives `{tool:"Bash"}`. `parseRule("Bash(echo (a) *)")` gives specifier `echo (a) *` (first `(`, last `)`). `parseRule("mcp__srv__tool")` gives a bare tool. `parseRule("")`, `parseRule("Bash(")` and `parseRule("(x)")` give undefined. `formatRule(parseRule(x)) === x` for each valid sample. `rulesOf` on `{permissions:{allow:["A", 3, "B(x)"], deny:"nope"}}` gives rules A and B(x) in `allow` and two warnings (one for the number, one for `deny` not being an array). `markShadowed`: an `allow` rule `Bash(git log *)` in scope `local` with a `deny` rule `Bash(git log *)` in scope `user` gets `shadowedBy` set to that deny rule. An `allow` rule with no equal deny or ask rule has no `shadowedBy`. Matching is exact string equality of `raw`, plus a bare `Tool` deny or ask that shadows every `Tool(...)` allow of the same tool. Layers are given highest precedence first, and the deny, ask, allow order applies across all layers.
- [ ] **Step 2: Run** `bun test server/test/permrules.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the four functions** in `permrules.ts`. Matching stays this simple on purpose (spec non-goal: no full matcher).
- [ ] **Step 4: Run** the test and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(permissions): parse permission rules and mark shadowed ones`.

---

### Task 3: SettingsFile and ClaudeSettings

**Files:**
- Create: `server/src/settingsfile.ts`
- Test: `server/test/settingsfile.test.ts`

**Interfaces:**
- Consumes: `readUserFile` (Task 1), `rulesOf`, `markShadowed`, `Rule`, `MarkedRule` (Task 2).
- Produces:
  ```ts
  export type LayerScope = "user" | "project" | "local" | "legacy-local" | "managed"
  export type Layer = {
    scope: LayerScope
    path: string | null            // null when the node cannot tell where Claude Code puts the file
    writable: boolean              // false for every layer in Phase 1
    state: "ok" | "missing" | "invalid" | "unknown-path"
    reason?: string                // for invalid and unknown-path
    hash?: string
    rules: MarkedRule[]
    warnings: string[]
  }
  export type PermissionLayers = { layers: Layer[] }

  export class SettingsFile {
    constructor(readonly scope: LayerScope, readonly path: string | null, opts?: { writable?: boolean, unknownReason?: string })
    /** Never throws. A bad file gives state "invalid" with a reason. */
    read(): Promise<Layer>
  }

  export class ClaudeSettings {
    static forHome(o: { home: string }): ClaudeSettings
    static forSession(o: { home: string, root: string, ownerUid?: number, platform?: NodeJS.Platform }): Promise<ClaudeSettings>
    readonly files: readonly SettingsFile[]   // highest precedence first: managed, local, legacy-local, project, user
    layers(): Promise<PermissionLayers>        // reads every file, then runs markShadowed over the layers
  }
  ```
  Phase 2 adds `addRule` and `removeRule` to `SettingsFile`. The write code lives in the class, next to `read()`.

- [ ] **Step 1: Write the failing tests** with a temp folder as `home` and as the session `root`. Cases: `forHome` with a user file with two allow rules gives one layer, scope `user`, state `ok`, two rules. No files gives each state `missing` and no throw. `.claude/settings.json` with broken JSON gives state `invalid` for `project` while `user` and `local` still show. A folder with `.git` as a directory above the root gives the `local` path at that git root. A folder with no `.git` anywhere up to `home` gives `local` state `unknown-path` with a reason. A `.git` that is a file (work tree) gives `unknown-path` with reason `"this is a git work tree"`. A `.claude` folder that is a symlink gives `invalid` with reason `"the .claude folder is a symlink"`. A file at the legacy place and one at the git root both show. A `deny` in `user` marks an `allow` in `local` as shadowed. With `ownerUid` set, a file owned by another uid gives `invalid` with reason `"owned by another user"`.
- [ ] **Step 2: Run** `bun test server/test/settingsfile.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `SettingsFile.read()`.** Use `lstat` on the parent `.claude` folder (a symlink gives `invalid`). Then call `readUserFile` and parse the bytes. Pass the document to `rulesOf`.
- [ ] **Step 4: Implement `ClaudeSettings.forSession`.** Find the git root by walking up from `root` with `lstat` on `.git`. Stop at `home` or the file system root. No folder on the walk may be a symlink. On Linux (`platform` is `linux`, default `process.platform`), add the managed file `/etc/claude-code/managed-settings.json` with `writable: false`.
- [ ] **Step 5: Run** the test and `bun run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(permissions): SettingsFile and ClaudeSettings classes`.

---

### Task 4: Blocked tool call scan

**Files:**
- Create: `server/src/blocked.ts`
- Create: `server/test/fixtures/blocked/` (real, anonymised transcript lines, see Step 1)
- Test: `server/test/blocked.test.ts`

**Interfaces:**
- Consumes: `parse` from `server/src/transcript.ts`, `TranscriptFs` from `server/src/transcriptfs.ts`. `blockedIn` is a pure helper. `Session.blocked()` (Task 5) is its public entry, as `Session.touched()` is for `touchedIn`.
- Produces:
  ```ts
  export type BlockReason = "needs_approval" | "user_rejected" | "classifier" | "deny_rule" | "safety_check"
  export type BlockedCall = { id: string, at: string, tool: string, input: Record<string, unknown>, reason: BlockReason, text: string }
  export function classifyDenial(text: string): BlockReason | undefined, // undefined means "not a denial"
  export function blockedIn(o: { fs: TranscriptFs, file: string, max?: number }): Promise<BlockedCall[]>, // newest first, default max 200
  ```

- [ ] **Step 1: Build the text catalog from real data.** Run the sampling script `bun scripts/sample-denials.ts` (write it in this step, keep it in `scripts/`). It reads `~/.claude/projects/*/*.jsonl`, takes `tool_result` blocks with `is_error: true`, and prints the 40 most common first lines of the text with a count. Pick the denial texts from that output. Save at least one anonymised real line for each reason in `server/test/fixtures/blocked/<reason>.jsonl`. Known starting points: `"<tool> in '<path>' needs approval."` (needs_approval), `"The user doesn't want to proceed with this tool use"` (user_rejected), `"Permission for this action was denied by the Claude Code auto mode classifier"` (classifier), and a text that names a deny rule (deny_rule). Remove every secret and path of a real person from the fixtures.
- [ ] **Step 2: Write the failing tests.** `classifyDenial` returns the right reason for each fixture text and `undefined` for `"Exit code 1"` and for `""`. Test `blockedIn` with a fake `TranscriptFs`. It holds an assistant `tool_use` and a later user `tool_result` with `is_error: true` and denial text. Expect one `BlockedCall` with the tool name, the input, and the time of the call. A result with `is_error: true` and no denial text gives nothing. A result with `is_error` false gives nothing. A result before its use gives nothing. A repeated `tool_use` id gives one entry. A line over 1 MB is skipped and later lines still count (use the fake fs to yield a long line). Results are newest first and capped at `max`.
- [ ] **Step 3: Run** `bun test server/test/blocked.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** `blockedIn` the way `touchedIn` in `server/src/touched.ts` works: stream lines, parse only lines that contain `"tool_use"` or `"tool_result"`, pair by id with a bounded map, fail closed. Keep `classifyDenial` as one table of `[RegExp, BlockReason]` so a new Claude Code text is one line to add.
- [ ] **Step 5: Run** the test and `bun run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(permissions): list blocked tool calls from a transcript`.

---

### Task 5: Session methods, node routes, and hub forwarding

**Files:**
- Modify: `server/src/sessioncatalog.ts` (class `Session`, next to `touched`, about line 204)
- Create: `server/src/permissionsapi.ts`
- Modify: `server/src/app.ts` (next to the `sessionApi` mount, about line 184), `server/src/hosts.ts` (next to the session routes, about line 310)
- Test: `server/test/sessioncatalog.test.ts` (new cases), `server/test/permissionsapi.test.ts`, and a forwarding case in the existing hosts test file

**Interfaces:**
- Consumes: `ClaudeSettings`, `PermissionLayers` (Task 3), `blockedIn`, `BlockedCall` (Task 4), `Instances.claudeHome`.
- Produces on `Session`:
  ```ts
  /** The settings layers that apply to this session. It runs the real-root check first (a failed check is a 404). */
  permissions(o: { ownerUid?: number }): Promise<PermissionLayers>
  /** The blocked tool calls of this transcript, newest first. It reads this transcript and never scans again. */
  blocked(): Promise<BlockedCall[]>
  ```
- Produces routes on the node:
  - `GET /api/instances/:id/permissions` answers `PermissionLayers` with the user layer only (`ClaudeSettings.forHome`).
  - `GET /api/instances/:id/sessions/:sid/permissions` answers `PermissionLayers`.
  - `GET /api/instances/:id/sessions/:sid/blocked` answers `BlockedCall[]`.
  - The same paths without `/api` on the hub, under `remote` in `hosts.ts`, forwarded with `forwardJson` as the `touched` route is.
  ```ts
  export function permissionsApi(deps: { instances: Instances, sessions: SessionCatalog }): Hono // mount at /instances/:id
  ```

- [ ] **Step 1: Write the failing tests.** In `sessioncatalog.test.ts`: `Session.blocked()` returns the calls of its own transcript. `Session.permissions()` returns the layers for its real root, and rejects with a 404 when the real-root check fails. In `permissionsapi.test.ts`, with the helpers of `sessionapi.test.ts`: a bad instance id gives 400, a bad session id gives 400, an unknown session gives 404, a good session gives 200 with `layers` in the order from Task 3, and the user route gives only the `user` layer. Add one hub test that a GET of `/instances/:id/sessions/:sid/blocked` reaches the node client with the same path.
- [ ] **Step 2: Run** `bun test server/test/sessioncatalog.test.ts server/test/permissionsapi.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the two `Session` methods.** `blocked()` calls `blockedIn` with `catalog.fs` and `this.file`, as `touched()` does. `permissions()` calls `this.open()` and builds `ClaudeSettings.forSession` from the instance home, the pinned real root, and `ownerUid`.
- [ ] **Step 4: Implement `permissionsApi`.** Export the id patterns and the `home` and `sessionOf` helpers from `sessionapi.ts` and use them here, instead of copying them. If `h.identity` has a uid, pass it as `ownerUid`. Mount the router in `app.ts` before the catch-all.
- [ ] **Step 5: Add the three hub routes** in `hosts.ts`, one line each in the style of the `touched` route.
- [ ] **Step 6: Run** `bun test server ./cli` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(permissions): Session.permissions and Session.blocked, node and hub routes`.

---

### Task 6: Web data layer

**Files:**
- Create: `web/src/lib/features/permissions/api.ts`, `queries.ts`, `index.ts`
- Test: `web/src/lib/features/permissions/api.test.ts`, `queries.test.ts` (copy the style of `web/src/lib/features/sessions/api.test.ts` and `queries.test.ts`)

**Interfaces:**
- Produces (types mirror Task 3 and Task 4 exactly):
  ```ts
  export type Layer = { scope: "user"|"project"|"local"|"legacy-local"|"managed", path: string|null, writable: boolean, state: "ok"|"missing"|"invalid"|"unknown-path", reason?: string, hash?: string, rules: Rule[], warnings: string[] }
  export type Rule = { raw: string, list: "allow"|"ask"|"deny", tool: string, specifier?: string, scope: string, shadowedBy?: { scope: string, list: "ask"|"deny", raw: string } }
  export type BlockedCall = { id: string, at: string, tool: string, input: Record<string, unknown>, reason: "needs_approval"|"user_rejected"|"classifier"|"deny_rule"|"safety_check", text: string }
  export const getUserPermissions: (host: string, instance: string) => Promise<{ layers: Layer[] }>
  export const getSessionPermissions: (host: string, instance: string, session: string) => Promise<{ layers: Layer[] }>
  export const getBlocked: (host: string, instance: string, session: string) => Promise<BlockedCall[]>
  export const userPermissionsQuery: (host: string, instance: string) => QueryOptions
  export const sessionPermissionsQuery: (host: string, instance: string, session: string) => QueryOptions
  export const blockedQuery: (host: string, instance: string, session: string) => QueryOptions
  ```
  Query keys: `["permissions", host, instance]`, `["session-permissions", host, instance, session]`, `["session-blocked", host, instance, session]`. Options match `touchedQuery`: `staleTime: 5000`, `refetchOnWindowFocus: true`, `retry: false`.

- [ ] **Step 1: Write the failing tests.** Each api function calls `request` with the right method and URL (encode each id). Each query has the key above and the options above.
- [ ] **Step 2: Run** `bun run --cwd web test permissions`. Expected: FAIL.
- [ ] **Step 3: Implement** with `request` and `hostUrl` from `web/src/lib/shared/http`, as `sessions/api.ts` does.
- [ ] **Step 4: Run** the web tests and `bun run --cwd web check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): data layer for permissions`.

---

### Task 7: Session tabs, blocked list, and instance page

**Files:**
- Create: `web/src/lib/features/permissions/RuleList.svelte`, `BlockedList.svelte`, `PermissionsPage.svelte`
- Modify: `web/src/lib/features/sessions/SessionView.svelte` (add the tabs `permissions` and `blocked`)
- Modify: `web/src/lib/features/sessions/format.ts` and `web/src/routes/sessions/+page.svelte` (accept the two new `view` values)
- Modify: `web/src/lib/features/instances/InstanceList.svelte` (add a link to the instance permissions page)
- Create: the route `web/src/routes/permissions/+page.svelte`
- Test: `web/src/lib/features/permissions/RuleList.test.ts`, `BlockedList.test.ts`, and an update to `web/src/lib/features/sessions/tabs.test.ts`

**Interfaces:**
- Consumes: Task 6 queries and types. Existing: `Tabs`, `Badge`, `Button` from `#lib/components/ui`, `isUnsupported`, `ago` from `sessions/format`.
- Produces: `RuleList` props `{ layers: Layer[] }`. `BlockedList` props `{ host: string; instance: string; session: string; now: number }`. `PermissionsPage` props `{ host: string; instance: string }`.

- [ ] **Step 1: Write the failing component tests** in the harness style of `FilePreview.test.ts`.
  - `RuleList` shows the path of each layer as a heading.
  - `RuleList` groups rules under Allow, Ask, and Deny.
  - `RuleList` shows the reason for an `invalid` layer and for an `unknown-path` layer.
  - `RuleList` shows the text "overridden by deny in user" for a rule with `shadowedBy`.
  - `BlockedList` shows the tool, the reason as a badge, and the time. The summary of the input is the `command` for Bash, the `file_path` for file tools, and the tool name for the rest.
  - `BlockedList` shows "Nothing was blocked" for an empty list, and it shows no button in Phase 1.
  - `tabs.test.ts`: the session page accepts `view=permissions` and `view=blocked`.
- [ ] **Step 2: Run** `bun run --cwd web test permissions sessions`. Expected: FAIL.
- [ ] **Step 3: Implement the components.** Mobile first: one column, large touch targets (follow `TouchedList.svelte`). The Blocked tab trigger shows a count Badge when the list is not empty. An unsupported node (404 or 501) shows "This node does not support permissions. Update the node." The instance page shows the user layer with `RuleList`.
- [ ] **Step 4: Wire the tabs** in `SessionView.svelte`: add `permissions` and `blocked` to the `view` union, to `pick`, to `help`, and to `href`. Keep the file tabs working as they do now.
- [ ] **Step 5: Run** `bun run --cwd web test`, `bun run --cwd web check`, and `bun run typecheck`. Expected: PASS.
- [ ] **Step 6: Try it.** Run `bun run dev:local`, open the app in the browser tool, open a session, and open both tabs. Take a screenshot at phone width (390 px) and read it. Expected: the rules and the blocked list show, with no horizontal scroll.
- [ ] **Step 7: Commit** `feat(web): permissions and blocked tabs, instance permissions page`.

---

## Self-Review

- Spec coverage: layers for user, shared, local, managed (Tasks 1 to 3). Instance-level user file (`ClaudeSettings.forHome`, Tasks 3, 5, 7). Merged view and shadow marks (Tasks 2, 3, 7). Blocked list with reasons and a text catalog from real transcripts (Task 4). Probably-fixed mark, suggested rules, editing, confirmation, audit log, the classifier test, and the nudge belong to Phase 2 and Phase 3 and are left out on purpose.
- Gap kept for Phase 2: `writable` is always false here, and `hash` is returned so the conflict check can use it.
- Names match across tasks: `Layer`, `Rule`, `MarkedRule`, `BlockedCall`, `BlockReason`, `readUserFile`, `SettingsFile`, `ClaudeSettings`, `Session.permissions`, `Session.blocked`, `blockedIn`, `classifyDenial`.

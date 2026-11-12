# Sessions Classes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the option-bag functions of the session files server code with a few small classes. The behavior does not change. After this change, the checked real root of a session can only exist inside a `PinnedRoot`, and the type system enforces that.

**Architecture:** One `SessionCatalog` for each app holds the transcript file system, the name cache, the live-session reader, the refused folders and the file opener. `catalog.instance({ path, home })` gives an `InstanceSessions` with `list()` and `find(id)`. `find` gives a `Session`. `session.open()` runs the real-root check and gives a `PinnedRoot`. Only a `PinnedRoot` can list, preview or download, and only its `touchedFile(abs)` method can open a touched file outside the session folder. Pure parsing and path functions stay plain functions in small files. `sessionapi.ts` stays a thin Hono layer. One change to the sketch: `Session` has no name and no live status. Today `findSession` reads no name, and a class object must not reach `c.json`. So `list()` returns plain `SessionSummary` records, as `listSessions` does today.

**Tech Stack:** Bun, TypeScript, Hono. Tests use `bun test` with injected file systems.

**Spec/Context:** The agreed sketch is in the memory note `sessions-oo-refactor-idea.md`. The current module map is `docs/session-files.md`. The code is on `refactor/sessions-classes`, based on `main` at `9397c37` (PR 3 merged).

## Global Constraints

1. Pure move. Observable behavior does not change: every HTTP route answers exactly as before (status, body, headers), every error message is the same, every security check runs in the same order with the same inputs.
2. Security-sensitive function bodies (real-root check, exactRoot, exactPath, openChecked, the touched-file pairing loop, the abs gate, absRefused, the live-session reader checks) move unchanged: same code, new home. The reviewer must be able to diff them as moves.
3. Test assertions do not change. Tests may be rewired to build objects the new way (construction code changes), but every existing assertion stays and still passes. Count the tests before and after: the number of tests must not drop. New tests are allowed only for the new construction seams (for example, a PinnedRoot cannot be built without the real-root check) and must not replace old ones.
4. The public wiring seams keep working: `Instances.claudeHome`, `sessionApi(deps)` in app.ts, the hub forwarding in hosts.ts, the Windows backend. If a seam must change, the plan must say exactly how and why, and keep the change minimal.
5. One task, one commit-sized change, tests green after each task. Order the tasks so the code compiles and all tests pass after every task (introduce each class beside the old functions, move callers one by one, then delete the old exports). A task may not leave dead code behind.
6. The web app is out of scope.

Also:

- These files do not change: `livesessions.ts`, `paths.ts`, `disposition.ts`, `hosts.ts`, `hostclient.ts`, `instances.ts`, `win/instances.ts`, and the bodies in `sessionfs.ts`. Their tests (`livesessions.test.ts`, `paths.test.ts`, `disposition.test.ts`, `hosts-sessions.test.ts`, `win-instances.test.ts`, `sessionfs.test.ts`) do not change at all. They guard the seams.
- When a body moves, only these edits are allowed: the names in the rename table below, and the lines that bind a parameter to a local name (for example `const fs = o.fs`). Run `git diff --color-moved=dimmed-zebra` on each task. Each moved body must show as moved, apart from those edits.
- Run commands with `export PATH=$HOME/.bun/bin:$PATH`.
- The test baseline on `9397c37` is `Ran 1826 tests across 88 files`, with 1775 pass, 51 skip and 0 fail. Count with the `Ran N tests` line of `bun test server ./cli`. Do not count with grep, because grep misses `test.skipIf(...)`. For one file, run `bun test <file>` and read its count.
- The count check in each task has three parts. N must be at least the N of the task before. The fail count must be 0. The skip count can grow only by new skipped tests.
- A new test file goes on the `windows` job list in `.github/workflows/ci.yml`.
- Documents and comments use plain English: short sentences, no contractions, no semicolons, no em-dashes.

## Review Focus

Each item names a way that a pure move can still change behavior here, and the test that pins it.

- **An options default that changes.** Today `sessionApi` has a default for each optional dep. The defaults are `defaultFs`, `readLiveSessions({ home })`, `openDownload`, `previewIn` and `process.platform`. `SessionCatalog` must use the same defaults. `sessionapi.test.ts` pins them. Some of its tests have no `fs`, and the Windows test sets `platform: "win32"`. `sessionwiring.test.ts` pins them with the real deps only.
- **A JSON body that changes.** `list()` must return plain records, not class objects. The same code builds them, in the same key order. The order is `id`, `root`, `startedAt`, `lastActiveAt`, then `name`, `live`, `branch`. A `Session` object must never reach `c.json`. The `toEqual` list tests in `sessions.test.ts` pin this. The list tests in `sessionapi.test.ts` pin it too. Add one new test in `sessioncatalog.test.ts`: the JSON of `list()` has exactly the old keys.
- **A cache that is now shared, or no longer shared.** The module global `defaultNames` goes away. Each catalog gets its own name cache. Production has one catalog for each app (Task 5). So the node and the hub keep one cache, as today. Tests are different. Some `listSessions` calls have no `names`, for example at `sessions.test.ts` lines 119, 129 and 568. Today they share the global cache with earlier tests. After the change, each one gets a fresh cache. Two tests pin the cache: `the cache avoids a second read until size or mtime change` and `the cache is bounded`. Task 6 runs each test without `names` alone. Add new tests in `sessioncatalog.test.ts`. Two `instance()` calls of one catalog share the cache. Two catalogs do not.
- **Error order.** The checks run in this order:
  1. the instance id pattern (400),
  2. `claudeHome` missing (501),
  3. the `claudeHome` call (404),
  4. the session id pattern (400),
  5. find (404 "session not found"),
  6. the real-root checks.

  For `/files`, the `abs` refusal runs before all of these. For `/file` and `/download`, `targetOf` runs first. For `abs`, the gate runs after the real-root checks. These tests in `sessionapi.test.ts` pin the order: `GET sessions returns 404 for an unknown instance`, `returns 501 when the backend has no claudeHome`, `a request with path=../x returns 403`, and the `abs` tests.
- **A closed handle.** The download route keeps the abort listener. It also keeps the `d.close()` in its `catch`. `PinnedRoot.download` and `PinnedFile.download` return the opener result as it is. They do not wrap the stream. Two tests pin this: `GET download stops reading when the request aborts` and `openDownload streams a file in chunks and close() releases the handle`.
- **Work that moves from per request to per catalog.** Three things stay per request. They are `refusedDirs()` (the realpath of each state folder), the `stat` in `inRoot`, and the live read with `.catch(() => undefined)`. The catalog constructor must not compute them. `sessionwiring.test.ts` pins the state folders. `GET files returns 404 when the session root no longer exists` pins the `stat`. The test at `sessionapi.test.ts` line 73 pins the live read.
- **Construction cost on the 15 second list poll.** Each request builds `catalog.instance(...)`, a `Session` and a `PinnedRoot`. Their constructors do no I/O. Only `PinnedRoot.pin` does I/O, and it makes the same calls as `rootOf` today. A new test in `sessioncatalog.test.ts` checks that `instance()` calls no method of the fake file system.

---

## File structure

| File | Status | One job |
| --- | --- | --- |
| `server/src/transcript.ts` | Create | Pure transcript helpers: the session id pattern, `parse`, `encodeProjectDir` and its parts. The header comment (a) and (b) of `sessions.ts` moves here. |
| `server/src/transcriptfs.ts` | Create | The `TranscriptFs` seam and its default: `streamLines`, `tailLines`, `defaultTranscriptFs`. |
| `server/src/sessionscan.ts` | Create | `Found` and `scan`: which transcripts belong to an instance folder. |
| `server/src/sessionnames.ts` | Create | The name of a session: `NameCache`, `newNameCache`, `tidy`, `promptText`, `takeTitle`, `readName`, `nameOf`. |
| `server/src/touched.ts` | Create | `TouchedFile` and `touchedIn`: the pairing loop over one known transcript. |
| `server/src/sessioncatalog.ts` | Create | `SessionCatalog`, `InstanceSessions`, `Session`, `SessionSummary`. |
| `server/src/pinnedroot.ts` | Create | `PinnedRoot` and `PinnedFile`: the real-root check, the `abs` gate, and the only calls to the opener. |
| `server/src/sessionfs.ts` | Modify (comments only) | The opener primitives, unchanged. Only the header comment changes, because it names `sessionapi rootOf`. |
| `server/src/sessionapi.ts` | Modify | Thin Hono routes. It never holds a string root or an exact flag. |
| `server/src/app.ts` | Modify | Builds one `SessionCatalog` for each app factory. |
| `server/src/sessions.ts` | Delete (Task 6) | Nothing stays in it. |
| `server/test/sessioncatalog.test.ts` | Create | New tests for the catalog seams only. |
| `server/test/pinnedroot.test.ts` | Create | New tests for the `PinnedRoot` seam only. |

The string root still exists below `PinnedRoot`: `PinnedRoot` passes `real` to `listIn`, `previewIn` and `openDownload`, which keep their `(root: string, rel: string, hooks?: OpenHooks)` signatures. `sessionfs.test.ts` pins them, including the mode without `exactRoot`. The rule that the type system enforces is this: `sessionapi.ts` and every module above `pinnedroot.ts` never hold a checked root as a string, and never name `EXACT`, `EXACT_FILE`, `exactRoot` or `exactPath`.

### Where each function lands

| Old function or value | Old file | New home |
| --- | --- | --- |
| `Session` (type) | sessions.ts | `SessionSummary` in sessioncatalog.ts (same shape, renamed because `Session` is now the class) |
| `TouchedFile` (type) | sessions.ts | touched.ts |
| `TranscriptFs` (type) | sessions.ts | transcriptfs.ts |
| `NameCache` (type), `newNameCache` | sessions.ts | sessionnames.ts |
| `defaultNames` | sessions.ts | deleted in Task 6. Each catalog makes its own with `newNameCache()`. |
| `SESSION_ID` | sessions.ts | transcript.ts (exported). sessionapi.ts and livesessions.ts keep their own copies. |
| `MAX_LINE`, `streamLines`, `tailLines`, `defaultFs` | sessions.ts | transcriptfs.ts (`defaultFs` is renamed `defaultTranscriptFs`) |
| `NAME_WINDOW`, `NAME_MAX` | sessions.ts | sessionnames.ts |
| `MAX_ENCODED`, `WORKTREE_MARK`, `trimSeparators`, `encodeUnits`, `pathHash`, `encodeProjectDir` | sessions.ts | transcript.ts (the first four are exported for `scan`) |
| `parse` | sessions.ts | transcript.ts |
| `Found`, `scan` | sessions.ts | sessionscan.ts |
| `NOT_PROMPT`, `promptText`, `tidy`, `Titles`, `TITLE_KINDS`, `takeTitle`, `readName`, `nameOf` | sessions.ts | sessionnames.ts |
| `NAME_READS`, `mapLimit`, the body of `listSessions` | sessions.ts | sessioncatalog.ts (`InstanceSessions.list`) |
| `findSession` | sessions.ts | `InstanceSessions.find` |
| `sessionRootOf` | sessions.ts | deleted. Its tests use `(await find(id))?.root`. |
| `PENDING_MAX`, `TOUCHED_MAX`, `putNewest`, `Use` | sessions.ts | touched.ts |
| `touchedFiles` | sessions.ts | the loop goes to `touchedIn` in touched.ts. The session id check and the scan fallback go away, because a `Session` always has a valid id and its file. `Session.touched` calls `touchedIn`. |
| `Entry`, `Listing`, `Preview`, `Download`, `OpenHooks`, `PREVIEW_LIMIT`, `PREVIEW_JSON_LIMIT`, `resolveIn`, `listIn`, `previewIn`, `openDownload` and all internals | sessionfs.ts | stay in sessionfs.ts, unchanged |
| `ID_RE`, `SESSION_ID`, `MAX_ABS`, `CONTROL`, `Target`, `home`, `targetOf` | sessionapi.ts | stay in sessionapi.ts |
| `SessionApiDeps`, `sessionApi` | sessionapi.ts | stay. `SessionApiDeps` gains `sessions?` (Task 5). |
| `rootOf` lines 106 to 110 (home, session id, find, 404) | sessionapi.ts | stay as `sessionOf(c)` in sessionapi.ts |
| `rootOf` lines 111 to 121 (the real-root check) | sessionapi.ts | `PinnedRoot.pin` |
| `realOrMissing`, `inRoot`, `EXACT`, `EXACT_FILE` | sessionapi.ts | pinnedroot.ts |
| `onTarget` `path` branch | sessionapi.ts | `PinnedRoot.preview` and `PinnedRoot.download` |
| `onTarget` `abs` branch (the `abs` gate) | sessionapi.ts | `PinnedRoot.touchedFile` |
| `refused` | sessionapi.ts | `SessionCatalog.refusedDirs` |
| the `refuseDirs` line in `instanceApi` | app.ts | `sessionCatalogFor(cfg)` in app.ts |
| `LiveInfo`, `LiveFs`, `ProcReads`, `readLiveSessions`, `statStartTime`, `pidAlive` | livesessions.ts | stay, unchanged |
| `absRefused`, `within`, `PathError` | paths.ts | stay, unchanged |
| `downloadHeaders`, `dispositionFor`, `lastSegment` | disposition.ts | stay, unchanged |

### Rename table for moved bodies

| In the old body | In the new body |
| --- | --- |
| `defaultFs` | `defaultTranscriptFs` |
| `fs` (sessionapi dep) | `catalog.fs` |
| `platform`, `win`, `P` (sessionapi) | `catalog.platform`, and `win` and `P` derived from it the same way |
| `refused()` | `catalog.refusedDirs()` |
| `deps.refuseDirs` | `this.refuseDirs` |
| `h.path` | `session.instance.path` |
| `root`, `worktree`, `file` from `findSession` | `session.root`, `session.worktree`, `session.file` |
| `touchedFiles({ ...h, sessionId, root, file, platform, dirs, ... })` | `session.touched({ dirs })` |
| `fn(real, t.path, EXACT)` | `catalog.previewIn(real, rel, EXACT)` or `catalog.openDownload(real, rel, EXACT)` |
| `fn(P.dirname(entry), P.basename(entry), EXACT_FILE)` | `new PinnedFile(catalog, P.dirname(entry), P.basename(entry))`, whose methods call the opener with `EXACT_FILE` |
| `o.names ?? defaultNames` | `this.catalog.names` |
| `o.live?.get(f.id)` | `live?.get(f.id)`, where `live` is the result of the catalog live read |

## Interfaces

All object types below use commas between members.

```ts
// transcriptfs.ts
export type TranscriptFs = { readdir(dir: string): Promise<string[]>, stat(p: string): Promise<{ mtimeMs: number, size?: number }>, lines(p: string): AsyncIterable<string>, tail?(p: string, bytes: number): Promise<string[]> }
export const defaultTranscriptFs: TranscriptFs

// transcript.ts
export const SESSION_ID: RegExp
export const MAX_ENCODED: number
export const WORKTREE_MARK: string
export function trimSeparators(path: string): string
export function encodeUnits(path: string): string
export function encodeProjectDir(path: string): string
export function parse(line: string): Record<string, any> | undefined

// sessionscan.ts
export type Found = { id: string, file: string, mtimeMs: number, size?: number, root: string, worktree: boolean, branch?: string, startedAt?: string }
export function scan(o: { home: string, path: string, fs: TranscriptFs, only?: string }): Promise<Found[]>

// sessionnames.ts
export type NameCache = { get(file: string): ..., set(file: string, v: ...): void }   // unchanged
export function newNameCache(max?: number): NameCache
export function tidy(raw: string | undefined): string | undefined
export function nameOf(fs: TranscriptFs, f: Found, cache: NameCache): Promise<string | undefined>

// touched.ts
export type TouchedFile = { path: string, inside: boolean, tool: "write" | "edit", at: string, confirmed: boolean }
export function touchedIn(o: { fs: TranscriptFs, file: string, root: string, platform?: NodeJS.Platform, dirs?: readonly string[] }): Promise<TouchedFile[]>

// sessioncatalog.ts
export type SessionSummary = { id: string, root: string, name?: string, branch?: string, startedAt: string, lastActiveAt: string, live?: { status?: string, remoteControl: boolean } }
export type LiveReader = (home: string) => Promise<ReadonlyMap<string, LiveInfo>>
export type SessionCatalogOptions = { fs?: TranscriptFs, names?: NameCache, live?: LiveReader, refuseDirs?: readonly string[], platform?: NodeJS.Platform, openDownload?: typeof openDownload, previewIn?: typeof previewIn }
export class SessionCatalog {
  constructor(o?: SessionCatalogOptions)
  readonly fs: TranscriptFs                    // default defaultTranscriptFs
  readonly names: NameCache                    // default newNameCache()
  readonly platform: NodeJS.Platform           // default process.platform
  readonly openDownload: typeof openDownload   // default from sessionfs.ts
  readonly previewIn: typeof previewIn         // default from sessionfs.ts
  instance(h: { path: string, home: string }): InstanceSessions   // no I/O
  readLive(home: string): Promise<ReadonlyMap<string, LiveInfo>>  // default (home) => readLiveSessions({ home }), rejects as the reader rejects
  refusedDirs(): Promise<string[]>             // body of refused(), per call
}
export class InstanceSessions {
  constructor(catalog: SessionCatalog, path: string, home: string)
  readonly catalog: SessionCatalog
  readonly path: string
  readonly home: string
  list(): Promise<SessionSummary[]>            // live read with .catch(() => undefined), then the old listSessions body
  find(id: string): Promise<Session | undefined>   // undefined for a bad id or no transcript, as findSession
}
export class Session {
  constructor(instance: InstanceSessions, found: Found)   // no I/O
  readonly instance: InstanceSessions
  readonly id: string
  readonly root: string        // lexical first cwd
  readonly worktree: boolean
  readonly file: string        // the transcript that find read
  readonly branch?: string
  readonly startedAt?: string
  touched(o: { dirs: readonly string[] }): Promise<TouchedFile[]>   // touchedIn on this.file, never a new scan
  open(): Promise<PinnedRoot>                                       // PinnedRoot.pin(this)
}

// pinnedroot.ts
export class PinnedRoot {
  private constructor(session: Session, real: string)
  static pin(session: Session): Promise<PinnedRoot>   // throws HttpError(404, ...) exactly as rootOf
  readonly session: Session
  list(rel: string, hidden: boolean): Promise<Listing>   // inRoot, then listIn(real, rel, hidden, EXACT)
  preview(rel: string): Promise<Preview>                 // inRoot, then catalog.previewIn(real, rel, EXACT)
  download(rel: string): Promise<Download>               // inRoot, then catalog.openDownload(real, rel, EXACT)
  touchedFile(abs: string): Promise<PinnedFile>          // the abs gate, throws HttpError(404, "file was not touched by this session")
}
export type { PinnedFile }   // type only: no code outside pinnedroot.ts can build one
class PinnedFile {
  constructor(catalog: SessionCatalog, dir: string, name: string)
  preview(): Promise<Preview>     // catalog.previewIn(dir, name, EXACT_FILE)
  download(): Promise<Download>   // catalog.openDownload(dir, name, EXACT_FILE)
}

// sessionapi.ts
export type SessionApiDeps = SessionCatalogOptions & { instances: Instances, sessions?: SessionCatalog }
export function sessionApi(deps: SessionApiDeps): Hono   // catalog = deps.sessions ?? new SessionCatalog(deps)

// app.ts
export type InstanceApiDeps = { ...as today, sessions?: SessionCatalog }
function sessionCatalogFor(cfg: Config): SessionCatalog   // the refuseDirs line, then new SessionCatalog({ refuseDirs })
```

The one seam change: `SessionApiDeps` and `InstanceApiDeps` gain an optional `sessions`. Why: `createApp` builds `instanceApi` through `forwarding()`, which runs twice (app.ts lines 282 and 341). Today both share the global name cache. A catalog for each `sessionApi` gives the hub two caches. To keep one cache, each app factory builds one catalog with `sessionCatalogFor(cfg)` and passes it to every `instanceApi` call it makes. When `sessions` is absent, `instanceApi` and `sessionApi` build a fresh catalog, so every old call site and every test still works. The fields `fs`, `live`, `refuseDirs`, `platform`, `openDownload` and `previewIn` of `SessionApiDeps` keep their meaning, so `sessionapi.test.ts` needs no rewiring.

---

### Task 1: Pure transcript helpers and the file system seam

**Files:**
- Create: `server/src/transcript.ts`, `server/src/transcriptfs.ts`
- Modify: `server/src/sessions.ts` (import from the new files, delete the moved code)
- Modify: `server/src/sessionapi.ts`, `server/test/sessionapi.test.ts` (import `TranscriptFs` from `./transcriptfs`)
- Modify: `server/test/sessions.test.ts`, `server/test/sessionwiring.test.ts` (import `encodeProjectDir` from `transcript`, `TranscriptFs` from `transcriptfs`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `transcript.ts` and `transcriptfs.ts` as in Interfaces.

- [ ] **Step 1: Record the baseline.** Run `bun test server ./cli`. Expected: `Ran 1826 tests`, 0 fail. If the number differs, write the real number in the task log and use it as the baseline.
- [ ] **Step 2: Move** `SESSION_ID`, `MAX_ENCODED`, `WORKTREE_MARK`, `trimSeparators`, `encodeUnits`, `pathHash`, `encodeProjectDir` and `parse` to `transcript.ts`. Move the header comment parts (a) and (b) with them. Move `MAX_LINE`, `streamLines`, `tailLines` and `defaultFs` (as `defaultTranscriptFs`) and the `TranscriptFs` type to `transcriptfs.ts`.
- [ ] **Step 3: Rewire the imports** in the files listed above. `sessions.ts` does not re-export the moved names.
- [ ] **Step 4: Run the checks.** Run `bun test server/test/sessions.test.ts server/test/sessionwiring.test.ts server/test/sessionapi.test.ts`, then `bun test server ./cli` and `bun run typecheck`. Expected: PASS, and the count check holds. Run `git diff --color-moved=dimmed-zebra` and check that the moved code shows as moved.
- [ ] **Step 5: Commit** `refactor(sessions): move the pure transcript helpers and the file system seam to their own files`.

### Task 2: Scan and names in their own files

**Files:**
- Create: `server/src/sessionscan.ts`, `server/src/sessionnames.ts`
- Modify: `server/src/sessions.ts`
- Modify: `server/test/sessions.test.ts` (import `newNameCache` from `sessionnames`)

**Interfaces:**
- Consumes: Task 1.
- Produces: `Found`, `scan`, `NameCache`, `newNameCache`, `tidy`, `nameOf` as in Interfaces.

- [ ] **Step 1: Move** `Found` and `scan` (body unchanged) to `sessionscan.ts`. Take the line about `scan` from the header comment part (c). Move the name code to `sessionnames.ts`. The table above lists each name. Take the line about `readName` from part (c). `defaultNames` stays in `sessions.ts` for now, built with the imported `newNameCache`.
- [ ] **Step 2: Rewire the imports** in `sessions.ts` and `sessions.test.ts`.
- [ ] **Step 3: Run the checks.** Run `bun test server/test/sessions.test.ts`, then `bun test server ./cli` and `bun run typecheck`. Expected: PASS, and the count check holds. Check the moved code with `--color-moved`.
- [ ] **Step 4: Commit** `refactor(sessions): move the transcript scan and the session names to their own files`.

### Task 3: The touched-file pairing loop in its own file

**Files:**
- Create: `server/src/touched.ts`
- Modify: `server/src/sessions.ts`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: `TouchedFile` and `touchedIn` as in Interfaces.

- [ ] **Step 1: Move** `PENDING_MAX`, `TOUCHED_MAX`, `putNewest`, `Use`, `TouchedFile` and the doc comment of `touchedFiles` to `touched.ts`. Create `touchedIn(o)` from the lines of `touchedFiles` that start at `const platform = o.platform ?? process.platform` and end at the return. Add only `const fs = o.fs` and `const file = o.file` before them.
- [ ] **Step 2: Keep the first lines of `touchedFiles` in `sessions.ts`.** Four lines stay. They are the session id check, `const fs = o.fs ?? defaultTranscriptFs`, the file lookup with `scan`, and `if (!file) return []`. Then add `return touchedIn({ fs, file, root: o.root, platform: o.platform, dirs: o.dirs })`. No caller imports the type `TouchedFile` from `sessions.ts`, so do not re-export it.
- [ ] **Step 3: Run the checks.** Run `bun test server/test/sessions.test.ts server/test/sessionapi.test.ts server/test/sessionwiring.test.ts`, then `bun test server ./cli` and `bun run typecheck`. Expected: PASS, and the count check holds. The loop must show as moved with `--color-moved`.
- [ ] **Step 4: Commit** `refactor(sessions): move the touched-file pairing loop to touched.ts`.

### Task 4: SessionCatalog, InstanceSessions and Session

**Files:**
- Create: `server/src/sessioncatalog.ts`
- Modify: `server/src/sessions.ts` (its exports become thin wrappers)
- Create: `server/test/sessioncatalog.test.ts`
- Modify: `.github/workflows/ci.yml` (add the new test file to the `windows` list)

**Interfaces:**
- Consumes: Tasks 1 to 3, `readLiveSessions` and `LiveInfo` from `livesessions.ts`, `listIn`, `previewIn` and `openDownload` types from `sessionfs.ts`.
- Produces: `SessionCatalog`, `InstanceSessions`, `Session`, `SessionSummary`, `SessionCatalogOptions`, `LiveReader` as in Interfaces. Two members come later: `SessionCatalog.refusedDirs()` in Task 5 and `Session.open()` in Task 7.

- [ ] **Step 1: Write the new seam tests** in `sessioncatalog.test.ts` with the fake file system style of `sessions.test.ts`:
  - `instance() reads no file` (every fake method counts calls, and the count stays 0).
  - `two instance() calls of one catalog share the name cache` and `two catalogs do not share a name cache`.
  - `list() returns plain records with only the old keys` (compare `Object.keys` of each record of `JSON.parse(JSON.stringify(await list()))` with the old key set, and check that no record is a class object).
  - `find() returns a Session whose touched() reads its own file and does not scan` (count `readdir` after `find`).
- [ ] **Step 2: Run** `bun test server/test/sessioncatalog.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Move the bodies.** `NAME_READS`, `mapLimit` and the body of `listSessions` go into `InstanceSessions.list`. The body of `findSession` goes into `InstanceSessions.find`. Use the renames in the rename table. `list` reads live first: `const live = await this.catalog.readLive(this.home).catch(() => undefined)`. Do not add `refusedDirs()` yet. Task 5 moves it. `Session.touched` calls `touchedIn` with `this.file`, `this.root`, `catalog.fs`, `catalog.platform` and `o.dirs`.
- [ ] **Step 4: Make the old exports thin wrappers** so that every caller still compiles:
  - `listSessions(o)` builds `new SessionCatalog({ fs: o.fs, names: o.names ?? defaultNames, live: async () => o.live ?? new Map() })` and returns `.instance(o).list()`. This keeps the global name cache until Task 6.
  - `findSession(o)` returns `{ root, worktree, file }` of `find(o.sessionId)`, or undefined.
  - `sessionRootOf` stays as it is, on top of `findSession`.
  - `touchedFiles` stays as in Task 3.
- [ ] **Step 5: Run the checks.** Run `bun test server/test/sessioncatalog.test.ts server/test/sessions.test.ts server/test/sessionapi.test.ts`, then `bun test server ./cli` and `bun run typecheck`. Expected: PASS, and N grows by the new tests only.
- [ ] **Step 6: Commit** `refactor(sessions): add SessionCatalog, InstanceSessions and Session`.

### Task 5: sessionApi and app.ts on the catalog

**Files:**
- Modify: `server/src/sessionapi.ts`
- Modify: `server/src/sessioncatalog.ts` (add `refusedDirs()`)
- Modify: `server/src/app.ts`

**Interfaces:**
- Consumes: Task 4.
- Produces: `SessionCatalog.refusedDirs()`, `SessionApiDeps` with `sessions?`, `InstanceApiDeps` with `sessions?`, and `sessionCatalogFor(cfg)` in app.ts.

- [ ] **Step 1: Build the catalog in `sessionApi`.** Use `const catalog = deps.sessions ?? new SessionCatalog({ fs, live, refuseDirs, platform, openDownload, previewIn })`. Take each option from `deps`. Leave out an option that `deps` does not set. Move the body of `refused()` into `SessionCatalog.refusedDirs()`, and delete `refused()` from `sessionapi.ts`. `targetOf` and the `abs` gate take `platform`, `win` and `P` from `catalog.platform`.
- [ ] **Step 2: Move the callers.** `GET /` becomes `c.json(await catalog.instance(await home(c)).list())`. In `rootOf`, `findSession(...)` becomes `await catalog.instance(h).find(sessionId)`, and `root`, `worktree` and `file` come from the `Session`. `/touched` and the `abs` gate call `session.touched({ dirs })`, where `dirs` is `await catalog.refusedDirs()` at the same place as `await refused()` today. `rootOf` returns the `Session` instead of `sessionId`, `root` and `file`.
- [ ] **Step 3: Wire app.ts.** Add `sessionCatalogFor(cfg)` with the `refuseDirs` line from `instanceApi`. `instanceApi` passes `sessions: deps.sessions ?? sessionCatalogFor(cfg)` to `sessionApi`. In `createNodeApp`, build one catalog and pass it to its `instanceApi` call. In `createApp`, build one catalog before `forwarding` and pass it to the `instanceApi` call inside `forwarding`, so both calls of `forwarding()` share it.
- [ ] **Step 4: Check that `sessions.ts` has no dead export.** `listSessions`, `findSession`, `sessionRootOf` and `touchedFiles` are now called only by `sessions.test.ts`. That is expected until Task 6. Grep `server/src` for imports from `./sessions`. Expected: none.
- [ ] **Step 5: Run the checks.** Run `bun test server/test/sessionapi.test.ts server/test/sessionwiring.test.ts server/test/app.test.ts server/test/hosts-sessions.test.ts`, then `bun test server ./cli` and `bun run typecheck`. Expected: PASS, and the count check holds. `sessionapi.test.ts` must pass without any change.
- [ ] **Step 6: Commit** `refactor(sessions): serve the session routes from one SessionCatalog for each app`.

### Task 6: Move the transcript tests to the classes and delete sessions.ts

**Files:**
- Modify: `server/test/sessions.test.ts`
- Delete: `server/src/sessions.ts`

**Interfaces:**
- Consumes: Task 4.
- Produces: nothing new. `sessions.ts` and `defaultNames` are gone.

- [ ] **Step 1: Add test-local helpers at the top of `sessions.test.ts`.** They have the old names and parameters. Thus the call sites and the assertions do not change.
  - `listSessions(o)` builds `new SessionCatalog({ fs: o.fs, names: o.names, live: async () => o.live ?? new Map() })` and returns `.instance(o).list()`.
  - `findSession(o)` returns `s && { root: s.root, worktree: s.worktree, file: s.file }` for `s = await find(o.sessionId)`.
  - `sessionRootOf(o)` returns `(await find(o.sessionId))?.root`.
  - `touchedFiles(o)` builds a catalog with `fs` and `platform`, then finds the session. If there is no session, it returns `[]`. If `o.root` differs from `s.root`, it throws. Thus a test with another root fails at once and does not silently change its meaning. On `9397c37`, all 8 call sites pass a root equal to the first cwd of their transcript, so the guard does not fire. Then it returns `s.touched({ dirs: o.dirs ?? [] })`.
- [ ] **Step 2: Rewire the test at line 578** (`given the transcript file, touchedFiles reads it and does not scan the folders`). Call `find` first, set `readdirs = 0`, then call `touched`. The assertion stays.
- [ ] **Step 3: Delete `server/src/sessions.ts`.** Grep `server/src server/test cli` for `from "./sessions"` and `from "../src/sessions"`. Expected: none.
- [ ] **Step 4: Check the cache change.** Run `bun test server/test/sessions.test.ts`. Then run each test that lists without `names` alone with `-t "<test name>"`. Expected: each passes in file order and alone. If one passes only in file order, stop and report: it leaned on the global cache.
- [ ] **Step 5: Run the checks.** Run `bun test server ./cli` and `bun run typecheck`. Expected: PASS, and the count check holds.
- [ ] **Step 6: Commit** `refactor(sessions): test through the session classes and delete sessions.ts`.

### Task 7: PinnedRoot

**Files:**
- Create: `server/src/pinnedroot.ts`
- Modify: `server/src/sessioncatalog.ts` (add `Session.open()`)
- Modify: `server/src/sessionapi.ts`
- Create: `server/test/pinnedroot.test.ts`
- Modify: `.github/workflows/ci.yml` (add the new test file to the `windows` list)

**Interfaces:**
- Consumes: Tasks 4 and 5, `HttpError` from `instances.ts`, `PathError`, `within` and `absRefused` from `paths.ts`, `listIn` and the types from `sessionfs.ts`.
- Produces: `PinnedRoot`, the type `PinnedFile`, and `Session.open()` as in Interfaces.

- [ ] **Step 1: Write the new seam tests** in `pinnedroot.test.ts` with real temporary folders, in the style of `sessionapi.test.ts`:
  - `PinnedRoot has no public constructor`: a line `// @ts-expect-error the constructor is private` before `new PinnedRoot(...)` inside a function that never runs. If the constructor becomes public, `bun run typecheck` fails.
  - `PinnedFile cannot be built outside pinnedroot.ts`: the same with `@ts-expect-error` on `new PinnedFile(...)` after a type import.
  - `open() refuses a session root outside the instance folder with 404` and `open() refuses a link root that leads out with 404`. These pin `pin` on its own. The same cases in `sessionapi.test.ts` stay.
- [ ] **Step 2: Run** `bun test server/test/pinnedroot.test.ts` and `bun run typecheck`. Expected: FAIL, module not found.
- [ ] **Step 3: Move** `EXACT`, `EXACT_FILE`, `realOrMissing` and `inRoot` to `pinnedroot.ts`. Move `rootOf` from `const { root, worktree, file } = found` to its last check into `PinnedRoot.pin`, which ends with `return new PinnedRoot(session, real)`. Move the `path` branch of `onTarget` into `preview` and `download`, and the `abs` branch into `touchedFile`. Use the rename table only. Move the comment about `EXACT` and `EXACT_FILE` from the `sessionapi.ts` header to the `pinnedroot.ts` header.
- [ ] **Step 4: Make sessionapi.ts thin.** `rootOf` becomes `sessionOf(c)`: `home(c)`, the session id check, `find`, and the 404. Add `pinnedOf(c) = (await sessionOf(c)).open()`. The routes become:
  - `/touched`: `const p = await pinnedOf(c)`, then `c.json(await p.session.touched({ dirs: await catalog.refusedDirs() }))`.
  - `/files`: the `abs` check, then `(await pinnedOf(c)).list(c.req.query("path") ?? "", c.req.query("hidden") === "1")`.
  - `/file` and `/download`: `const t = targetOf(c)`, `const p = await pinnedOf(c)`, then `"path" in t ? p.preview(t.path) : (await p.touchedFile(t.abs)).preview()`, and the same with `download`. The headers, the abort listener and the `catch` stay as they are.
  - Delete `onTarget`. Grep `sessionapi.ts` for `realOrMissing`, `inRoot`, `EXACT`, `exactRoot` and `exactPath`. Expected: none.
- [ ] **Step 5: Run the checks.** Run `bun test server/test/pinnedroot.test.ts server/test/sessionapi.test.ts server/test/sessionwiring.test.ts server/test/sessionfs.test.ts`, then `bun test server ./cli` and `bun run typecheck`. Expected: PASS, and N grows by the new tests only. The real-root check and the `abs` gate must show as moved with `--color-moved`.
- [ ] **Step 6: Commit** `refactor(sessions): pin the checked real root in PinnedRoot`.

### Task 8: Documentation

**Files:**
- Modify: `docs/session-files.md` (the module map, the request flow, and "Each function reads only what it needs")
- Modify: the header comments of `server/src/sessionfs.ts` and `server/src/sessionapi.ts` where they name `sessions.ts`, `rootOf` or `findSession`

**Interfaces:**
- Consumes: Tasks 1 to 7.
- Produces: no code.

- [ ] **Step 1: Update the module map** with one row for each new file. Say in the request flow that `Session.open()` gives a `PinnedRoot`, and that only a `PinnedRoot` opens a file. Keep the plain English rules.
- [ ] **Step 2: Grep** `docs server/src` for `sessions.ts`, `rootOf`, `findSession`, `listSessions`, `touchedFiles`, `sessionRootOf` and `defaultNames`. Expected: no stale name, apart from the history in older plans and specs under `docs/superpowers`.
- [ ] **Step 3: Run the checks.** Run `bun test server ./cli` and `bun run typecheck`. Expected: PASS, with the same N as Task 7.
- [ ] **Step 4: Commit** `docs: describe the session classes`.

## Not in this refactor

- A cache for touched results, keyed by transcript size and modification time.
- A limit on parallel transcript reads across requests.
- The threading decision (main thread, worker or child process). It still waits for the approval of the user.

Where they fit: after this refactor, `SessionCatalog` is the one object that lives as long as the app and that every transcript read goes through. A touched cache becomes a field next to `names`, used by `Session.touched`. A limit on parallel reads becomes a small queue that `InstanceSessions.list` and `Session.touched` share through the catalog. Neither needs a change to `sessionapi.ts` or to `PinnedRoot`. Each one is a behavior change, so each one is a separate PR with its own tests.

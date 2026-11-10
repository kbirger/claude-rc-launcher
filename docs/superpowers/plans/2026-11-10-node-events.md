# Node Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At once, the hub learns that a node came online or went offline. Every update shows its steps and output lines, live, in every browser tab and in `claude-rc update --all-nodes`.

**Architecture:** A node serves `GET /api/events` (SSE). The hub holds one stream to each node (`NodeWatcher`). It keeps presence and the last 200 output lines for each host in memory. It sends them to browsers and to the CLI over its own event streams. The updaters write their steps and lines through two optional callbacks.

**Tech Stack:** Bun, TypeScript, Hono (`streamSSE`), Svelte 5 with TanStack Query, `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-10-node-events-design.md`

## Global Constraints

- No backward compatibility. The hub, the nodes, the CLI and the pages ship together. A node without the route answers `404`. That is a `bad response`.
- The step names are exactly `downloading`, `verifying`, `installing-client`, `installing`, `restarting`, `failed` and `up-to-date`.
- The SSE response of a node and of the hub has no `Transfer-Encoding` header and no `Connection` header.
- A node keeps the last 200 lines of the current or last update in memory. The hub keeps the last 200 lines for each host in memory. Neither saves lines to disk.
- A node accepts at most 8 open event connections. The ninth gets `429`.
- Keepalive: a `: keepalive` comment every 15 seconds. The hub drops a stream that is silent for 45 seconds.
- Reconnect waits: 1, 2, 5, 10 and 30 seconds, then 30 seconds again. Add up to 20 percent jitter. A successful connection resets the wait.
- The presence `restarting` ends after 90 seconds without a connection. When the update entry settles as `unknown` or `rolled back`, it ends at once.
- Presence statuses: `online`, `offline`, `restarting` and `error`. The failure classes `unreachable` and `timeout` give `offline`. A stream that ends gives `offline`. The classes `rejected our credentials`, `certificate mismatch` and `bad response` give `error`.
- The hub `snapshot` data is `{ updates, logs, presence }`. The events on the hub stream are `snapshot`, `update`, `log` (data `{ host, line, at }`) and `presence`.
- The record keeps `step` and `stepDetail` (cut to 200 characters) only while `status` is `running`.
- Files with CRLF line endings keep them. Check with `grep -c $'\r' <file>`. The file `server/src/index.win.ts` is CRLF.
- From the repo root, run `bun test server web/src ./cli`, `bun run typecheck` and `bun run --cwd web check`. Add each new Windows-relevant test file to the `windows` job list in `.github/workflows/ci.yml`.
- README text uses short sentences, no contractions, no em-dashes and no semicolons.

## Review Focus

- A stream that dies without a close (half-open TCP) must not leave a node `online` for longer than 45 seconds. Task 5 tests it with a fake clock.
- A node update ends the node process. The hub must show `restarting`, not `offline`. It must not log an error each time. Task 5 tests it.
- If the CLI removes a host while its stream is open, the host must lose its watcher and its lines. Task 5 tests it.
- A tab that opens in the middle of an update must see the current step and the lines so far. Tasks 3, 6 and 7 test it.
- If the stream fails to open, `claude-rc update --all-nodes` must still update every machine. Task 8 tests it.
- If the hub restarts in the middle of `--all-nodes`, the run must not lose its remaining machines. Task 8 tests it.

---

### Task 1: The node event core

**Files:**
- Create: `server/src/updateevents.ts`
- Test: `server/test/updateevents.test.ts`

**Interfaces:**
- Produces:
  - `export type StepName = "downloading" | "verifying" | "installing-client" | "installing" | "restarting" | "failed" | "up-to-date"`.
  - `export type NodeEvent = { type: "step"; step: StepName; to?: string; client?: string; detail?: string } | { type: "log"; line: string; at: string }`.
  - `export type UpdateHooks = { onStep?(e: { step: StepName; to?: string; client?: string; detail?: string }): void; onLog?(line: string): void }`.
  - `export class NodeEvents { constructor(o?: { now?: () => Date; maxLines?: number }); hooks(): Required<UpdateHooks>; emit(e: NodeEvent): void; subscribe(fn: (e: NodeEvent) => void): () => void; snapshotUpdate(): { step: StepName; to?: string; startedAt: string } | null; lines(): { line: string; at: string }[] }`.

- [ ] **Step 1: Write the failing tests** in `updateevents.test.ts`.
  - `hooks().onStep` and `hooks().onLog` reach every subscriber, in order.
  - `lines()` keeps the last 200. Use `maxLines: 3` and four lines.
  - `snapshotUpdate()` is `null` before any step. It is `null` after `up-to-date` or `failed`. Between `downloading` and the end, it holds `{ step, to, startedAt }`.
  - The step `restarting` stays in the snapshot, because the process ends soon after.
  - A step `downloading` clears the lines of the previous update.
  - An unsubscribed listener gets nothing.
  - A throwing subscriber does not stop the others.
- [ ] **Step 2: Run** `bun test server/test/updateevents.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `NodeEvents` and the types in `server/src/updateevents.ts`. Set `startedAt` at the first `downloading` of an update.
- [ ] **Step 4: Run** the same command and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): the node event core`.

### Task 2: The updaters write steps and lines

**Files:**
- Modify: `server/src/serviceupdate.ts` (`createServiceUpdater`), `server/src/win/update.ts` (`createWindowsUpdater`)
- Test: `server/test/serviceupdate.test.ts`, `server/test/win-update.test.ts`

**Interfaces:**
- Consumes: `UpdateHooks` and `StepName` (Task 1).
- Produces: `createServiceUpdater(env: UpdateEnv, hooks?: UpdateHooks)` and `createWindowsUpdater(env: WinUpdateEnv, hooks?: UpdateHooks)`. If `hooks` is missing, both work as before.

- [ ] **Step 1: Write the failing tests** in both files, with recording hooks.
  - A full update gives these steps in order: `downloading`, `verifying`, one `installing-client` for each client (with `client` set), `installing` and `restarting` (with `to` set).
  - Each step change also writes a line.
  - Each action writes a line. Examples: `downloading <asset>`, `sha256 matches SHA256SUMS`, `new binary answers <version>`, `renamed the old binary to <name>.prev`. On Windows, the last line is `restarting in 2 seconds`. On Linux, it is `starting the watchdog`.
  - The result `up-to-date` gives a final step `up-to-date`.
  - Each of these failures gives the step `failed`, with `detail` set to the error text, and a line with the same text: a failed download, a failed `--version` check, a refused client write and a failed rename.
  - A client failure does not stop the later steps.
  - The existing tests pass with no hooks.
- [ ] **Step 2: Run** `bun test server/test/serviceupdate.test.ts server/test/win-update.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the hooks in both updaters. Add the optional `hooks` parameter. Use two small local helpers, `step(s)` and `log(l)`. Each one calls its hook, and does nothing when the hook is missing. Reuse the existing messages where they exist.
- [ ] **Step 4: Run** the same command, `bun test server` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): the updaters report steps and output lines`.

### Task 3: The node route and its wiring

**Files:**
- Create: `server/src/sse.ts`
- Modify: `server/src/app.ts` (`createNodeApp` and the hub's `/events` route), `server/src/nodemain.ts`, `server/src/index.win.ts` (CRLF)
- Test: `server/test/nodeapp.test.ts`, `server/test/app.test.ts`

**Interfaces:**
- Consumes: `NodeEvents` (Task 1) and the updaters with hooks (Task 2).
- Produces:
  - `export function sseResponse(c: Context, run: (s: SSEStreamingApi) => Promise<void>): Response` in `sse.ts`. It calls `streamSSE` and deletes the `Transfer-Encoding` and `Connection` headers. The hub route in `app.ts` uses it.
  - `createNodeApp` deps gain `events?: NodeEvents` and `keepaliveMs?: number`. With `events`, the route `GET /api/events` exists behind `auth`.
  - `NodeDeps` in `nodemain.ts` gains `events?: NodeEvents`. When none is given, `startNode` creates one.

- [ ] **Step 1: Write the failing tests** in `nodeapp.test.ts`.
  - Without authorization, the route gives 401.
  - The first event is `snapshot` with `{ version, update }`.
  - A connection that opens in the middle of an update gets the current step in the snapshot. Then it gets the kept lines as `log` events.
  - A `step` and a `log` that the fake updater emits reach the connection.
  - A `: keepalive` comment arrives on a short interval.
  - The ninth open connection gets `429`, and the first eight keep working.
  - A closed connection frees its slot.
  - The response has no `transfer-encoding` header and no `connection` header.
  - The existing hub header test in `app.test.ts` still passes.
- [ ] **Step 2: Run** `bun test server/test/nodeapp.test.ts server/test/app.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** `sseResponse`, the node route and the wiring. `startNode` creates one `NodeEvents` and passes it to `createNodeApp`. `index.win.ts` creates the `NodeEvents` first, passes `events.hooks()` to `createWindowsUpdater` and passes `events` in the `startNode` deps. Keep CRLF in that file. The `version` in the snapshot is `VERSION`.
- [ ] **Step 4: Run** `bun test server` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): the node serves its update events`.

### Task 4: `HostClient.stream`

**Files:**
- Create: `server/src/ssereader.ts`
- Modify: `server/src/hostclient.ts`
- Test: `server/test/ssereader.test.ts`, `server/test/hostclient.test.ts`

**Interfaces:**
- Produces:
  - `export type SseEvent = { event: string; data: string }`.
  - `export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent>`. It skips comment lines, joins `data:` lines with `\n`, and handles chunk boundaries and `\r\n`. The default event name is `message`.
  - `HostClient` gains `stream(path: string, o?: { signal?: AbortSignal }): Promise<AsyncIterable<SseEvent>>`. It uses the same pinned TLS, the same `Authorization` header and the same failure classes as `call`. It has no body timeout.
  - Failures of `stream`: a `401` throws `rejected our credentials`. A `404`, any other non-200 status and a content type other than `text/event-stream` throw `bad response`. Aborting `signal` ends the iteration without an error.

- [ ] **Step 1: Write the failing tests.**
  - `readSse`: an event split across three chunks. Comments are ignored. Two `data:` lines join into one string. `\r\n` line ends work. The default event name is `message`.
  - `stream`: events arrive from a fake `fetch`. The request is signed for `GET <path>`. A certificate error is `certificate mismatch`. A `404` is `bad response`. Abort ends the iteration. The other behavior of `createHostClient` is unchanged.
- [ ] **Step 2: Run** `bun test server/test/ssereader.test.ts server/test/hostclient.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both. Share the failure classification with `call` (the `classify` function in `hostclient.ts`).
- [ ] **Step 4: Run** the same command and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): the hub can read an event stream from a node`.

### Task 5: The node watcher

**Files:**
- Create: `server/src/nodewatcher.ts`, `server/src/updatelog.ts`
- Modify: `server/src/hostregistry.ts`
- Test: `server/test/nodewatcher.test.ts`, `server/test/updatelog.test.ts`, `server/test/hostregistry-events.test.ts`

**Interfaces:**
- Consumes: `HostClient.stream` and `readSse` (Task 4), and the event shapes of Task 1.
- Produces:
  - `HostRegistry.onChange(fn: (e: { type: "added" | "removed"; id: string }) => void): () => void`. `add` and `remove` call it.
  - `export type Presence = { host: string; status: "online" | "offline" | "restarting" | "error"; version?: string; reason?: string; at: string }`.
  - `export class UpdateLog { constructor(o?: { maxLines?: number; now?: () => Date }); add(host: string, line: string): void; clear(host: string): void; get(host: string): { line: string; at: string }[]; all(): Record<string, { line: string; at: string }[]>; onLine(fn: (e: { host: string; line: string; at: string }) => void): () => void }`.
  - `export function createNodeWatchers(o: { registry: HostRegistry; log: UpdateLog; onPresence(p: Presence): void; onStep(host: string, e: { step: StepName; to?: string; client?: string; detail?: string }): void; now?: () => Date; sleep?: (ms: number) => Promise<void>; random?: () => number }): { presence(): Presence[]; stop(): void }`.

- [ ] **Step 1: Write the failing tests** with a fake registry, fake streams, a fake clock and a fake `sleep`.
  - A connect gives `online` with the snapshot version.
  - A stream that ends gives `offline`.
  - A drop after a `restarting` step gives `restarting`. After 90 seconds without a connection, it gives `offline`.
  - The failure classes map as the Global Constraints say. The class `rejected our credentials` gives `error` with the reason.
  - The reconnect waits follow 1, 2, 5, 10, 30 and 30, with jitter within 20 percent. A good connection resets them.
  - A silent stream is aborted after 45 seconds and counts as a drop.
  - A `log` event goes to `UpdateLog.add(host, line)`. A `step` event calls `onStep`. A `downloading` step clears the lines of that host first.
  - `registry.add` starts a watcher. `registry.remove` stops it, clears its lines and drops its presence.
  - `stop()` ends every watcher.
  - An error inside one watcher does not stop the others.
  - `UpdateLog` keeps the last 200 lines for each host. `clear` empties one host. `onLine` listeners get each line. An unsubscribed listener gets nothing.
- [ ] **Step 2: Run** `bun test server/test/nodewatcher.test.ts server/test/updatelog.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the three. Each host gets one loop. The loop opens the stream and reads events until the stream ends or the 45-second timer fires. Then it waits and retries. The host `local` has no watcher.
- [ ] **Step 4: Run** `bun test server` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): the hub watches the event stream of each node`.

### Task 6: The hub streams and the record

**Files:**
- Modify: `server/src/updaterecord.ts`, `server/src/updatetracker.ts`, `server/src/app.ts` (`/api/events` and a new `/cli/api/events`), `server/src/hubmain.ts`
- Test: `server/test/updaterecord.test.ts`, `server/test/updatetracker.test.ts`, `server/test/app.test.ts`

**Interfaces:**
- Consumes: `createNodeWatchers`, `UpdateLog` and `Presence` (Task 5), and `UpdateHooks` (Task 1).
- Produces:
  - `UpdateEntry` gains `step?: string` and `stepDetail?: string`. The functions `valid` and `clean` in `updaterecord.ts` accept them. A final `status` removes both.
  - `Deps` gains `updateLog?: UpdateLog` and `presence?: { list(): Presence[]; onChange(fn: (p: Presence) => void): () => void }`.
  - `GET /api/events` (browser) and `GET /cli/api/events` (CLI login) send a `snapshot` with `{ updates, logs, presence }`. Then they send `update`, `log` and `presence` events. Both routes share one function.
  - `createUpdateTracker` takes `presence?: { onChange(fn: (p: Presence) => void): () => void }`. Suppose a host has a `running` entry. If a presence event says `online` with a `version` equal to the target, the tracker writes `updated` at once. It uses the same `settle` path as the poll.
  - `hubmain.ts` creates the `UpdateLog`, the watchers and the presence list. It passes `{ onStep, onLog }` hooks to the hub's own updater (host `local`). The hook `onStep` writes `step` and `stepDetail` into the `local` entry while that entry runs. The hook `onLog` calls `UpdateLog.add("local", line)`. The `onStep` of a node watcher does the same for the entry of that host. If no entry is `running`, it writes nothing. The value of `stepDetail` is `client` or `detail`, 200 characters at most.

- [ ] **Step 1: Write the failing tests.**
  - Record: `step` and `stepDetail` round-trip through `set` and the file. A final `status` drops them. The `update` event carries them.
  - Both stream routes give 401 without a login. The first event is `snapshot` with `updates`, `logs` and `presence`. A later `log`, `presence` and `update` reach two connected subscribers. A closed subscriber is removed from every source (count the listeners). The response has no `transfer-encoding` header.
  - Tracker: the presence shortcut writes `updated`. A presence event with the old version does not. Without presence events, the poll still settles.
  - `onStep` with no `running` entry writes nothing.
- [ ] **Step 2: Run** `bun test server/test/updaterecord.test.ts server/test/updatetracker.test.ts server/test/app.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** them. Both stream routes use one helper. The helper builds the snapshot and subscribes to the three sources.
- [ ] **Step 4: Run** `bun test server` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): the hub sends steps, output lines and presence`.

### Task 7: The page

**Files:**
- Modify: `web/src/lib/api.ts`, `web/src/lib/events.ts`, `web/src/lib/UpdateBanner.svelte`, `web/src/lib/HostPicker.svelte`
- Create: `web/src/lib/updateoutput.ts`, `web/src/lib/UpdateOutput.svelte`
- Test: `web/src/lib/events.test.ts`, `web/src/lib/updatebanner.test.ts`, `web/src/lib/updateoutput.test.ts`

**Interfaces:**
- Consumes: the hub stream of Task 6.
- Produces:
  - `HostInfo.status` gains `"restarting"`. `UpdateEntry` gains `step?: string` and `stepDetail?: string`. `api.ts` exports `Presence` and `LogLine = { line: string; at: string }`.
  - `connectEvents` reads the `snapshot` as `{ updates, logs, presence }`. It writes `["updates"]` and `["logs"]` (`Record<string, LogLine[]>`), and it patches `["hosts"]` for each presence item.
  - A `log` event appends to `["logs"]`, cut to 200 lines for each host.
  - A `presence` event patches `status` and `version` of the matching host. It causes no refetch. The one exception is a change of `version`: then it invalidates `["hosts"]`.
  - An `update` event invalidates `["hosts"]` only for a new entry or a changed `status`.
  - `export function stepText(e: UpdateEntry): string` in `updateoutput.ts`. Examples: `installing` and `installing-client: C:\...`.

- [ ] **Step 1: Write the failing tests.**
  - `events.test.ts`: the new snapshot shape fills the three caches. A `presence` event patches the host and causes no refetch. A version change refetches. A `log` event appends and cuts at 200. An `update` that changes only `step` does not refetch. A status change does.
  - `updateoutput.test.ts`: `stepText` for each step, with and without `stepDetail`. The step `failed` is marked as an error.
  - `updatebanner.test.ts`: the banner shows `stepText` while an entry is `running`, and not after.
- [ ] **Step 2: Run** `bun test web/src`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the page code. `UpdateOutput.svelte` shows the lines of one host. The newest line is at the bottom. The panel follows new lines while it is open. It is closed by default for a finished update. `HostPicker.svelte` and `UpdateBanner.svelte` show the step text and the panel. A host with the status `restarting` shows "restarting".
- [ ] **Step 4: Run** `bun test web/src` and `bun run --cwd web check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): show update steps, output lines and node presence`.

### Task 8: The CLI

**Files:**
- Modify: `cli/src/hub.ts`, `cli/src/updateall.ts`, `README.md`
- Test: the existing test files of `updateAll` and of the hub client in `cli/test/`

**Interfaces:**
- Consumes: `GET /cli/api/events` (Task 6).
- Produces:
  - `hubClient(...)` gains `stream(path: string, opts?: { signal?: AbortSignal }): AsyncIterable<{ event: string; data: string }>`. It renews the login and retries once after a 401, as `request` does.
  - `updateAll` opens the stream before the first update. It prints each `log` line of the machine it updates as `[<host>] <line>`. It reopens the stream after the hub restarts.

- [ ] **Step 1: Write the failing tests.**
  - `stream` parses events and sends the `Authorization` header. It renews once after a 401, and it ends on abort.
  - `updateAll` with a fake hub that sends log lines: the lines appear in order, with the host id in front. The result table is unchanged.
  - With `--json`, the lines go to standard error and the result stays on standard output.
  - If the stream fails to open, `updateAll` still updates every machine and prints the table.
  - If the stream ends while the hub restarts, `updateAll` reopens it and the run finishes.
  - The machine order is still the nodes first, then the hub.
- [ ] **Step 2: Run** `bun test ./cli`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** them. If `cli` already imports from `server`, use the parser in `server/src/ssereader.ts`. If it does not, write the small parser in `cli/src/` and test it there. Update the README section "Update every machine with one command". Describe the live lines and the `--json` rule. Describe the order of an upgrade: the nodes first, then the hub.
- [ ] **Step 4: Run** `bun test server web/src ./cli`, `bun run typecheck` and `bun run --cwd web check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): update --all-nodes prints the output of each update`.

### Task 9: End to end

**Files:**
- Modify: `server/test/e2e.test.ts`
- Modify only for a new Windows-relevant test file: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the test** in the style of the existing e2e tests.
  - Use a real hub and a real node. The node has a fake updater that emits steps and lines through its `NodeEvents`.
  - Connect two subscribers to the hub `/api/events`.
  - Start an update from the hub. Both subscribers see the steps, the lines and the final status.
  - Stop the node. Both subscribers see `offline`. Start it again. Both see `online`.
  - A subscriber that connects in the middle of an update gets the current step and the lines so far.
- [ ] **Step 2: Run** `bun test server/test/e2e.test.ts`. Expected: PASS, because all earlier tasks are in. If the test fails, report the cause. Do not weaken the test.
- [ ] **Step 3: Commit** `test: node events end to end`.

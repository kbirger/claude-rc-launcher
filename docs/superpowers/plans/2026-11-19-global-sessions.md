# Global Sessions View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Sessions view and an Instances view that show every node, with node chips as the filter, and remove the node drop-down.

**Architecture:** Each node keeps a cached list of the sessions of all its instances (`SessionIndex`). The cache refreshes on a timer. The timer is slow while nobody asks and fast while someone asks. The hub asks each node for its list (`GET /api/sessions`) and merges the answers. The web app polls the hub endpoint and filters by node chips.

**Tech Stack:** Bun, Hono, `bun test` (server). SvelteKit, Svelte 5, TanStack Query, shadcn-svelte, vitest (web).

**Spec:** `docs/superpowers/specs/2026-11-19-global-sessions-design.md`

## Global Constraints

- Run `export PATH="$HOME/.bun/bin:$PATH"` first. Bun is not on the PATH by default.
- Server tests: `bun test server/test/<file>`. Web tests: `bun run --cwd web test <path>`. Types: `bun run typecheck` and `bun run --cwd web check`.
- Passive scan interval 5 minutes (`300_000` ms). Active scan interval 10 seconds (`10_000`). Active window 2 minutes (`120_000`) after the last request. These are starting values.
- The page polls the global list every 15 seconds (`SESSIONS_POLL_MS`).
- No node pushes to the hub. The hub opens every connection.
- The role for the new routes is `read`.
- Commit messages are one short imperative sentence with no prefix (see `git log`). Docs and UI text use plain English, American spelling.

## Review Focus

- Two sessions with the same id on two nodes: the list must not crash on a duplicate key. Task 6 pins it.
- One node offline and one node too old (404): the other nodes still show, and a notice names both. Task 3 and Task 6 pin it.
- A saved chip for a node that no longer exists: the selection drops it and the list shows all nodes, not an empty list. Task 4 pins it.
- A request that comes while the first scan runs: it waits for that scan and does not start a second one. Task 1 pins it.
- A scan that fails after a good scan: the old list stays and the answer does not fail. Task 1 pins it.

---

### Task 1: `SessionIndex`, the node cache

**Files:**
- Create: `server/src/sessionindex.ts`
- Modify: `server/src/sessioncatalog.ts` (export `mapLimit` and add `liveOf`)
- Test: `server/test/sessionindex.test.ts`

**Interfaces:**
- Produces, in `sessioncatalog.ts`, this function:

```ts
export function liveOf(info: LiveInfo): { status?: string, remoteControl: boolean }
```

  The body is the field-by-field copy now inside `InstanceSessions.list` (lines 174-177). Make `list` call it.
- Produces, in `sessionindex.ts`:

```ts
export type SessionRow = SessionSummary & { instance: { id: string, name: string, path: string, state: string } }
export type SessionsAnswer = { scannedAt: string, sessions: SessionRow[] }
export type SessionIndexOptions = {
  instances: Instances
  catalog: SessionCatalog
  passiveMs?: number
  activeMs?: number
  windowMs?: number
  concurrency?: number
  now?: () => number
}
```

  - `export class SessionIndex` with `constructor(o: SessionIndexOptions)`, `get(): Promise<SessionsAnswer>`, `scan(): Promise<void>`, `invalidate(): void`, `nextDelayMs(): number`, `start(): void`, `stop(): void`.

- [ ] **Step 1: Write the failing tests** in `server/test/sessionindex.test.ts`. Use a fake `Instances` with `list` and `claudeHome`. Use a fake catalog with `instance(h).list()` and `readLive(home)`. Count the scans and inject `now`. Tests:
  - `scan lists the sessions of every instance with the instance fields` (two instances, rows carry `instance: { id, name, path, state }`).
  - `an instance that cannot be read is left out and the scan still succeeds` (one `claudeHome` rejects).
  - `get answers from the copy and does not scan again inside the active interval` (two `get()` calls, one scan).
  - `get starts one scan when the copy is older than the active interval and still answers with the old copy`.
  - `a get during the first scan waits for it and runs no second scan` (two parallel `get()` calls before the first scan ends: one scan, equal answers).
  - `a failed scan keeps the old copy` (second scan rejects at `instances.list`, `get()` still returns the first answer).
  - `get replaces the live status with a fresh read` (stored row has no `live`, `readLive` now reports the session busy: the answer row has `live: { status: "busy", remoteControl: false }` and the stored copy is not changed).
  - `nextDelayMs is the active interval inside the window and the passive interval after it` (move `now`).
  - `invalidate runs a scan again after a running scan ends` (call `invalidate()` during a scan: two scans in total).

- [ ] **Step 2: Run** `bun test server/test/sessionindex.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `SessionIndex` in `server/src/sessionindex.ts` as the Interfaces block says. Rules:
  - `scan` is single-flight: a second call while one runs returns the same promise. It lists instances, then reads each one's `claudeHome(id)` and `catalog.instance(h).list()` with `mapLimit(items, concurrency ?? 4, fn)`. It keeps a `Map<instanceId, home>` for the live overlay. An instance that throws is skipped. If `instances.list` throws, it keeps the old copy and logs with `console.error`.
  - `get` records `lastRequestAt`. If there is no copy, it waits for the first scan. If that scan fails, it rejects with `new HttpError(503, "could not list sessions")`. If the copy is older than `activeMs`, it starts a background `scan()`. Then it returns a copy with `live` replaced from `catalog.readLive(home)` for each instance. If a read rejects, the stored value stays. It never changes the stored rows.
  - `start` runs `scan()` at once and then reschedules with `setTimeout(tick, nextDelayMs())` and calls `unref` on the timer. `stop` clears the timer.
  - When `instances.claudeHome` is not defined, `get` rejects with `new HttpError(501, "sessions are not available on this host")`.
  - Default values are the starting values in Global Constraints.

- [ ] **Step 4: Run** `bun test server/test/sessionindex.test.ts server/test/sessioncatalog.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** the new files, the changed file, and `docs/superpowers` (the spec and this plan).

```bash
git add server docs/superpowers
git commit -m "Add the node cache of sessions for all instances"
```

---

### Task 2: The node route `GET /sessions`

**Files:**
- Modify: `server/src/app.ts` (`InstanceApiDeps`, `instanceApi`, `createApp`, `createNodeApp`, next to `sessionCatalogFor`)
- Modify: `server/src/roles.ts` (the `read` rule list)
- Test: `server/test/sessionindex-route.test.ts`

**Interfaces:**
- Consumes: `SessionIndex` from Task 1.
- Produces: `InstanceApiDeps.sessionIndex?: SessionIndex`. `GET /sessions` on the node API returns `SessionsAnswer`. A node API call after `POST`, `PATCH` or `DELETE` under `/instances` that succeeds calls `sessionIndex.invalidate()`.

- [ ] **Step 1: Write the failing tests** in `server/test/sessionindex-route.test.ts`, built like the app tests in `server/test/hosts-sessions.test.ts` (a fake `sessionIndex` object with `get` and `invalidate`):
  - `GET /sessions answers with the index answer`.
  - `a successful POST /instances calls invalidate` and `a failed one (status 400) does not`.
  - `GET /instances does not call invalidate`.
  - In `server/test/roles-routes.test.ts` the existing walk of the route table must pass: this fails now because `/sessions` has no row. Run it as part of Step 2.

- [ ] **Step 2: Run** `bun test server/test/sessionindex-route.test.ts server/test/roles-routes.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** In `instanceApi`, add `r.get("/sessions", async (c) => c.json(await index.get()))` where `index = deps.sessionIndex ?? new SessionIndex({ instances, catalog: sessionCatalog })`. Add a middleware `r.use("/instances/*", ...)` and `r.use("/instances", ...)` that calls `await next()` and then `index.invalidate()` for a non-GET request with `c.res.status < 400`. In `createApp` and `createNodeApp`, create one index next to `sessionCatalogFor(cfg)`, call `index.start()`, and pass it as `sessionIndex` to every `instanceApi` call. In `roles.ts`, add `"/sessions"` to the `read` list of `GET` rules.

- [ ] **Step 4: Run** the same command. Expected: PASS. Then run `bun test server` and make sure that nothing else broke.

- [ ] **Step 5: Commit.**

```bash
git add server
git commit -m "Serve the cached session list on the node API"
```

---

### Task 3: The hub endpoint that merges the nodes

**Files:**
- Create: `server/src/allsessions.ts`
- Modify: `server/src/hosts.ts` (export `OFFLINE`), `server/src/app.ts` (mount in `createApp`), `server/src/roles.ts`
- Test: `server/test/allsessions.test.ts`

**Interfaces:**
- Consumes: the node route of Task 2 (`SessionsAnswer`).
- Produces this function. Mount it at `/api/sessions`. `GET /` answers with `HubSessions`.

```ts
export function allSessionsApi(o: { cfg: Config, local: Hono, registry: HostRegistry, timeoutMs?: number }): Hono
type HubSessions = {
  sessions: Array<SessionRow & { host: { id: string, name: string } }>
  hosts: Array<{ id: string, name: string, status: "ok" | "offline" | "error" | "unsupported", error?: string, scannedAt?: string }>
}
```

- [ ] **Step 1: Write the failing tests** in `server/test/allsessions.test.ts`, built like `server/test/hosts-sessions.test.ts` (`HostRegistry.memory` and a fake `HostClient.call`):
  - `merges the local node and a remote node and adds the host to each row`.
  - `a remote node that answers 404 or 501 is unsupported and the call still answers 200`.
  - `a remote node that throws HostError("unreachable") is offline and its rows are missing, the other rows are present`.
  - `a remote node that answers a body that is not an answer is error with the text "bad response"`.
  - `the local node always has id "local" and the name of the hub`.
  - `a node that is slower than timeoutMs is an error with the reason timeout` (a client that never resolves, with `timeoutMs: 20`).
  - `a user with the read role can call it` (roles walk in `roles-routes.test.ts`).

- [ ] **Step 2: Run** `bun test server/test/allsessions.test.ts server/test/roles-routes.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** `allSessionsApi`. For the local node call `local.request("/sessions")`. For each `registry.list()` entry call `client.call("GET", "/api/sessions", { timeoutMs })`. Run them in parallel with `Promise.all`. Map `HostError` with `OFFLINE.includes(e.reason) ? "offline" : "error"` as the host list does in `hostsApi`. Export `OFFLINE` from `hosts.ts`. Default `timeoutMs` is `10_000`, taken from `deps.requestTimeoutMs` in `createApp`. Mount with `api.route("/sessions", allSessionsApi({ cfg, local, registry, timeoutMs }))` before `api.route("/hosts", forwarding())`. Share the `local` instance API with `forwarding()`: build the local `instanceApi` once and use it in both. Add `"/sessions"` to the `read` rules in `roles.ts`.

- [ ] **Step 4: Run** `bun test server`. Expected: PASS. Run `bun run typecheck`.

- [ ] **Step 5: Commit.**

```bash
git add server
git commit -m "Merge the session lists of all nodes on the hub"
```

---

### Task 4: Web data, order, and node filter state

**Files:**
- Modify: `web/src/lib/features/sessions/api.ts`, `queries.ts`, `format.ts`, `index.ts`
- Create: `web/src/lib/features/sessions/sessionorder.ts`, `web/src/lib/features/hosts/nodefilter.ts`
- Modify: `web/src/lib/features/hosts/index.ts`
- Test: `web/src/lib/features/sessions/sessionorder.test.ts`, `web/src/lib/features/hosts/nodefilter.test.ts`, `web/src/lib/features/sessions/api.test.ts`

**Interfaces:**
- Produces, in `api.ts`:

```ts
export type GlobalSession = Session & { instance: { id: string, name: string, path: string, state: string }, host: { id: string, name: string } }
export type HostSessions = { id: string, name: string, status: "ok" | "offline" | "error" | "unsupported", error?: string, scannedAt?: string }
export type AllSessions = { sessions: GlobalSession[], hosts: HostSessions[] }
```

  - `export const listAllSessions = (): Promise<AllSessions>` (`GET /api/sessions`)
- Produces, in `queries.ts`: `export const allSessionsQuery = () => ({ queryKey: ["all-sessions"] as const, queryFn: listAllSessions, staleTime: SESSIONS_STALE_MS, refetchInterval: SESSIONS_POLL_MS, refetchOnWindowFocus: true, retry: false as const })`.
- Produces, in `sessionorder.ts`: `export function sortSessions(rows: GlobalSession[]): GlobalSession[]` (a new array, input not changed) and `export function sessionKey(s: GlobalSession): string` (`host.id|instance.id|id`).
- Produces, in `format.ts`: `export function globalMatches(s: GlobalSession, filter: string): boolean`. If `sessionMatches(s, filter)` is true, it returns true. If the filter is in the host name or in the instance name, it also returns true. The match ignores case.
- Produces, in `nodefilter.ts`, these functions:

```ts
toggleNode(selected: readonly string[], id: string): string[]
pruneNodes(selected: readonly string[], hosts: readonly { id: string }[]): string[]
inFilter(selected: readonly string[], id: string): boolean  // an empty selection matches all
readNodes(): string[]
writeNodes(ids: readonly string[]): void
```

  `readNodes` and `writeNodes` use the `sessionStorage` key `"claude-rc-nodes"` with a JSON array. If the storage is missing, throws, or holds anything but an array of strings, `readNodes` returns `[]`.

- [ ] **Step 1: Write the failing tests.**
  - `sessionorder.test.ts`: `busy live sessions come first, then idle live, then the others by lastActiveAt newest first`, `equal times keep a stable order by id`, `the input array is not changed`, and `sessionKey differs for the same session id on two hosts`.
  - `nodefilter.test.ts`: `toggleNode adds and removes`, `pruneNodes drops an id that is not a host`, `inFilter is true for any id when the selection is empty`, and `readNodes returns [] for broken JSON, a non-array, and a throwing storage`.
  - `api.test.ts`: `listAllSessions calls GET /api/sessions`. Follow the fetch mock in the existing tests.
  - A test for `globalMatches` in `format.test.ts`: matches a node name and an instance name.

- [ ] **Step 2: Run** `bun run --cwd web test src/lib/features/sessions src/lib/features/hosts`. Expected: FAIL.

- [ ] **Step 3: Implement** the files above. `sortSessions` uses `sessionState(s)` from `format.ts` for `live` and `busy`. Export the new names from the two `index.ts` files.

- [ ] **Step 4: Run** the same command. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add web
git commit -m "Add the global session query, order and node filter helpers"
```

---

### Task 5: Node chips and the filter in the shell

**Files:**
- Create: `web/src/lib/features/hosts/NodeChips.svelte`
- Modify: `web/src/lib/shell/context.ts`, `web/src/lib/shell/Shell.svelte`, `web/src/lib/features/hosts/index.ts`
- Test: `web/src/lib/features/hosts/NodeChips.test.ts`

**Interfaces:**
- Consumes: `toggleNode`, `pruneNodes`, `readNodes`, `writeNodes` from Task 4.
- Produces, in `context.ts`, on `Shell`:

```ts
readonly nodes: { readonly selected: string[], toggle(id: string): void, only(id: string): void, clear(): void }
```
- Produces: `NodeChips.svelte` with props `{ hosts, selected, ontoggle, onclear }`. The types are `HostInfo[]`, `string[]`, `(id: string) => void` and `() => void`. If `hosts.length < 2`, it renders nothing. It renders an "All" chip and one chip per host. If `selected` is empty, the "All" chip is pressed. Each chip is a button with `aria-pressed`. A host that is not `ok` shows its status in the chip text and stays pressable.

- [ ] **Step 1: Write the failing test** `NodeChips.test.ts`, in the style of `NodeList.test.ts`. Tests: `renders nothing for one host`, `shows All pressed when nothing is selected`, `a click on a chip calls ontoggle with the host id`, `a click on All calls onclear`, `an offline host shows its status`.

- [ ] **Step 2: Run** `bun run --cwd web test src/lib/features/hosts/NodeChips.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** `NodeChips.svelte` with the shadcn `Button` (size `touch`) in a wrapping flex row. In `Shell.svelte`, hold `let selected = $state(readNodes())` and expose it as `nodes`. Call `writeNodes` on each change. If the result differs, set `selected = pruneNodes(selected, hostsQ.data)` in the existing `hostsQ.data` effect. `only(id)` sets `[id]`.

- [ ] **Step 4: Run** the test again, then Task 4's tests. Expected: PASS. Run `bun run --cwd web check`.

- [ ] **Step 5: Commit.**

```bash
git add web
git commit -m "Add node chips and keep the node filter in the shell"
```

---

### Task 6: The Sessions view

**Files:**
- Create: `web/src/lib/features/sessions/SessionCard.svelte` (the row markup now in `SessionList.svelte`), `web/src/lib/features/sessions/GlobalSessionList.svelte`
- Delete: `web/src/lib/features/sessions/SessionList.svelte`
- Modify: `web/src/lib/features/sessions/index.ts`, `web/src/routes/sessions/+page.svelte`
- Test: `web/src/lib/features/sessions/GlobalSessionList.test.ts` (a wrapper component like `SessionViewHarness.svelte` can give the test the shell context)

**Interfaces:**
- Consumes: `allSessionsQuery`, `sortSessions`, `sessionKey`, `globalMatches` (Task 4), `inFilter` and `NodeChips` (Task 4 and 5).
- Produces: `GlobalSessionList.svelte` with props `{ hosts, nodes, host, instance, now, ontoggle, onclear }`. The types are `HostInfo[]`, `string[]`, `string`, `string`, `number`, `(id: string) => void` and `() => void`. `host` and `instance` are the instance filter from the address, and they are empty for no filter. Also produces `SessionCard.svelte` with props `{ s: GlobalSession, now: number }`. It shows the node name and the instance name next to the existing fields.

- [ ] **Step 1: Write the failing tests** `GlobalSessionList.test.ts`:
  - `shows sessions from all nodes sorted with live sessions first`.
  - `the chips filter the rows` (select one node: only its rows).
  - `the text filter matches the node name`.
  - `two sessions with the same id on two nodes both render` (the key is `sessionKey`).
  - `a node that is offline and a node that is unsupported appear in a notice, and the rows of the other node still show`. The unsupported text is `<name>: update this node to list its sessions`. The offline text is `<name>: not answering`.
  - `an instance filter shows only that instance and a chip that links to /sessions to remove it`.
  - `says "No sessions yet." when the answer has no rows and no notice`.

- [ ] **Step 2: Run** `bun run --cwd web test src/lib/features/sessions/GlobalSessionList.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** Move the row markup of `SessionList.svelte` into `SessionCard.svelte` (the link target is `sessionsHref({ host: s.host.id, instance: s.instance.id, session: s.id })`). Build `GlobalSessionList.svelte` from the sticky filter bar of `SessionList.svelte`, with `NodeChips` above the filter box. Delete `SessionList.svelte` and its export. In `routes/sessions/+page.svelte`, take `host` and `instance` from the address only (no `shell.flow.selected`). When `session` is set, render `SessionView` as now. Otherwise render `GlobalSessionList` with `shell.hosts`, `shell.nodes.selected`, `shell.nodes.toggle`, `shell.nodes.clear`.

- [ ] **Step 4: Run** `bun run --cwd web test` and `bun run --cwd web check`. Expected: PASS and no type errors (fix any reference to `SessionList`).

- [ ] **Step 5: Commit.**

```bash
git add web
git commit -m "Show all sessions of all nodes on the Sessions view"
```

---

### Task 7: The Instances view and the New dialog node field

**Files:**
- Modify: `web/src/routes/instances/+page.svelte`, `web/src/lib/startflow.svelte.ts`, `web/src/lib/startflow.test.ts`, `web/src/lib/features/new-instance/NewDialog.svelte`, `web/src/lib/shell/Shell.svelte`
- Test: `web/src/lib/startflow.test.ts`, `web/src/lib/features/new-instance/NewDialog.test.ts` (create the second file and follow `InstanceList.test.ts` for the wrapper component)

**Interfaces:**
- Produces, in `startflow.svelte.ts`: `pick(id: string): void` sets the selected host and clears the outcome. It does not close the dialog. It replaces `select`, which is removed.
- Produces: `NewDialog` props add `hosts: HostInfo[]` and `onhost: (id: string) => void`. When `hosts.length > 1`, the dialog shows a node `Select` as its first field, set to `host`. A change calls `onhost`.

- [ ] **Step 1: Write the failing tests.**
  - `startflow.test.ts`: replace the tests of `select` with `pick changes the host and keeps the dialog open` and `pick clears the start error`.
  - `NewDialog.test.ts`: `shows a node field for two hosts and none for one`, and `changing the node calls onhost with the id`.

- [ ] **Step 2: Run** `bun run --cwd web test src/lib/startflow.test.ts src/lib/features/new-instance`. Expected: FAIL.

- [ ] **Step 3: Implement.** In `Shell.svelte`, replace `select` with `pickHost(id)`, which calls `flow.pick(id)` and then `remember(id)`. Pass `hosts` and `onhost={pickHost}` to `NewDialog`, and keep `{#key flow.selected}`. A node change restarts the dialog, so the node field must be the first field. In `instances/+page.svelte`, an empty `shell.nodes.selected` means all nodes show. Otherwise the selected nodes show. Render `NodeChips` at the top. For each shown node, render `InstanceList` with `host={h.id}`. If more than one node shows, put a heading with the node name above each list. Pass `startError` only for the node equal to `shell.flow.selected`. If exactly one chip is selected, the "+ New" button calls `shell.flow.pick(selected[0])` first. Then it calls `shell.flow.openNew()`.

- [ ] **Step 4: Run** `bun run --cwd web test` and `bun run --cwd web check`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add web
git commit -m "Show instances of all nodes and let the New dialog pick a node"
```

---

### Task 8: Navigation, header, Nodes page and Permissions page

**Files:**
- Modify: `web/src/lib/shell/BottomNav.svelte`, `web/src/lib/shell/MenuSheet.svelte`, `web/src/lib/shell/Shell.svelte`, `web/src/lib/shell/context.ts`, `web/src/routes/+page.svelte`, `web/src/routes/nodes/+page.svelte`, `web/src/routes/permissions/+page.svelte`
- Delete: `web/src/lib/features/hosts/HostPicker.svelte` (and its export)
- Test: `web/src/lib/shell/BottomNav.test.ts` (create), existing tests that mention `HostPicker`

**Interfaces:**
- Consumes: `shell.nodes.only` (Task 5), `UpdateOutput`, `showsFinishedPanel`, `lastEntry` from `#lib/features/updates`.
- Produces: bottom bar items Sessions (`/sessions`, left) and Instances (`/instances`, right). Menu items: Sessions, Instances, Nodes, Updates, Appearance. The home address `/` and the logo link go to `/sessions`.

- [ ] **Step 1: Write the failing test** `BottomNav.test.ts`: `has Sessions and Instances links and a Menu button` and `marks the link of the current path with aria-current`.

- [ ] **Step 2: Run** `bun run --cwd web test src/lib/shell`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `BottomNav.svelte`: `left = [{ href: "/sessions", label: "Sessions", icon: Messages }]`, `right` stays Instances. Nodes leaves the bar.
  - `MenuSheet.svelte`: add Sessions first in `items`.
  - `Shell.svelte`: delete the `HostPicker` block and its import. Delete the finished-update panel block (`showsFinishedPanel` with `{#key flow.selected}`). Remove `select` from `setShell` and from `Shell` in `context.ts`. Point the logo link to `/sessions`.
  - `routes/+page.svelte`: `goto("/sessions", { replaceState: true })`.
  - `routes/nodes/+page.svelte`: `NodeList` `onselect` becomes `a function that calls `shell.nodes.only(id)` and then `goto("/instances")`` and `selected` becomes the single selected chip or `""`. Below the list, for each host with `showsFinishedPanel(lastEntry(shell.updates, h.id))`, render `<UpdateOutput host={h.id} open={false} />`.
  - `routes/permissions/+page.svelte`: take `host` from the address only.

- [ ] **Step 4: Run** `bun run --cwd web test`, `bun run --cwd web check`, and `bun run typecheck`. Expected: PASS. Then run the app and look at it (see the `run` skill): with two nodes, the chips show on both views and the header has no node drop-down.

- [ ] **Step 5: Commit.**

```bash
git add web
git commit -m "Replace the node drop-down with Sessions and Instances navigation"
```

---

### Task 9: Documentation

**Files:**
- Modify: `docs/api.md`, `docs/web-ui.md`, `docs/multi-host.md`, `docs/session-files.md`

- [ ] **Step 1: Update the docs.** In `docs/api.md` describe `GET /api/sessions` (hub answer shape, host statuses) and the node route `GET /api/sessions` (answer shape, `scannedAt`). In `docs/web-ui.md` replace the node drop-down text with the chips, the two views, and the new bottom bar. In `docs/multi-host.md` say that a node needs the new version to list its sessions. In `docs/session-files.md` describe the node cache and its two scan intervals.

- [ ] **Step 2: Run** `grep -rn "drop-down\|HostPicker\|host picker" docs README.md` and fix each hit that is now wrong.

- [ ] **Step 3: Commit.**

```bash
git add docs README.md
git commit -m "Document the global Sessions view and the node chips"
```

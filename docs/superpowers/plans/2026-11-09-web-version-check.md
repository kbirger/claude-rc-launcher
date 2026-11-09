# Version Check and Node Update in the Web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The web UI shows the version of the hub and every node, warns when one is stale, and updates it with a click. The hub keeps a record of updates and streams changes to open pages.

**Architecture:** The hub decides what is stale and sends the result with the host list (`stale`, `target`), so the browser holds no comparison rules. Each machine reports the versions of its client copies in `GET /node`. The hub caches the latest GitHub release, stores the last update of each host in `<stateDir>/updates.json`, and streams changes over SSE. The web app uses TanStack Query for the host list, the latest release and the record. A banner offers the hub update and the node update as two separate clicks.

**Tech Stack:** Bun, TypeScript, Hono (`hono/streaming` for SSE), Svelte 5, Vite, `@tanstack/svelte-query`, `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-09-web-version-check-design.md`

**Plan decision that differs from the spec text:** the spec says the web tests cover the stale rules as plain functions. This plan puts the rules on the hub (Task 6) so that the server and the browser never hold two copies. The web tests then cover the banner model (Task 10), and the server tests cover the rules (Tasks 1 and 6).

## Global Constraints

- Bun and TypeScript on the server. Svelte 5 and Vite in `web`. Follow the existing style. Run `bun test server web/src ./cli` and `bun run typecheck` from the repo root, and `bun run --cwd web check` for Svelte.
- Tests need no network, no systemd and no root. Code that reads GitHub takes `fetch` as an input.
- The server work reuses the existing update code (`createServiceUpdater`, `findClients`, `downloadAsset`). There must be no second download and rollback implementation.
- The browser never names a download URL and never calls GitHub. The update body carries at most `release`. `POST /update` accepts the version with or without a leading `v`. The server adds the `v` before it builds a URL. `GET /api/latest` returns the version without the `v`.
- Stale rules: the hub is stale when its service or client is older than the latest release. A node is stale when its service or client is older than the hub's service version. The version `dev` and any version with `+` (local build) are unknown: never stale, never a target. Versions compare as numbers. A pre-release sorts below its release. With two client copies, the older one decides.
- Latest release cache: one hour. Client version cache on a node: 60 seconds. Host list and latest-release query stale time: five minutes, refetch on window focus. Update wait limit: 90 seconds. Offline warning after a hub update: shown when the record says the hub `updated` within the last 10 minutes and a node is offline.
- Record file: `<stateDir>/updates.json`, written atomically like `managed-hosts.json`. Statuses: `running`, `updated`, `up-to-date`, `failed`, `rolled back`, `unknown`.
- Two clicks: one for the hub, one for the nodes. No automatic update. No per-step progress. No migration of other web code to TanStack Query.

## Review Focus

- GitHub does not answer: the host list and the page must still load. `GET /api/latest` returns the last good value or a clear error. The UI shows "latest unknown" and offers no hub update.
- A node with no client copy, or a client that does not answer `--version`: the node is not stale for the client and shows "no client". It is never marked stale from missing data.
- The hub restarts during its own update: the stream drops, reconnects, and the first message holds the record. The entry moves from `running` to `updated` or `rolled back` with no click.
- Two people start an update on the same machine: the second gets the 409 from the updater and sees its message. The record keeps one entry.
- The session expires while the stream is open: `GET /api/events` answers 401 on reconnect. The page must not loop on reconnects. It reconnects at the next window focus.

---

### Task 1: Version rules

**Files:**
- Create: `server/src/versions.ts`
- Test: `server/test/versions.test.ts`

**Interfaces:**
- Produces:
  - `normalizeVersion(v: string): string` strips one leading `v`.
  - `isKnownVersion(v: string | undefined): v is string` is true only for `X.Y.Z` with an optional `-prerelease` and no `+`.
  - `compareVersions(a: string, b: string): number` compares numerically. A pre-release is lower than its release. It needs two known versions.
  - `isStale(current: string | undefined, target: string | undefined): boolean` is true only when both are known and `current` is lower.
  - `stalestVersion(versions: (string | undefined)[]): string | undefined` returns the lowest known version, or `undefined` if none is known.

- [ ] **Step 1: Write the failing tests** in `server/test/versions.test.ts`. Cases: `normalizeVersion("v1.2.3")` is `"1.2.3"` and `"1.2.3"` is unchanged. `isKnownVersion` is false for `"dev"`, `"0.8.3+main.abc1234.dirty"`, `""` and `undefined`. `compareVersions("1.10.0", "1.9.0") > 0` (numbers, not text). `compareVersions("1.2.3-rc.1", "1.2.3") < 0`. `isStale("0.8.2", "0.8.3")` is true. `isStale("dev", "0.8.3")`, `isStale("0.8.3", "dev")`, `isStale(undefined, "0.8.3")` and `isStale("0.8.3", "0.8.3")` are false. `stalestVersion(["1.2.0", undefined, "1.1.9"])` is `"1.1.9"`, and `stalestVersion(["dev"])` is `undefined`.
- [ ] **Step 2: Run** `bun test server/test/versions.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** the five functions in `server/src/versions.ts`. Use one regex for the known form and split on `.` and `-`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `git add server/src/versions.ts server/test/versions.test.ts && git commit -m "feat(server): add version comparison rules"`.

### Task 2: Release tag with the `v` added

**Files:**
- Modify: `server/src/requests.ts` (`parseUpdateRequest`)
- Modify: `server/test/requests.test.ts`

**Interfaces:**
- Consumes: `normalizeVersion` from Task 1.
- Produces: `parseUpdateRequest(body): { release?: string }` where `release` always starts with `v` when present. The input is still checked with `RELEASE_TAG_RE`, so `"0.8.3"` and `"v0.8.3"` both give `"v0.8.3"`.

- [ ] **Step 1: Write the failing test**: `parseUpdateRequest({ release: "0.8.3" })` equals `{ release: "v0.8.3" }`, `{ release: "v0.8.3" }` equals `{ release: "v0.8.3" }`, and `{ release: "../x" }` still throws `HttpError` 400. Update any existing assertion in `requests.test.ts` that expected a bare tag to pass through.
- [ ] **Step 2: Run** `bun test server/test/requests.test.ts`. Expected: FAIL on the bare tag.
- [ ] **Step 3: Implement** the change in `parseUpdateRequest`: after the `RELEASE_TAG_RE` check, return `` `v${normalizeVersion(release)}` ``.
- [ ] **Step 4: Run** the test file and `bun test server/test/serviceupdate.test.ts server/test/hosts.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(server): add the v to a release tag before it reaches a download URL`.

### Task 3: Latest release on the hub

**Files:**
- Create: `server/src/latest.ts`
- Modify: `server/src/app.ts` (`Deps`, `createApp`)
- Modify: `server/src/hubmain.ts` (`startHub`)
- Test: `server/test/latest.test.ts`, `server/test/app.test.ts`

**Interfaces:**
- Consumes: `RELEASE_REPO` from `server/src/release.ts`, `normalizeVersion` from Task 1.
- Produces:
  - `type LatestRelease = { version: string; checkedAt: string }`
  - `createLatestRelease(o: { fetch: typeof fetch; now?: () => number; ttlMs?: number }): { get(): Promise<LatestRelease>; peek(): LatestRelease | undefined }`. `ttlMs` defaults to 3 600 000. `get` calls `https://api.github.com/repos/${RELEASE_REPO}/releases/latest` and reads `tag_name`. It returns the cache while it is fresh. If the call fails and a value exists, it returns the old value. If it fails and none exists, it throws `LatestError` (export the class). `peek` returns the cached value without a call.
  - `Deps` in `app.ts` gains `latest?: ReturnType<typeof createLatestRelease>`.
  - Route `GET /api/latest` returns `LatestRelease`. It returns 503 `{ error }` for `LatestError`, and 501 if `latest` is not set.

- [ ] **Step 1: Write the failing tests** in `latest.test.ts` with a fake `fetch` and a fake clock: a good answer gives `{ version: "0.8.3", checkedAt }` for tag `v0.8.3`. A second call inside one hour makes no new request. A call after one hour and one minute makes one. A failure with a cached value returns the cached value. A failure with no value throws `LatestError`. In `app.test.ts`: `GET /api/latest` returns 200 with the body, and 503 when `latest.get` throws `LatestError`.
- [ ] **Step 2: Run** `bun test server/test/latest.test.ts server/test/app.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `latest.ts`, then add the route in `createApp` inside the authenticated `api` router before the `api.all("*")` 404. In `startHub`, build `createLatestRelease({ fetch: globalThis.fetch })` and pass it to `createApp`.
- [ ] **Step 4: Run** the two test files. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): report the latest release from the hub`.

### Task 4: Client versions in `GET /node` and the host list

**Files:**
- Modify: `server/src/serviceupdate.ts` (add `clientVersions`)
- Modify: `server/src/app.ts` (`InstanceApiDeps`, `instanceApi` `/node`, `createNodeApp`)
- Modify: `server/src/hubmain.ts`, `server/src/nodemain.ts` (wire it)
- Modify: `server/src/hosts.ts` (`HostInfo`, the `GET /` handler)
- Test: `server/test/serviceupdate.test.ts`, `server/test/nodeapp.test.ts`, `server/test/hosts.test.ts`

**Interfaces:**
- Consumes: `findClients`, `UpdateEnv`, the existing private `versionOf`, `stalestVersion` from Task 1.
- Produces:
  - `type ClientVersion = { path: string; version?: string }` exported from `serviceupdate.ts`.
  - `createClientVersions(env: UpdateEnv, o?: { ttlMs?: number; now?: () => number }): () => ClientVersion[]`. It runs `findClients(env)` and `<path> --version` for each copy, and caches the list for `ttlMs` (default 60 000). Move `versionOf` out of `createServiceUpdater` so both use it.
  - `InstanceApiDeps` gains `clientVersions?: () => ClientVersion[]`. `GET /node` returns `{ ok, name, version, clone, clients }` where `clients` is `[]` when the dependency is missing.
  - `HostInfo` gains `clientVersion?: string`: `stalestVersion` of the copies' versions. The `GET /` handler reads it from each node's `/api/node` body (`clients`), and for `local` from `local.request("/node")` (the in-process Hono call).

- [ ] **Step 1: Write the failing tests.** In `serviceupdate.test.ts`: `createClientVersions` with one copy answering `claude-rc 0.8.2` gives `[{ path, version: "0.8.2" }]`. A copy that exits 1 gives an entry with no `version`. Two copies give two entries. No copy gives `[]`. A second call within 60 seconds runs no command. In `nodeapp.test.ts`: `GET /api/node` carries `clients`. In `hosts.test.ts`: a node whose `/api/node` returns clients `0.8.2` and `0.8.0` lists `clientVersion: "0.8.0"`. A node with no `clients` field has no `clientVersion`. The `local` entry has `clientVersion` from the local `/node`.
- [ ] **Step 2: Run** `bun test server/test/serviceupdate.test.ts server/test/nodeapp.test.ts server/test/hosts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as in the interfaces. In `hubmain.ts` and `nodemain.ts`, build the `UpdateEnv` once with `realUpdateEnv(cfg)` and pass `createClientVersions(env)` as `clientVersions`. The Windows node (`index.win.ts`) reports no `clients`, which stays valid.
- [ ] **Step 4: Run** the three files and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): report client versions from each node`.

### Task 5: Update record store

**Files:**
- Create: `server/src/updaterecord.ts`
- Test: `server/test/updaterecord.test.ts`

**Interfaces:**
- Produces:
  - `type UpdateStatus = "running" | "updated" | "up-to-date" | "failed" | "rolled back" | "unknown"`
  - `type UpdateEntry = { host: string; startedAt: string; finishedAt?: string; startedBy: string; from: string; to?: string; status: UpdateStatus; error?: string }`
  - `class UpdateRecord` with `static load(o: { stateDir: string; now?: () => Date }): Promise<UpdateRecord>`, `list(): UpdateEntry[]`, `set(e: UpdateEntry): Promise<void>` (replaces the entry of `e.host`, writes `<stateDir>/updates.json` atomically, then calls the listeners), `onChange(fn: (e: UpdateEntry) => void): () => void` (returns the unsubscribe function), and `reconcileHub(currentVersion: string): Promise<void>`.
  - `reconcileHub`: if the `local` entry is `running`, set it `updated` with `to: currentVersion` when `currentVersion !== from`, else `rolled back`, with `finishedAt` set. Other entries stay as they are.

- [ ] **Step 1: Write the failing tests** in `updaterecord.test.ts` with a temp directory: `load` on a missing file gives `[]`. `set` then `load` again returns the entry. A second `set` for the same host replaces it. `onChange` listeners get each change and stop after unsubscribe. `reconcileHub("0.8.3")` on a `running` local entry with `from: "0.8.2"` gives `updated`, and with `from: "0.8.3"` gives `rolled back`. A `running` entry of another host is not changed. A corrupt file loads as `[]` and the next `set` replaces it. No `.tmp` file stays after `set`.
- [ ] **Step 2: Run** `bun test server/test/updaterecord.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it. Write the file as `hostregistry.ts` does (temp file in the same directory, then `rename`).
- [ ] **Step 4: Run** the file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): keep a record of the last update of each host`.

### Task 6: Stale flags in the host list

**Files:**
- Modify: `server/src/hosts.ts` (`HostInfo`, the `GET /` handler, `hostsApi` options)
- Modify: `server/src/app.ts` (pass `latest`)
- Test: `server/test/hosts.test.ts`

**Interfaces:**
- Consumes: `isStale`, `isKnownVersion`, `normalizeVersion` (Task 1); `LatestRelease` via `latest.peek()` (Task 3); `clientVersion` (Task 4).
- Produces: `HostInfo` gains `stale: boolean` and `target?: string`. `hostsApi` options gain `latest?: { peek(): LatestRelease | undefined; get(): Promise<LatestRelease> }`. In the `GET /` handler, before the response, call `latest.get()` inside a `try` that ignores a failure.
  - `local`: `target` is the latest version when known. `stale` is `isStale(VERSION, target) || isStale(localClientVersion, target)`.
  - A node with status `ok`: `target` is the hub's `VERSION` when `isKnownVersion(VERSION)`, else absent. `stale` is `isStale(version, target) || isStale(clientVersion, target)`.
  - A node that is `offline` or `error`, or a `target` that is absent: `stale: false`.

- [ ] **Step 1: Write the failing tests** with a fake registry and a fake `latest`. The hub at `0.8.2` with latest `0.8.3` is stale with `target: "0.8.3"`. The hub at `0.8.3` with a client at `0.8.2` is stale. A hub at `dev` is not stale and a node under it has no `target` and is not stale. A node at `0.8.1` under a hub at `0.8.3` is stale with `target: "0.8.3"`. A node with an old client only is stale. A node with `0.8.3` and no clients is not stale. When `latest.get` rejects and `peek` is empty, the list still returns 200 and the hub is not stale.
- [ ] **Step 2: Run** `bun test server/test/hosts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it as in the interfaces.
- [ ] **Step 4: Run** the file and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): mark stale hosts in the host list`.

### Task 7: Record each update

**Files:**
- Modify: `server/src/hosts.ts` (a middleware for `POST /:host/update`)
- Create: `server/src/updatetracker.ts`
- Modify: `server/src/app.ts`, `server/src/hubmain.ts` (pass the record, call `reconcileHub` at start)
- Test: `server/test/updatetracker.test.ts`, `server/test/hosts.test.ts`

**Interfaces:**
- Consumes: `UpdateRecord` (Task 5); `UpdateReport` from `serviceupdate.ts`; the host client `call("GET", "/api/node")`.
- Produces: `createUpdateTracker(o: { record: UpdateRecord; hubVersion: string; probe(host: string): Promise<string | undefined>; now?: () => Date; waitMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> }): { begin(host: string, startedBy: string, from: string): Promise<void>; finish(host: string, report: UpdateReport | { status: "failed"; error: string }): Promise<void> }`.
  - `begin` sets a `running` entry.
  - `finish` maps the report: `up-to-date` gives `up-to-date`, `clients-only` gives `updated`, `failed` gives `failed` with `error`. For `restarting` on a node, it starts a background wait that calls `probe` every `intervalMs` (default 2 000) up to `waitMs` (default 90 000). The entry becomes `updated` when the version equals `report.to`. At the limit it becomes `rolled back` if `probe` answers the old version, else `unknown` with the reason "the node did not answer with the new version within 90 seconds". For `restarting` on `local` it does nothing: `reconcileHub` finishes that entry at the next start.
  - The middleware in `hostsApi` runs for `POST` on `/:host/update`. It reads `startedBy` as the audit line does (`u.username ?? u.sub ?? "unknown"`), calls `begin` before `next()`, then reads the answer with `c.res.clone().json()` and calls `finish`. A 409 or other error answer is recorded as `failed` with the error text, except a 409 that says another update runs, which leaves the running entry as it is.

- [ ] **Step 1: Write the failing tests.** Tracker tests with a fake `sleep` and `probe`: `up-to-date`, `clients-only` and `failed` reports finish at once. `restarting` on a node ends `updated` once `probe` returns the new version. It ends `rolled back` when `probe` keeps returning the old version to the limit. It ends `unknown` when `probe` never answers. `restarting` on `local` leaves `running`. In `hosts.test.ts`: a `POST /api/hosts/<node>/update` writes `running` and then the result. A 409 "another update runs" leaves the first entry unchanged. The audit log line is unchanged.
- [ ] **Step 2: Run** `bun test server/test/updatetracker.test.ts server/test/hosts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the tracker and the middleware. In `startHub`, load the record with `UpdateRecord.load({ stateDir: cfg.stateDir })`, call `await record.reconcileHub(VERSION)` before `Bun.serve`, and build the tracker with `probe` that calls the registry client for the node.
- [ ] **Step 4: Run** both files and the whole server suite `bun test server`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): record the result of each update`.

### Task 8: Record and event stream routes

**Files:**
- Modify: `server/src/app.ts` (two routes), `server/src/serve.ts` (idle timeout)
- Test: `server/test/app.test.ts`, `server/test/serve.test.ts`

**Interfaces:**
- Consumes: `UpdateRecord.list`, `UpdateRecord.onChange` (Task 5).
- Produces:
  - `GET /api/updates` returns `UpdateEntry[]`.
  - `GET /api/events` is an SSE stream (`streamSSE` from `hono/streaming`). The first message is `event: snapshot` with the entry list as JSON. Each change sends `event: update` with the entry. A comment line `: keepalive` goes out every 15 seconds. When the client closes, the listener is removed.
  - In `serve.ts`, `withLongUpdates` calls `server.timeout(req, 0)` for `GET` on `/api/events` (and `/cli/api/events` is not needed). Add a path constant like `UPDATE_PATH_RE`.
  - `Deps` gains `updates?: UpdateRecord`. Without it both routes answer 501.

- [ ] **Step 1: Write the failing tests.** `GET /api/updates` returns the list. `GET /api/events` first yields a `snapshot` message with the list, then an `update` message after `record.set(...)`. After the response is cancelled, `record.set` calls no listener (check the listener count through a spy). Both routes answer 401 without a session, like the other `/api` routes. In `serve.test.ts`: `withLongUpdates` calls `server.timeout(req, 0)` for `GET /api/events` and not for `GET /api/hosts`.
- [ ] **Step 2: Run** `bun test server/test/app.test.ts server/test/serve.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the routes in `createApp` in the authenticated `api` router, and the timeout case in `serve.ts`.
- [ ] **Step 4: Run** the two files. Expected: PASS. Then start the hub from source with `bun run dev` in a scratch config and run `curl -N http://localhost:<port>/api/events` with a valid session if one is available. If it is not, state in the commit message that the stream was checked only by the tests.
- [ ] **Step 5: Commit** `feat(server): stream update events to the web UI`.

### Task 9: Web client, queries and the event hook

**Files:**
- Modify: `web/package.json` (add `@tanstack/svelte-query`), `web/src/main.ts`
- Modify: `web/src/lib/api.ts`
- Create: `web/src/lib/queries.ts`, `web/src/lib/events.ts`
- Test: `web/src/lib/queries.test.ts`, `web/src/lib/events.test.ts`, `web/src/lib/api.test.ts`

**Interfaces:**
- Produces in `api.ts`: `HostInfo` gains `version?: string`, `clientVersion?: string`, `stale?: boolean`, `target?: string`. New types `UpdateEntry` (same fields as the server) and `Latest = { version: string; checkedAt: string }`. New calls: `getLatest(): Promise<Latest>`, `getUpdates(): Promise<UpdateEntry[]>`, `updateHost(host: string, release?: string): Promise<{ status: string; from: string; to?: string; error?: string }>` (a `POST` to `/api/hosts/<host>/update` with body `{ release }` only when given).
- Produces in `queries.ts`: `STALE_MS = 300_000`, `hostsQuery()`, `latestQuery()`, `updatesQuery()` returning TanStack options with `staleTime: STALE_MS`, `refetchOnWindowFocus: true` and the keys `["hosts"]`, `["latest"]`, `["updates"]`.
- Produces in `events.ts`: `connectEvents(o: { client: QueryClient; open?: (url: string) => EventSource }): () => void`. It opens `/api/events`. On a `snapshot` or `update` message it sets the `["updates"]` data from the message and invalidates `["hosts"]`. On an `error` with `readyState === 2` (closed, for example after a 401) it does not reconnect and waits for the next window focus event, then opens again once. The returned function closes the stream and removes the focus listener.

- [ ] **Step 1: Write the failing tests** with a fake `EventSource`. `events.test.ts`: a `snapshot` message fills `["updates"]` and invalidates `["hosts"]`. An `update` message replaces one entry. A closed stream is not reopened until a `focus` event, and then it opens once. The stop function closes the stream. `api.test.ts`: `updateHost("n1")` sends no body fields, `updateHost("n1", "0.8.3")` sends `{ release: "0.8.3" }` and nothing else. `queries.test.ts`: each query has `staleTime` of 300 000 and `refetchOnWindowFocus` true.
- [ ] **Step 2: Run** `bun test web/src`. Expected: FAIL.
- [ ] **Step 3: Install** with `bun add --cwd web @tanstack/svelte-query`. Implement the three files. In `main.ts`, wrap the app in `QueryClientProvider` (create one `QueryClient`).
- [ ] **Step 4: Run** `bun test web/src` and `bun run --cwd web check`. Expected: PASS. If the dependency does not build with Vite and Bun, stop and report the reason, as the spec allows.
- [ ] **Step 5: Commit** `feat(web): add TanStack Query for versions and update events`.

### Task 10: Banner, hub line and node list in the UI

**Files:**
- Create: `web/src/lib/updatebanner.ts`, `web/src/lib/UpdateBanner.svelte`, `web/src/lib/HubVersionLine.svelte`
- Modify: `web/src/lib/HostPicker.svelte`, `web/src/App.svelte`
- Test: `web/src/lib/updatebanner.test.ts`

**Interfaces:**
- Consumes: `HostInfo`, `UpdateEntry`, `Latest` (Task 9).
- Produces in `updatebanner.ts`:
  - `type BannerItem = { kind: "hub-update"; target: string } | { kind: "node-update"; hosts: { id: string; name: string; target: string }[] } | { kind: "hub-local-build" } | { kind: "by-hand"; host: string; message: string } | { kind: "offline-after-hub-update"; hosts: string[] } | { kind: "failed"; host: string; error: string } | { kind: "latest-unknown" }`
  - `bannerModel(o: { hosts: HostInfo[]; updates: UpdateEntry[]; latestError: boolean; now: Date }): BannerItem[]`.
  - Rules: `hub-update` when `local` is stale with a `target`. `node-update` lists every stale `ok` node with a `target`, and only when the hub is not stale-with-update-running. `hub-local-build` when the hub version is unknown (`dev` or `+`). `by-hand` for a node whose last entry is `failed` with an error that contains "404" or "not found" (the old node case, message `run claude-rc node update on it once`), and for the hub when its last entry is `updated` and it is still stale. `offline-after-hub-update` when the hub entry is `updated` with `finishedAt` within 10 minutes of `now` and any node is `offline`. `failed` for the last entry of a host with status `failed` or `rolled back` and a reason. `latest-unknown` when `latestError`.
- The banner component shows the items with an Update button for `hub-update` (calls `updateHost("local")`), an Update all nodes button for `node-update` (calls `updateHost(id, target)` for each host in turn), a dismiss button, and the failure text. A dismissed banner comes back when the set of items changes. After each update call it invalidates `["hosts"]` and `["updates"]`.
- `HubVersionLine.svelte` shows the hub service and client versions, and the latest release when `local.stale`. It sits above the New button in `App.svelte`.
- `HostPicker.svelte` shows the two versions and a stale mark in each option label, and an Update button per stale node next to the select (a native select cannot hold a button).
- `App.svelte` replaces the 15 second `loadHosts` poll with `createQuery(hostsQuery())`, mounts `connectEvents` in `onMount`, and keeps the existing fallback to `local` when the selected host disappears.

- [ ] **Step 1: Write the failing tests** for `bannerModel`: stale hub gives `hub-update`. Stale node gives `node-update` with its target. Nothing stale gives `[]`. Unknown hub version gives `hub-local-build` and no `node-update`. A node `failed` with a 404 message gives `by-hand`. Hub `updated` 2 minutes ago and a node `offline` gives `offline-after-hub-update`, and 11 minutes ago gives nothing. A `failed` entry with an error gives `failed` with the reason. `latestError: true` gives `latest-unknown`. A host with unknown version never appears in `node-update`.
- [ ] **Step 2: Run** `bun test web/src/lib/updatebanner.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `updatebanner.ts` and the three components, and change `App.svelte` and `HostPicker.svelte`. Match the existing CSS variables (`--surface`, `--border`, `--accent`) and the 44 px touch target.
- [ ] **Step 4: Run** `bun test web/src`, `bun run --cwd web check` and `bun run --cwd web build`. Expected: PASS and a clean build.
- [ ] **Step 5: Run the app** with the `run` skill against a hub from source with one fake stale node, and check: the line above New, the banner, the drop-down labels, the two separate clicks, and the banner after a window focus. Say which of these you could not check.
- [ ] **Step 6: Commit** `feat(web): show stale versions and update from the UI`.

### Task 11: Documentation and full check

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document** in `README.md`: the banner and the two clicks, what "stale" means, the update record file, the `GET /api/latest`, `GET /api/updates` and `GET /api/events` routes, and the limits from the spec (a Windows node and a user-scope service cannot update from the UI, an old node needs `claude-rc node update` once, a hub release that changes the hub-to-node protocol needs a manual roll-out). Use the README's existing headings.
- [ ] **Step 2: Run** `bun test server web/src ./cli` and `bun run typecheck`. Expected: all PASS. Any failure that the memory note on sandbox-only failures lists is allowed if it also fails on `main`. Report it.
- [ ] **Step 3: Commit** `docs: describe the version check and update in the web UI`.

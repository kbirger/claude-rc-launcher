# Live session events

Date: 2026-11-19, revised 2026-11-20 (a stream for each view replaces topics). Status: implemented on branch feat/session-events, awaiting review.

## Intent

The Sessions view must show changes as they happen. It must also open fast, whatever the state of the nodes. Today each browser polls the hub every 15 seconds. The hub calls every node on each poll. A node that is down or hung holds the whole list for its time limit. A session that starts, ends or turns busy shows up only at the next poll.

The change moves the work onto the event streams that already exist. If the list changes, a node sends its session list to the hub over its stream. The hub keeps the latest list of each node in memory. The hub sends changes to each open Sessions page over a sessions stream of its own. The page then shows the stored lists at once and updates without polling.

The code that finds changes on a node must be easy to swap. A timer scan is the first way. A file watcher can come later. Everything that sends the changes onward must not know how they were found.

The app is a prerelease. Hub and nodes update together, so this design keeps no support for older nodes or older hubs.

## Goals

- The Sessions view shows stored data at once, with no call to a node while the user waits.
- A node that is down, restarting or hung never delays the rest of the list.
- A change on a node (a session starts, ends, turns busy or idle, or is renamed) reaches an open page within a few seconds.
- A node works hard only while a visible browser shows sessions. With none, nodes scan rarely.
- A browser tab that is hidden holds no connection and sends no requests.
- The way a node finds changes is one replaceable part, with one small contract and shared tests.

## Non-goals

- No file watcher in this project. The project builds the seam and one poller. A watcher is a later, separate piece.
- No changes (deltas) in the first version. An event holds the whole list of the node. A later step can add deltas on the hub only (see "Later: deltas on the hub").
- No other live lists (instances, touched files, changed files). Each one can get its own stream later, with the same pattern. None is built.
- The detail routes of one session (touched files, changed files, folder, preview) under `/instances/:id/sessions` keep their per-request endpoints.
- No support for a node or a hub of an older version.

## Anti-goals

- A node must never push to the hub on its own connection. The hub opens every connection (decided 2026-11-10). The node only writes events on the stream that the hub opened.
- Nothing in the code that sends events can depend on how the change was found, by a poller or by a watcher.
- The web app must not use `experimental_streamedQuery`. It is a bad fit here (see "Approaches considered").

## Constraints

These facts come from the code as of 2026-11-20.

- The node stream is `GET /api/events` on a node (`createNodeApp` in `server/src/app.ts`). It first sends a `snapshot` event (`{ version, update }`) and the kept `log` lines. It then sends each bus event as `event: <type>`, with the rest of the object as data. A node accepts 8 open connections (`MAX_EVENT_CONNECTIONS`).
- The hub watcher (`createNodeWatchers` in `server/src/nodewatcher.ts`) keeps one stream open to each node of the registry. It reads `snapshot`, `log` and `step` and ignores other event names. It reconnects with a growing wait, and it publishes presence with the statuses `online`, `offline`, `restarting` and `error`. It does not watch the hub's own node (`local`).
- Presence is not a module. `hubmain.ts` builds `{ list, onChange }` from the watcher. `list()` has no entry for `local`.
- The hub stream to browsers is `hubEvents` in `server/src/app.ts`, mounted at `/api/events` and `/cli/api/events`. It subscribes to its sources first, then sends `snapshot`, then `update`, `log` and `presence` events. It has no stream id.
- The browser client is `connectEvents` in `web/src/lib/realtime/events.ts`, started once in `Shell.svelte`. It writes events into the query cache with `setQueryData`. After a reconnect it invalidates the keys that it owns. It does not handle `visibilitychange`.
- The node event bus is `NodeEvents` in `server/src/updateevents.ts`. Its event union has `step` and `log`. It has `emit`, `subscribe`, `snapshotUpdate` and `lines`.
- `SessionIndex` (`server/src/sessionindex.ts`) scans all instances with single flight and a `dirty` rerun. It has its own passive and active timer, driven by the time of the last `get()`. `get()` reads the live-session files again on each call. Two places build an index: `createNodeApp` for a node, and `createApp` for the hub's own node. Neither exposes it.
- The only `invalidate()` call is middleware on `/instances/*` that fires after each successful request that is not a GET.
- `readLive` (`server/src/livesessions.ts`) reads only `<home>/.claude/sessions/*.json` and some `/proc` entries. It reads no transcripts, so it is cheap.
- Hub roles come from the `RULES` table in `server/src/roles.ts`. The match is exact for each path pattern. A route with no row needs `admin`, and a test fails for a route with no row. `/events` and `/sessions` are `read` routes.
- Node routes have no role rule and no CSRF rule. For each request that is not a GET, they require `content-type: application/json`.
- The hub is behind Traefik, which serves HTTP/2 to browsers (measured 2026-11-20 with `curl --http2`). The router uses no `compress` or `buffering` middleware. Each `EventSource` is therefore one more stream on one connection, and the browser limit of six connections for each origin does not apply.
- A node with no `claudeHome` answers 501 from `get()`. `scanOnce` does not look for this and returns an empty list.

## Approaches considered

For how browsers get data, the choices were:

1. One request for each node from the browser, merged in the page. It fixes the wait for the slowest node, but it still polls and it cannot push.
2. A new stream for each view. The page owns the connection, so a closed page closes the stream, and the close is the unsubscribe. It needs no stream id, no topic map on the hub, and no subscribe calls. Over HTTP/1.1 each stream holds one of the six connections for each origin. Over HTTP/2 a stream costs almost nothing. The hub is served over HTTP/2, so this is chosen.
3. The stream that already exists, with topics. The browser subscribes to a topic with a `PUT` and unsubscribes with a `DELETE`. It adds no connection. It needs a stream id, a topic map on the hub, two new routes, and retry logic in the client. A failed `DELETE` leaves events flowing to a page that is gone, and it keeps the nodes in fast mode. The first draft chose this. The second draft replaced it after the measurement of HTTP/2.
4. The same stream, with the topics in its address. It needs no hub state. But each change of page closes the shared stream and opens a new one, with a full snapshot of all its events. It was not chosen.

For how a node finds changes, the choices were:

1. A source that produces the new state. A poller fits this. A watcher does not fit. It knows only that a path changed, so it must scan and compare by itself. Every source then repeats the compare and the event code.
2. A source that produces only triggers ("something changed here, read it again"), and one shared part that reads, compares and emits. Both a poller and a watcher fit this. This is chosen.

For how the web app holds the list, the choices were:

1. `experimental_streamedQuery` of TanStack Query. The first draft chose it. It does not fit, for four reasons. A stream that never ends keeps the query in the `fetching` state, so `RefreshBar.svelte` shows its bar for as long as the page is open. `PullToRefresh.svelte` waits for `invalidateQueries`, which cancels the stream, starts a new one and waits for it forever, so the pull stays busy. A refetch in the default `reset` mode empties the list. At a remount within `staleTime`, TanStack Query starts no new fetch, so the page holds a stopped stream with old data.
2. A plain query plus a stream. The query reads `GET /api/sessions` from the hub store, which answers at once. The page holds the sessions stream for as long as it is mounted. The stream client writes each event into the cache with `setQueryData`, the same way that `connectEvents` handles `update` and `presence` today. A pull to refresh reads the store again, which is cheap. This is chosen.

## Design

### The pieces on a node

```
ChangeSource  --trigger-->  SessionIndex  --SessionsEvent-->  node bus  -->  node stream  -->  hub
(poll or watch)             (read + compare)                   (NodeEvents)
```

`ChangeSource` is the replaceable part. Its contract:

```ts
type Trigger = { scope: "all" } | { scope: "live" } | { scope: "instance"; id: string };
interface ChangeSource {
  start(onTrigger: (t: Trigger) => void): void;
  stop(): void;
  /** True while someone looks. A source can use it to change its rate. It can also ignore it. */
  setActive(active: boolean): void;
}
```

- `PollSource` is the first source. In passive mode it triggers `all` every 5 minutes. In active mode it triggers `live` every 3 seconds and `all` every 10 seconds. These are starting values, and they match the passive and active times of the index today.
- A trigger with scope `live` makes the index read only the live-session files and lay them over the stored rows, as `get()` does today. A trigger with scope `all` makes it scan all instances. A trigger with scope `instance` rescans one instance. `PollSource` never fires `instance`. The scope exists for a later watcher.
- A later `WatchSource` fires a trigger on each file change, with a debounce. It also keeps a slow `all` trigger as a safety net. The index does not change.
- The `/instances/*` middleware keeps its place in `app.ts`, but it calls a `trigger({ scope: "all" })` function instead of `invalidate()`. The index owns that function, so every source gets the same behavior. The single flight and the `dirty` rerun of `scan()` stay.
- One contract test suite runs against every source: it fires a trigger after a change, it stops after `stop()`, and it follows `setActive`. The tests inject a clock, as `sessionindex.test.ts` does.
- There is no configuration key for the source in this project. The code builds a `PollSource`. A key comes with the second source. The configuration parser rejects unknown tables, so the key needs parser work at that time.

`SessionIndex` keeps its scan and gains three jobs. It handles triggers, it compares the new list with the old one, and it emits. It does not know which source fired. Its own timer, `nextDelayMs`, `windowMs` and the `lastRequestAt` rule are removed, because the source and the heartbeat replace them. `get()` stays for the node route `GET /api/sessions`, but it no longer changes the scan rate.

If the list differs, the index emits one event on the bus:

```ts
type SessionsEvent = { type: "sessions"; scannedAt: string; available: boolean; sessions: SessionRow[] };
```

- The compare covers every field of `SessionRow`. These are `id`, `root`, `name`, `branch`, `startedAt`, `lastActiveAt`, `live`, `earlier`, and the `instance` fields. It ignores `scannedAt`.
- `lastActiveAt` comes from the modified time of the transcript, so a busy session changes it on each scan. If `lastActiveAt` moved by less than 30 seconds from the value in the last event, the compare does not count it. A busy session then gives an event only when another field changes, or about once in 30 seconds.
- The event always carries the newest `lastActiveAt` values. The threshold only decides whether to send. The list shows the time to the minute (`ago()` in `web/src/lib/shared/time.ts`), so the delay does not show on screen. The sort order of two busy sessions can be up to 30 seconds old.
- Events are combined: at most one event for each 500 ms.
- If the node has no `claudeHome`, the index does not scan. It emits one event with `available: false` and no rows. The hub then shows "no session files on this node", not an empty list.

`NodeEvents` gets the new event type and keeps the latest `SessionsEvent`, with a getter for it. The node stream adds a `sessions` field to its `snapshot` with that event, or `null` before the first scan. The existing route code then writes each later `sessions` event with no change.

### The heartbeat

The hub manages the heartbeat. Browsers send none. The hub counts the open sessions streams (see "The hub"). A tab holds that stream only while a Sessions page is mounted and the tab is visible (see "The web app"). A count above zero means that someone looks at sessions. A tab on the Nodes or Updates page holds only the shared stream, so it does not count.

- When the count goes from zero to one, the hub starts one beat loop and sends a first beat at once. When the count goes back to zero, the loop stops.
- The loop is one for the whole hub, whatever the number of tabs. Every 20 seconds it calls `POST /api/sessions/watch` on each node of the registry. The body is `{}`, so that the JSON content-type rule of the node passes. The call answers 204. The call goes through `HostClient.call`, which signs the hub proof. The node needs no role rule, because nodes enforce none.
- The hub does not call a node whose presence is not `online`. When the presence of a node turns `online`, the hub sends it a beat at once if the count is above zero.
- The hub's own node is not in the registry. The hub calls `setActive` on its own index directly.
- A node that gets a beat calls `setActive(true)` on its source and starts a timer of 60 seconds. If the timer ends without a new beat, the node calls `setActive(false)`. One missed beat does no harm.
- The first beat after a quiet time also makes the node fire `all` at once. The browser first gets the stored list from the hub, then the fresh list follows as an event.
- More than one hub can watch a node. One flag with a 60-second timer is enough, because any beat keeps the node active.

### The hub

- `SessionsStore` keeps the latest `SessionsEvent` of each host, and the time it arrived.
  - The watcher gets a new `onSessions(host, event)` option. It calls it for the `sessions` field of each `snapshot` and for each `sessions` event. Today the watcher ignores unknown event names, so this is a new branch.
  - `hubmain.ts` builds the hub's own index and passes it to both `createApp` and the store. Today `createApp` builds it inside. The store subscribes to that index for `local`.
  - When a host leaves the registry, the store drops its entry.
- The status of a host comes from the store and from presence together. The store is the one place that combines them:
  - presence not `online`: `offline` or `error`, as `allsessions.ts` maps it today, with no rows. A `restarting` node is `offline`. The store keeps the old list. When the node returns, the store uses it again.
  - online, with `available: false`: `unavailable`, with no rows.
  - online, with no list yet: `loading`.
  - online, with a list: `ok`, with the rows and `scannedAt`.
  - The hub's own node (`local`) has no presence. The store treats it as always online.
- `HostSessionsStatus.status` becomes `"ok" | "offline" | "error" | "unavailable" | "loading"`. `unsupported` is removed. No CLI command reads `/api/sessions`, so only the web changes.
- `GET /api/sessions` answers from the store. It calls no node, and it has no time limit. The shape stays `{ sessions, hosts }`. The CLI route `/cli/api/sessions` uses the same code.
- The sessions stream is `GET /api/sessions/events`. It needs a new `read` row in `RULES`, because the match is exact. `allSessionsApi` is also mounted under `/cli/api`, but no CLI command uses a stream of sessions. Mount the stream for browsers only, so that a CLI client never counts as a viewer.
  - The handler follows the order that `hubEvents` already uses. It first subscribes to the store, so that later changes go to the stream. It then writes one `snapshot` event with the full answer of the store. A change that arrives in between can come twice, and that is safe, because the client replaces the list of a host.
  - After the snapshot, the hub sends a `host` event for each change in the store. The event holds the host id and the new status and rows of that host. A presence change of a host also gives a `host` event. The client then reads host status from one source only.
  - The stream sends a keepalive comment every 15 seconds, as `hubEvents` does.
  - When the stream opens, the handler adds one to the viewer count. When the stream closes, it takes one away, in the same `close()` that unsubscribes from the store. No other state is kept for a stream.
  - The stream is a GET, so the CSRF rule does not apply.
- The beat loop runs while the count of open sessions streams is above zero.
- The hub sends the list of a host in full on each change. It is about 20 KB for 56 sessions.

### The web app

- A new client `connectSessions` in `web/src/lib/realtime/` owns the sessions stream. It opens `EventSource("/api/sessions/events")`. It writes the `snapshot` into the `["all-sessions"]` query with `setQueryData`. A `host` event replaces the rows and the status of one host and keeps the others.
- `connectSessions` is counted. The first caller opens the stream, and the last release closes it. The global list, the one-instance list and `SessionView.svelte` can then each call it, and the tab still holds one sessions stream.
- The reconnect waits and the hidden-tab rule are one small helper, shared by `connectEvents` and `connectSessions`. Neither client copies the other.
- A reconnect needs no extra work, because each new stream starts with a full snapshot.
- The sessions query stays a plain query. Its `queryFn` is `listAllSessions`, which now answers from the hub store. Its `refetchInterval` is removed. A pull to refresh reads the store again, which is cheap and calls no node. A refocus does not, because the stream, or its snapshot after a hidden tab, keeps the data.
- When a Sessions page mounts, it calls `connectSessions`. When it unmounts, it calls the release function. The shared stream stays open for the other events.
- The page of one instance and `SessionView.svelte` read the `["all-sessions"]` query and filter it by host and instance. Today both use `sessionsQuery(host, instance)`, which is removed. The notices for one instance come from the status of its host, the same as on the global page.
- `SessionsLink.svelte` no longer probes each instance. `HostInfo` gets a field `sessions: boolean`, which the hub fills from the store (`false` for `unavailable`). The link reads it from the hosts list, which presence already keeps fresh. The Instances view therefore opens no sessions stream and does not start the beat loop.
- The notice texts change: `unavailable` gives "no session files on this node", `loading` gives "loading", and "update this node" is removed.
- A tab that is not visible drops both streams. The shared helper listens to `visibilitychange`. After 30 seconds in the hidden state, it closes the stream and stops its retries. The callers stay counted. When the tab is visible again, the helper opens each stream that still has callers. The grace time stops a quick switch between tabs from closing and opening the streams each time. The design uses the visibility of the tab, not the focus of the window: a window that is visible next to another one keeps its streams.
- The reconnect that follows a visible state invalidates the keys that `connectEvents` owns, as it does today. The sessions query gets its new data from the snapshot of its own stream.
- The list needs no other change: sort, filter and notices stay as they are.

### Tests and docs

- Node tests: the index compares and emits. A rename, a new session, and a session that turns busy each give an event. No change gives no event. `scannedAt` alone gives no event. A `lastActiveAt` move under 30 seconds gives no event, and a move of 30 seconds gives one. Events are combined. A node with no `claudeHome` emits `available: false`. The `/instances/*` middleware fires an `all` trigger. `PollSource` follows `setActive`, with an injected clock. The shared source contract suite runs on it. The node stream has `sessions` in its snapshot and writes `sessions` events. The heartbeat route answers 204 and drops to passive after 60 seconds with no beat.
- Hub tests: the sessions stream. It sends the stored lists as a snapshot, then a `host` event for a later change and for a presence change. A closed stream unsubscribes from the store. The new `RULES` row exists. The beat loop starts at the first open sessions stream and runs once for several streams. After the last one closes, the loop stops. The shared stream does not start it. A node whose presence turns `online` gets a beat at once. A node that is not online gets none. The local index gets `setActive` with no network call. The watcher feeds the store from the snapshot and from events. `GET /api/sessions` answers without calling a node. A node can go offline and return with its old list.
- Web tests: `connectSessions` opens one stream for two callers and closes it at the last release. The snapshot fills the cache. A `host` event replaces one host and keeps the others. A reconnect replaces the data with the new snapshot. The shared helper closes a stream after 30 hidden seconds. It opens the stream again at the next visible state. A short hide does not close it. `connectEvents` keeps its behavior with the helper. The Sessions page opens the stream at mount and releases it at unmount. The one-instance page and `SessionView` filter the cache. `SessionsLink` reads `HostInfo.sessions`. The refresh bar does not stay on while the page is open. The tests use the `FakeES` pattern of `events.test.ts`.
- Update `docs/session-files.md`, `docs/api.md`, `docs/web-ui.md` and `docs/multi-host.md`.

## Later: deltas on the hub

This section is not part of this project. It records the shape that was chosen, so that a later project does not start again.

- Only the hub computes deltas. Nodes keep sending full lists to the hub. The LAN carries them cheaply, and the node contract and `ChangeSource` do not change.
- The hub diffs each incoming list against the stored list of that host. It sends browsers an upsert of the changed rows (keyed by instance and session id) and a list of removed ids. A usual change is one row of about 350 bytes, not the full list.
- Each event of a host carries a revision number that goes up by one. If the client sees a skipped number, it reads `GET /api/sessions` again. Events cannot be lost on one SSE stream, and each reconnect starts with a snapshot. The number therefore only catches code bugs, and it makes them visible in tests.
- There is no periodic full sync. On this transport it would only hide a bug.
- Measure the traffic to a phone first. Build this only for a measured need.

## Left to the builder

- The exact intervals, the 30-second grace time and the 500 ms combine time. The build keeps the starting values. Change them only after a measurement on the real hub shows a need.
- How the node stream sends a very large list. The build sends the full list and adds no deltas. The size is measured below.
  - The measurement is synthetic. No node with real session data was started. A script built 56 sessions in 8 instances with realistic fields. The real `SessionIndex` listed them, and a local HTTP server sent the body of the node route `GET /api/sessions`. The size was counted with `curl -s ... | wc -c`.
  - 56 sessions: 17 853 bytes (about 18 KB). This matches the earlier figure of about 20 KB.
  - 500 sessions: 158 323 bytes (about 158 KB), or about 317 bytes for each session.
  - A busy session sends the full list of its node about every 30 seconds. At 500 sessions this is about 158 KB for each event. Measure on the real hub before you add deltas.
- Whether the node route `GET /api/sessions` stays. Nothing in the hub or the web uses it after this change. It can stay for debugging with `curl`.

## Risks

- A node scans at the active rate for 60 seconds after the last beat. With many instances this costs more than today. If nobody looks, the hub sends no beat, so the cost stays bounded.
- The viewer count depends on the hub seeing each close. A stream that ends without a clean close still fires `onAbort`, and the hub runs `close()` there, as `hubEvents` does today. A count that drifts up keeps the nodes in fast mode, so a test covers it.
- A tab on a Sessions page holds two streams. Over HTTP/2 this costs almost nothing. If the hub is ever served over HTTP/1.1, each such tab uses two of the six connections for each origin.
- A hidden tab keeps nodes in the fast mode for at most 30 seconds plus the 60-second window.
- A full list for each change can be large. With the 30-second threshold, one busy session sends the whole list of its node about every 30 seconds. Measure the traffic to a phone before adding deltas.
- The hub keeps a copy of node state. After a hub restart the store is empty until each node sends its snapshot. The watcher connects at boot, so this takes about a second. Until then `GET /api/sessions` shows that node as `loading`.
- Live status is fresh only to the `live` trigger, at most 3 seconds old while someone looks. Today `get()` reads it on each request.

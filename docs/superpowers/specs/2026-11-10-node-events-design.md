# Node events: design

## Why

The hub learns nothing from a node. It asks. When a node starts, stops or restarts, the status changes only after a page refreshes the host list. During an update, the page shows `running` and then a final result. Nothing shows in between.

On KIRSTATION4 (2026-11-10), a slow Windows restart looked like a hang. The user saw no difference between the two.

Goals:

1. Within seconds, the hub knows that a node came online or went offline.
2. Every open browser tab shows the step that an update is in. The steps are downloading, verifying, installing and restarting. Today the tab shows only `running`.
3. A tab that did not start the update sees all of it. This already holds for the final result, because the update record lives on the hub. It must also hold for the new events.

Non-goals:

- Notifications for a user who has no page open (browser push, ntfy, email). This is a separate feature that builds on this one.
- A node that pushes to the hub, a message broker (MQTT) and WebSocket. The user decided on 2026-11-10 that the hub can reach every node. So the hub keeps its direction and opens the connection.
- Commands over the stream. The stream carries events from the node to the hub only.
- Events for Claude sessions (instances). A later version of the stream can carry them.
- A new way to build the host list. `GET /api/hosts` keeps asking each node. This is the call of the author of this document, because that path is proven and the stream only adds to it.
- HTTP/2. The hub and the nodes keep speaking HTTP/1.1.

Anti-goal: a stream that makes a node look worse than it is. When a stream drops, a reachable node must not stay `offline` longer than one failed probe makes it.

## Current state

- The hub calls nodes through `HostClient.call` (`server/src/hostclient.ts`). It uses pinned TLS (`host.ca`) and a `Hub-Proof` token (or a bearer secret) that is signed for each exact request. The body size is capped, and each call has a timeout.
- A node serves `createNodeApp` (`server/src/app.ts`). It has `/healthz` and `/api/*` behind `auth`. It has no event route.
- After a node answers `restarting`, the update tracker (`server/src/updatetracker.ts`) polls `GET /api/node` every 2 seconds, for up to 90 seconds. Then it writes `updated`, `rolled back` or `unknown` into the update record.
- The update record (`server/src/updaterecord.ts`) holds one entry per host in `<stateDir>/updates.json`. Its `onChange` listeners feed the browser stream `GET /api/events` on the hub (`server/src/app.ts`). That stream sends a `snapshot` event, then one `update` event per change, and a keepalive comment every 15 seconds.
- The web page keeps that stream open (`web/src/lib/events.ts`). It writes the data into the `["updates"]` query.
- The updaters are `server/src/serviceupdate.ts` (Linux) and `server/src/win/update.ts` (Windows). Neither reports progress.
- Hosts change at run time. `HostRegistry` (`server/src/hostregistry.ts`) holds the static hosts from `config.toml` and the managed hosts that the CLI adds and removes.
- `server/src/serve.ts` already gives the path `/api/events` an unlimited idle timeout. The node server uses the same function, so the node needs no change there.

## The design

### 1. The node: `GET /api/events`

The route uses the same `auth` middleware as the other `/api/*` routes of the node. The response is server-sent events (SSE). The response headers match the hub route after commit `fcc7a03`: no `Transfer-Encoding` header and no `Connection` header.

The route sends these events:

- `snapshot` is the first event on every connection. Its data is `{ "version": "<node version>", "update": null | { "step": "<step>", "to"?: "<version>", "startedAt": "<iso>" } }`. When an update runs on the node, the field `update` is set.
- `step` is sent once for each change of step. Its data is `{ "step": "<step>", "to"?: "<version>", "client"?: "<path>", "detail"?: "<short text>" }`.
- A comment line, `: keepalive`, is sent every 15 seconds.

The steps, in order, have these exact names: `downloading`, `verifying`, `installing-client`, `installing` and `restarting`. The step `installing-client` repeats once for each client copy, with `client` set. A failed update ends with the step `failed`, with `detail` set to the error text. An update that finds nothing to do ends with the step `up-to-date`. The node sends `restarting` before it exits. When the node exits, the connection ends.

The updaters report each step through one optional callback, `onStep(step)`. `serviceupdate.ts`, `win/update.ts` and `createNodeApp` share a small in-process object on the node, `NodeEvents`, with `emit(e)`, `subscribe(fn)` and `current()`. The node keeps the current step. A connection that opens in the middle of an update gets that step in its snapshot.

Limits (the author's call): a node accepts at most 8 open event connections. The ninth gets `429`. A node that runs no update sends only keepalives.

### 2. The hub client: `HostClient.stream`

`HostClient` gets a new method, `stream`, next to `call`. It opens `GET <path>` with the same pinned TLS and the same `Authorization` header. It has no body timeout. It returns an async iterable of parsed SSE events and a way to abort.

`stream` uses the same failure classes as `call`: `unreachable`, `timeout`, `certificate mismatch`, `rejected our credentials` and `bad response`. A `404` from the node is its own result, `unsupported`. With it, the watcher can tell an old node.

The `Hub-Proof` covers one request. The hub does not sign a long stream again. When the request arrives, the node makes sure that the signature is valid. It does this once.

### 3. The hub: `NodeWatcher`

The hub runs one watcher for each host in the registry. Each watcher keeps one stream open to its host.

- When the hub starts, a watcher starts for every host. When the CLI adds a host, a watcher starts for it. When a host is removed, its watcher stops and drops its state.
- When the stream connects, the node is `online`. The version comes from the snapshot. The watcher publishes a presence event.
- When the stream ends or fails, the watcher maps the failure class to a presence status, with the same split as the host list in `hosts.ts`. The classes `unreachable` and `timeout`, and a stream that ends, give `offline`. The classes `rejected our credentials`, `certificate mismatch` and `bad response` give `error`. The reason is the failure class.
- If the last step that the watcher saw was `restarting`, a drop gives `restarting` instead of `offline`. After 90 seconds (the window of the update tracker) without a new connection, the status becomes `offline`. It also becomes `offline` at once when the update entry of the host settles as `unknown` or `rolled back`. This rule holds for every `restarting` step, including one from an update that the hub did not start. This is the author's call.
- After a drop, the watcher reconnects after 1, 2, 5, 10 and 30 seconds, and then every 30 seconds. Each wait gets up to 20 percent random jitter. This keeps many nodes that return together from connecting in the same moment. A successful connection resets the wait.
- When a stream sends nothing for 45 seconds (three keepalives), the watcher aborts it and treats it as dropped. A half-open TCP connection does not close by itself.
- When a node answers `unsupported`, the node is an old node. The watcher records `streams: false` for the host and publishes no presence events for it. It tries again every 10 minutes. This is the normal state of a fleet in which the hub was updated before its nodes. The watcher must not log an error each time.
- The watcher writes each `step` event into the update record entry of the host (see section 4). It does this only while the entry is `running`. When no entry runs, it ignores the step. In that case, something other than the hub started the update, for example a CLI on the node itself.

The hub's own instance, `local`, has no watcher. Its update is settled as it is today.

### 4. The record and the browser stream

`UpdateEntry` gets two optional fields. The field `step` holds the bare step name from the node. The field `stepDetail` holds the `client` path or the `detail` text of that step, cut to 200 characters. The page builds the text it shows from the two fields. The record keeps both fields only while `status` is `running`. When the status becomes final, the hub removes them. This is the author's call.

`UpdateRecord.set` already sends each change to every listener. So the existing `update` event on the hub's `GET /api/events` carries `step` to every tab. The stream code does not change.

Presence is new. It is not saved to disk. After a hub restart, the hub rebuilds it from the streams. The hub's `GET /api/events` gets two new events:

- `presence-snapshot` follows the `snapshot` event. Its data is a list of `{ host, status: "online" | "offline" | "restarting" | "error", version?, reason?, at }`, where `at` is an ISO time.
- `presence` is sent once for each change. Its data has the same fields as one list item above.

The data of `snapshot` keeps its present shape, the list of update entries. So an old page keeps working during an upgrade. This is the author's call.

### 5. The page

- `connectEvents` (`web/src/lib/events.ts`) handles `presence-snapshot` and `presence`. It patches `status` and `version` of the matching host in the `["hosts"]` query data. It does not refetch the list. When `version` changes, it also invalidates `["hosts"]`, because the staleness flags depend on the version.
- The host list gets one new status value, `restarting`. The order of authority is simple: the last event wins, and a fresh host list replaces every status. A presence event that arrives after a list fetch changes the status again. This is the author's call.
- Today every `update` event invalidates `["hosts"]`. After this change, an `update` event invalidates it only when the `status` of the entry changed, or when the entry is new. An event that changes only `step` or `stepDetail` does not refetch the list. A test covers this.
- While an entry is `running`, the update banner and the host row show the text built from `step` and `stepDetail` next to the existing text, for example "updating: installing". If `step` is missing (an old node or an old hub), the page works as it does today. The page styles `failed` apart from the other steps.
- A host with the presence status `restarting` shows "restarting". It does not show "offline".

### 6. The update tracker

The tracker keeps its polling as the fallback. This is the author's call. It gets one addition. When a presence event for a host in the `running` state reports `online` with the target version, the tracker writes `updated` at once. It does not wait for the next poll. The poll still settles every other result (`rolled back` and `unknown`).

When the tracker writes any final status for a host, it also calls `retryNow(host)` on the watcher of that host. A watcher that waits to retry an old node then connects at once. So a node that the hub just updated to a version with the stream gets presence and steps at once, and does not wait up to 10 minutes. This is the author's call.

## What the builder decides

- The names of files and classes, except the names given here.
- How the SSE parser in `HostClient.stream` is written, and whether a test helper shares it.
- How `NodeEvents` reaches the updaters. The callback must be optional, and the existing tests must pass without it.
- The exact short text of the `step` field on the page.

## Constraints

- The Windows node (a WinSW service built with `bun build --compile`) and the Linux node run the same code for the event route and the watcher. The Windows updater in `server/src/win/update.ts` emits the steps for its own path: `installing-client` for each client, then `installing`.
- Files with CRLF line endings keep them, for example `server/src/index.win.ts`.
- Tests run with `bun test server web/src ./cli`. `bun run typecheck` and `bun run --cwd web check` pass.
- The Windows CI job (`.github/workflows/ci.yml`) lists its test files by name. Add each new Windows-relevant test file to that list.
- No new dependency.

## Tests the builder must add

- Node route: authentication is required (401). A snapshot comes first. A `step` arrives for each step of a fake update. A keepalive arrives on the interval. The ninth connection gets 429. The response has no `Transfer-Encoding` header and no `Connection` header. A connection that opens in the middle of an update gets the current step in its snapshot.
- `HostClient.stream`: events are parsed across chunk boundaries. A pinned certificate mismatch is `certificate mismatch`. A `404` is `unsupported`. Abort ends the iteration.
- `NodeWatcher`: the node is online on connect and offline on drop. The node is `restarting` after a `restarting` step. The backoff sequence and the jitter bounds are right (use a fake clock). A silent stream is dropped after 45 seconds. An `unsupported` node is retried only every 10 minutes and logs once. A host that is added or removed at run time gets or loses its watcher. A `step` event reaches the update record only while the entry is `running`.
- Record and stream: `step` reaches the subscribers of `GET /api/events`, and two connected subscribers both get it. `presence-snapshot` follows `snapshot`. The data of `snapshot` is unchanged.
- Page: presence events patch the cached host list without a refetch. A change of version refetches. The `step` text shows while an entry is `running`, and only then.
- Tracker: an `online` presence event with the target version writes `updated`. Without the event, the poll still does.
- End to end (in the style of the existing e2e tests): a hub and a fake node, an update with steps, and a node restart. Two subscribers both see the steps and the presence changes.

## Open points

No open point blocks the plan. The author made two choices without the user. The user can change them:

- The host list keeps probing every node. Presence only adds to it.
- The hub retries an old node every 10 minutes, and sooner after an update of that node. A node accepts at most 8 connections.
- The rules for `restarting`, the status order of authority and the shape of `step` and `stepDetail` are in sections 3, 4 and 5. The builder check raised them, and the author settled them.

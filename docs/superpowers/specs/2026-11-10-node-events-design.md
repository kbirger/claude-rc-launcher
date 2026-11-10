# Node events: design

## Why

The hub learns nothing from a node. It asks. When a node starts, stops or restarts, the status changes only after a page refreshes the host list. During an update, the page shows `running` and then a final result. Nothing shows in between.

On KIRSTATION4 (2026-11-10), a slow Windows restart looked like a hang. The user saw no difference between the two.

Goals:

1. Within seconds, the hub knows that a node came online or went offline.
2. Every open browser tab shows the step that an update is in. The steps are downloading, verifying, installing and restarting. Today the tab shows only `running`.
3. Every update shows its output lines as they happen, for each node. The user sees them in the web page and in `claude-rc update --all-nodes`. Each line is a message that the updater itself produces, for example "downloaded 41 MB" or "the new binary answered 0.9.2".
4. A tab that did not start the update sees all of it. This already holds for the final result, because the update record lives on the hub. It must also hold for the new events and the output lines.

Non-goals:

- Notifications for a user who has no page open (browser push, ntfy, email). This is a separate feature that builds on this one.
- A node that pushes to the hub, a message broker (MQTT) and WebSocket. The user decided on 2026-11-10 that the hub can reach every node. So the hub keeps its direction and opens the connection.
- Output of `claude-rc node update`, which runs on the node machine and does not go through the service. Only the updater inside the service writes lines.
- Commands over the stream. The stream carries events from the node to the hub only.
- Events for Claude sessions (instances). A later version of the stream can carry them.
- A new way to build the host list. `GET /api/hosts` keeps asking each node. This is the call of the author of this document, because that path is proven and the stream only adds to it.
- HTTP/2. The hub and the nodes keep speaking HTTP/1.1.
- Compatibility between versions. The user decided on 2026-11-10 that it is not needed. The hub, the nodes and the pages ship and update together. The rest of this document does not handle an old node, an old hub or an old page.

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
- `log` is sent once for each output line of the updater. Its data is `{ "line": "<text>", "at": "<iso>" }`.
- A comment line, `: keepalive`, is sent every 15 seconds.

The steps, in order, have these exact names: `downloading`, `verifying`, `installing-client`, `installing` and `restarting`. The step `installing-client` repeats once for each client copy, with `client` set. A failed update ends with the step `failed`, with `detail` set to the error text. An update that finds nothing to do ends with the step `up-to-date`. The node sends `restarting` before it exits. When the node exits, the connection ends.

The updaters write one line for each action they take, and one line for each step change. Examples: `downloading claude-rc-launcher-win-x64.exe`, `sha256 matches SHA256SUMS`, `new binary answers 0.9.2`, `renamed the old binary to claude-rc-launcher.exe.prev`, `restarting in 2 seconds`. A failed action writes a line with the error text. The updaters report each step and each line through two optional callbacks, `onStep(step)` and `onLog(line)`. `serviceupdate.ts`, `win/update.ts` and `createNodeApp` share a small in-process object on the node, `NodeEvents`, with `emit(e)`, `subscribe(fn)` and `current()`. The node keeps the current step and the last 200 lines of the current or last update in memory. It does not save them to disk. A connection that opens in the middle of an update gets that step in its snapshot, and then gets the kept lines as `log` events.

Limits (the author's call): a node accepts at most 8 open event connections. The ninth gets `429`. A node that runs no update sends only keepalives.

### 2. The hub client: `HostClient.stream`

`HostClient` gets a new method, `stream`, next to `call`. It opens `GET <path>` with the same pinned TLS and the same `Authorization` header. It has no body timeout. It returns an async iterable of parsed SSE events and a way to abort.

`stream` uses the same failure classes as `call`: `unreachable`, `timeout`, `certificate mismatch`, `rejected our credentials` and `bad response`. A `404` from the node is a `bad response`.

The `Hub-Proof` covers one request. The hub does not sign a long stream again. When the request arrives, the node makes sure that the signature is valid. It does this once.

### 3. The hub: `NodeWatcher`

The hub runs one watcher for each host in the registry. Each watcher keeps one stream open to its host.

- When the hub starts, a watcher starts for every host. When the CLI adds a host, a watcher starts for it. When a host is removed, its watcher stops and drops its state.
- When the stream connects, the node is `online`. The version comes from the snapshot. The watcher publishes a presence event.
- When the stream ends or fails, the watcher maps the failure class to a presence status, with the same split as the host list in `hosts.ts`. The classes `unreachable` and `timeout`, and a stream that ends, give `offline`. The classes `rejected our credentials`, `certificate mismatch` and `bad response` give `error`. The reason is the failure class.
- If the last step that the watcher saw was `restarting`, a drop gives `restarting` instead of `offline`. After 90 seconds (the window of the update tracker) without a new connection, the status becomes `offline`. It also becomes `offline` at once when the update entry of the host settles as `unknown` or `rolled back`. This rule holds for every `restarting` step, including one from an update that the hub did not start. This is the author's call.
- After a drop, the watcher reconnects after 1, 2, 5, 10 and 30 seconds, and then every 30 seconds. Each wait gets up to 20 percent random jitter. This keeps many nodes that return together from connecting in the same moment. A successful connection resets the wait.
- When a stream sends nothing for 45 seconds (three keepalives), the watcher aborts it and treats it as dropped. A half-open TCP connection does not close by itself.
- The watcher puts each `log` event into a hub-side buffer, `UpdateLog`. The buffer keeps the last 200 lines for each host, in memory. A new update of a host clears the lines of that host first. The hub's own update, `local`, writes its lines into the same buffer from its in-process updater.
- The watcher writes each `step` event into the update record entry of the host (see section 4). It does this only while the entry is `running`. When no entry runs, it ignores the step. In that case, something other than the hub started the update, for example a CLI on the node itself.

The hub's own instance, `local`, has no watcher. Its update is settled as it is today.

### 4. The record and the browser stream

`UpdateEntry` gets two optional fields. The field `step` holds the bare step name from the node. The field `stepDetail` holds the `client` path or the `detail` text of that step, cut to 200 characters. The page builds the text it shows from the two fields. The record keeps both fields only while `status` is `running`. When the status becomes final, the hub removes them. This is the author's call.

`UpdateRecord.set` already sends each change to every listener. So the existing `update` event on the hub's `GET /api/events` carries `step` to every tab. The stream code does not change.

Presence is new. It is not saved to disk. After a hub restart, the hub rebuilds it from the streams. The hub's `GET /api/events` changes as follows:

- The data of `snapshot` changes shape. It becomes `{ "updates": [<update entries>], "logs": { "<host>": [{ line, at }] }, "presence": [{ host, status: "online" | "offline" | "restarting" | "error", version?, reason?, at }] }`, where `at` is an ISO time. The page and its tests change with it.
- `log` is sent once for each output line. Its data is `{ host, line, at }`.
- `presence` is sent once for each change. Its data has the same fields as one item of the `presence` list above.

### 5. The page

- `connectEvents` (`web/src/lib/events.ts`) reads `updates` and `presence` from the `snapshot`, and it handles `presence`. It patches `status` and `version` of the matching host in the `["hosts"]` query data. It does not refetch the list. When `version` changes, it also invalidates `["hosts"]`, because the staleness flags depend on the version.
- The host list gets one new status value, `restarting`. The order of authority is simple: the last event wins, and a fresh host list replaces every status. A presence event that arrives after a list fetch changes the status again. This is the author's call.
- Today every `update` event invalidates `["hosts"]`. After this change, an `update` event invalidates it only when the `status` of the entry changed, or when the entry is new. An event that changes only `step` or `stepDetail` does not refetch the list. A test covers this.
- While an entry is `running`, the update banner and the host row show the text built from `step` and `stepDetail` next to the existing text, for example "updating: installing". The page styles `failed` apart from the other steps.
- A host with the presence status `restarting` shows "restarting". It does not show "offline".

### 6. The CLI: `claude-rc update --all-nodes`

The hub gets a second route, `GET /cli/api/events`, behind the same authentication as the other `/cli/api/*` routes. It sends the same events as the browser stream.

`claude-rc update --all-nodes` opens that stream before it starts the first update. The command still updates the machines one after the other, with the nodes first and the hub last. While a machine updates, the command prints each `log` line of that machine, with the host id in front, for example `[kirstation4] downloading claude-rc-launcher-win-x64.exe`. A machine is done when its update entry has a final status. The command prints the result table at the end, as it does today.

When the hub restarts for its own update, the stream ends. The command reconnects and goes on, as it already waits for the hub to answer again. With `--json`, the lines go to standard error and the result stays on standard output. If the stream cannot be opened, the command still updates every machine and prints the table, without lines. This is the author's call.

### 7. The page, output lines

Each running or finished update shows an output panel in the host row, below the step text. The panel holds the lines of that host, newest at the bottom, and follows new lines while it is open. A tab that opens late gets the lines from the `snapshot`. The panel is closed by default for a finished update.

### 8. The update tracker

The tracker keeps its polling as the fallback. This is the author's call. It gets one addition. When a presence event for a host in the `running` state reports `online` with the target version, the tracker writes `updated` at once. It does not wait for the next poll. The poll still settles every other result (`rolled back` and `unknown`).

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
- Updater lines: each updater (Linux and Windows) writes a line for each action and each step change, including a failed action, and works with no callbacks. The node keeps the last 200 lines and sends them to a connection that opens mid-update.
- CLI: `update --all-nodes` prints the lines of each machine with its host id, in order. It reconnects when the hub restarts, prints the table at the end, and puts the lines on standard error with `--json`. It still finishes when the stream cannot be opened.
- Page: the output panel shows the lines of the host, follows new lines, and shows the backlog in a tab that opens late.
- `HostClient.stream`: events are parsed across chunk boundaries. A pinned certificate mismatch is `certificate mismatch`. A `404` is a `bad response`. Abort ends the iteration.
- `NodeWatcher`: the node is online on connect and offline on drop. The node is `restarting` after a `restarting` step. The backoff sequence and the jitter bounds are right (use a fake clock). A silent stream is dropped after 45 seconds. A host that is added or removed at run time gets or loses its watcher. A `step` event reaches the update record only while the entry is `running`.
- Record and stream: `step` reaches the subscribers of `GET /api/events`, and two connected subscribers both get it. The `snapshot` carries both the update entries and the presence list.
- Page: presence events patch the cached host list without a refetch. A change of version refetches. The `step` text shows while an entry is `running`, and only then.
- Tracker: an `online` presence event with the target version writes `updated`. Without the event, the poll still does.
- End to end (in the style of the existing e2e tests): a hub and a fake node, an update with steps, and a node restart. Two subscribers both see the steps and the presence changes.

## Open points

No open point blocks the plan. The author made some choices without the user. The user can change them:

- The host list keeps probing every node. Presence only adds to it.
- A node accepts at most 8 event connections.
- The rules for `restarting`, the status order of authority and the shape of `step` and `stepDetail` are in sections 3, 4 and 5. The builder check raised them, and the author settled them.
- A node without the event route answers `404`, and the hub shows that node as `error`. The order of an upgrade is therefore the nodes first, then the hub.

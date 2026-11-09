# Version check and node update in the web UI: design

Status: draft, waiting for approval. Date: 2026-11-09.

## Intent

An admin wants the web UI to show when a node runs an old version. The admin also wants to update the node from the same page. Today the admin must run `claude-rc update --all-nodes` from a terminal, and nothing tells the admin that a node is stale.

The hub is the master. Nodes must match the hub. The hub must match the latest GitHub release. The admin decides when the hub moves to a new release. The admin has little reason to leave a node behind the hub.

## Goals

1. The node drop-down shows the service version and the client version of each node. A stale node is marked.
2. A line above the New button shows the hub's service version and client version. If the hub is older than the latest release, the line also shows the latest release.
3. When the page loads, a banner appears at the top if the hub or any node is stale. The banner has an Update button.
4. The hub and the nodes update in two separate clicks. One banner offers the hub update. Another offers the node update. The admin can accept one and refuse the other.
5. Each stale node also has an Update button in the drop-down. The banner has an Update all nodes button.
6. When the admin returns to a tab after a stale period, the page checks again by itself.
7. After an update, the page shows the result of each machine and the new versions. A failed or rolled back update shows its reason.
8. The hub keeps a record of the last update of each machine. Every browser sees the same record, also after a hub restart.
9. The hub streams update events to every open page with server-sent events (SSE), so that the page does not poll during an update.

## Non-goals

- Updating automatically without a click.
- Updating nodes to a release that is not the hub's version. Nodes follow the hub, not GitHub.
- Updating the hub and the nodes with one click.
- Admin-only access. Any logged-in user sees the banner and can update, as for the CLI today. The admin group will come later through OIDC.
- Updating a node that cannot be updated remotely. The banner says what to do by hand.
- Moving the rest of the web app to TanStack Query. This change uses it for the version data and for the host list only. The instance list, the dialogs, `poll.ts` and the `fetch` calls in `api.ts` keep their current code. A separate change migrates them later.
- Progress for each step of an update (download, checksum, restart). The stream reports only that an update started, finished, failed or rolled back. Step progress needs a streaming route on the node and is a later stage.

## Anti-goals

- The browser must never name a download URL. The update takes at most a release tag, and the machine downloads from the project's GitHub releases only. This is the rule of the existing `POST /update`.
- The page must never call GitHub. Only the hub does.
- A failed version lookup must never show a false "stale" or hide a real one. If a version is unknown, the UI says "unknown" and does not offer an update for it.

## What "stale" means

- Hub: its service version is older than the latest release, or its client copy is older than the latest release.
- Node: its service version or its client version is older than the hub's service version.
- A version of `dev` is never stale and never offers an update.
- Versions are compared as numbers, not as text.
- A pre-release tag (for example `1.2.3-rc.1`) sorts below its release. The builder decides the exact rule and tests it.

## Design

### Where the versions come from

- The service version of every host is already in `GET /api/hosts` as `version`. The browser type `HostInfo` does not have the field yet.
- The client version is not reported today. Each machine's `GET /node` answer gains a `clients` field: the version of each client copy that the update code already finds (`findClients`), as `{ path, version? }`. The hub copies the first usable value into the host list as `clientVersion`. A machine with no client copy reports none, and the UI says "no client".
- The hub gains one route, `GET /api/latest`, that returns `{ version, checkedAt }`. The hub reads the latest release tag from GitHub and keeps the answer for one hour. If GitHub does not answer, the route returns the last good value, or a clear error if there is none. The browser shows "latest unknown" for an error.
- The hub itself uses the `local` host. The same fields apply to it.

### What the UI does

- A shared query for the host list and one for the latest release. The page uses TanStack Query (`@tanstack/svelte-query`, built for Svelte 5 which this app already uses). This is the design's choice. Nothing in the repo uses it yet. If it does not fit the Vite and Bun build, the builder can reject it and must give the reason.
- The host list has a stale time of about five minutes. It refetches when the window gets focus again, so a return after a stale period checks again. The latest-release query has the same setting. The existing 15 second host poll in `App.svelte` is replaced by this.
- The banner is a new component at the top of the page, above the header's content area. It lists what is stale and offers the buttons from the goals. The admin can dismiss it. After the next page load, or when the stale set changes, a dismissed banner comes back.
- The hub line above the New button is a small component. The node drop-down (`HostPicker.svelte`) shows the two versions and the stale mark for each option. A native select can show text only. If the mark and the Update button need more, the builder can replace it with a custom list.
- An update is a mutation that calls `POST /api/hosts/:host/update`. For a node, the body carries the hub's own version as `release`. For the hub, the body is empty, which means the latest release. While a machine restarts, the page polls its host entry every few seconds. The polling ends when the version changes or after 90 seconds, like the CLI. The result then goes to the banner.

### The update record and the event stream

- The hub keeps `<stateDir>/updates.json`. It holds the last update of each host id: `{ host, startedAt, finishedAt?, startedBy, from, to?, status, error? }`. The status is one of `running`, `updated`, `up-to-date`, `failed`, `rolled back` or `unknown`. The hub writes the file atomically, as it does for `managed-hosts.json`. `startedBy` comes from the same caller that the audit log names.
- For a node, the hub writes `running` when it forwards the update, and writes the result when the node answers. If the node does not come back with the new version within 90 seconds, the status is `unknown` and the reason says so.
- For the hub itself, the hub writes `running` before it answers `202`. The new process reads the file at start. If the hub version is not the `from` version, it marks the entry `updated`. If the version is the same, it marks the entry `rolled back`, because the watchdog restored the old file. The builder confirms that this rule matches the watchdog.
- `GET /api/updates` returns the record. `GET /api/events` is an SSE stream for logged-in users. When a page connects, the stream first sends the full record. After that, it sends an `update` event each time an entry changes. The browser reconnects by itself after a drop. The hub restarts during its own update, so the stream must come back without a click.
- When an update event arrives, the page refetches the host list and the record. This replaces the polling during an update. The five minute stale time and the refetch on focus stay as the safety net.
- The stream must keep working through the proxy rules and the idle timeout that `serve.ts` already sets for the update route. The builder checks the idle timeout and sends a comment line as a keepalive.

### The hub update

The hub restarts when it updates. The page loses its connection for a short time. After the hub is back with the new version, the banner offers the node update with the new hub version. This is the second click.

### Limits

- The update runs only on a system-scope service that was installed with the installer (Linux, or a Windows node through its own updater). A user-scope service and a Linux machine whose service is not the installed one answer 409. The banner shows the message that the machine gave and offers no retry.
- A node too old to have `POST /update` answers 404 through the hub. The banner says to run `claude-rc node update` on it once.
- A release that changes how the hub talks to the nodes can leave an updated hub unable to reach the old nodes. The README already says to roll such a release out by hand. The banner must not hide that: when the hub update succeeds and a node then shows `offline`, the banner says so.

## Constraints

- Bun and TypeScript on the server. Svelte 5 and Vite in `web`. Follow the existing style.
- Tests need no network, no systemd and no root. The server code that reads GitHub takes `fetch` as an input, like the release code does.
- The server work reuses the existing update code. There must be no second implementation of the download and rollback.

## Calls made by the author

These points came from the builder check. The author settled them. The reader can change any of them.

1. Release tags. A release build reports its version without the leading `v` (for example `0.8.3`). The GitHub tag has the `v`. The server adds the `v` before it builds a download URL. `POST /update` accepts both forms. `GET /api/latest` returns the version without the `v`. The browser then compares and sends bare versions only.
2. Local builds. A version such as `0.8.3+branch.sha.dirty`, and the version `dev`, count as unknown. They are never stale and never a target. If the hub runs a local build, the banner offers no node update and says that the hub runs a local build. A node on a local build shows no Update button.
3. Client version. The node runs `<client> --version` for each copy that `findClients` finds. The node keeps the answer for 60 seconds, so the host poll does not start a process each time. If a node has two copies, the stalest one decides. The hub's `local` host uses the same code. A release publishes the service and the client with the same version number.
4. Hub update. The page calls `POST /api/hosts/local/update`. The hub already routes `local` to its own updater. After the hub starts to restart, a failed request is expected. The page waits up to 90 seconds for the stream to return and show the hub's result.
5. Result after the hub restart. The hub keeps the result in its record, not the browser. The warning that a node is offline after a hub update shows when the hub's record says `updated` within the last 10 minutes and a node is offline.
6. Hub client copy. A hub update with no release updates the service and its client copies. If the hub is still stale after an update, the banner says to update by hand and gives the command `claude-rc node update`.

## Left to the builder

The names of modules and components, the exact stale-time values, the version comparison code, the layout and style of the banner and the hub line, the polling code, and whether the drop-down stays a native select.

## Tests the builder must add

- Server: the update record (write, atomic replace, a restart that finds `running` with a new version, with the same version, and with no file). The event stream (the first message holds the record, a change sends an event, a closed connection frees its resources). The version comparison (numbers, `dev`, pre-release, unknown). The latest release route with a fake `fetch`: a good answer, the one hour cache, a GitHub failure with a cached value, a GitHub failure with none. The `clients` field in `GET /node`, with one copy, two copies and none.
- Web: the stale rules for the hub and for the nodes, as plain functions. The banner shows for a stale node, shows for a stale hub, and does not show when everything is current or unknown. An update that fails shows its reason. A node that answers 404 shows the by-hand message.
- A test that no request from the browser carries a URL or any value other than a release tag.

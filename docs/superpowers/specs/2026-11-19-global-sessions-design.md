# Global sessions view and node filter

Date: 2026-11-19. Status: draft, waiting for approval.

## Intent

The user works with sessions, not with nodes. Today the node drop-down in the header decides which instances the list shows. To reach a session, the user must choose a node, then an instance, then Sessions. This is the wrong order for the way the app is used.

The change makes two top-level views, Sessions and Instances, each showing every node. A row of node chips filters both views. The node drop-down goes away. Nodes become a place to manage machines (rename, update), reached from the menu.

## Goals

- One list of all sessions on all nodes, with live sessions on top.
- One Instances view for all nodes.
- Node chips on both views to narrow the list to some nodes.
- Sessions and Instances are the two items on the bottom bar.
- A node that is offline or slow does not block the rest of the list.

## Non-goals

- No global instances endpoint. The Instances view keeps using the existing per-node instance list.
- No search inside transcripts, no pagination, no grouping by repository.
- No push updates in the first step. The page polls every 15 seconds, as the per-instance list does today. A second step can add a `sessions-changed` event on the stream that the hub already keeps open to each node. A node does not push to the hub: the hub opens the connection (decided 2026-11-10).
- No change to the session view (touched files, changed files, folder, permissions).

## Anti-goals

- The Sessions view must not get slow or fail because one node is down or runs an old version.
- The change must not lose a thing the node drop-down did (where "+ New" starts an instance, where the update output shows). Each of these needs a new home, listed below.

## Constraints

- A node lists sessions per instance today (`GET /instances/:id/sessions`, built in `server/src/sessionapi.ts`). The hub reaches other nodes with `registry.list()` and `client.call` (see `hostsApi` in `server/src/hosts.ts`).
- Roles: any role that can read the per-instance session list can read the new list. The builder must check `server/src/roles.ts`.
- An older node has no new endpoint and answers 404. The hub must handle that.
- Sessions of a node stay readable only through that node. Access checks (instance owner, real root) do not change.

## Approaches considered

The choice was where the global list gets its data.

1. The web app calls the existing per-instance endpoints for every instance and merges. No server change, works with old nodes, but it sends one request per instance every 15 seconds.
2. A new all-sessions endpoint on each node, merged by the hub. One request per node, but a node shows no sessions until it is updated. The user picked this one.
3. The same endpoint, but a node scans in the background and answers from its last result. The user suggested this. It has two scan speeds. If nobody asks, the slow speed applies. If someone asks, the fast speed applies. The hub keeps no copy of node state. This is the chosen way.

For the nav, the other option was to keep the node drop-down and add a global view next to it. The user wanted the drop-down removed, so it is not built.

## Design

### Node endpoint

`GET /api/sessions` on a node (served by the same code that serves `/api/instances`). It lists the instances of the node (`instances.list()`) and, for each, the sessions (`catalog.instance(home).list()`). It reads instances with the concurrency limit that `sessioncatalog.ts` already has (`mapLimit`). It returns a flat array. Each item is the existing session fields plus `instance: { id, name, path, state }`. An instance whose sessions cannot be read (no Claude home, read error) is left out and does not fail the call.

The node does not scan on each request. It keeps the last result in memory and answers from it at once. The answer has a `scannedAt` time. The node scans on a timer with two speeds:

- If nobody asked recently, the passive speed applies. It keeps the copy warm, so the first request after a quiet period does not wait for a scan. Starting value: every 5 minutes.
- The active speed runs while a request came in during the last window. Starting value: every 10 seconds, for 2 minutes after the last request.

A request that finds the copy older than the active interval starts a scan at once and still answers from the old copy. At the start of the node, the first scan runs in the background, and a request before it ends waits for it. Only one scan runs at a time. The status of a running session (live, busy, idle) is cheap to read, so each request reads it again and replaces the stored status. This way a live session does not look idle for 5 minutes. The builder tunes all of these numbers after measuring (see below).

### Hub endpoint

`GET /api/sessions` on the hub asks the local node and every host in the registry. Each call has the same time limit that the host list uses for a probe. The hub adds `host: { id, name }` to each item. The answer is:

```
{ sessions: GlobalSession[], hosts: { id: string, status: "ok" | "offline" | "error" | "unsupported", error?: string }[] }
```

A host that answers 404 is `unsupported`. A host that is unreachable is `offline` or `error`, as in `HostInfo`. The call itself succeeds as long as the hub is up. The hub does not sort.

### Web: Sessions view

- `/sessions` with no `session` parameter shows the global list. A row shows what the per-instance row shows today, plus the node name and the instance name.
- Sort (the web app does it): live sessions first, busy before idle, then all others by `lastActiveAt`, newest first. This is my call.
- A row links to the session view (`/sessions?host=&instance=&session=`), as today.
- `/sessions?host=&instance=` (the link from an instance card) shows the same list filtered to that instance, with a removable "Instance: name" chip. This is my call. It replaces the per-instance `SessionList`.
- The filter box stays. It also matches the node and instance name.
- Under the chips, a short notice lists each node that did not answer or needs an update. This way the user does not mistake a missing node for "no sessions".
- The back link in the session view returns to the global list (see `crumbs.ts`).

### Web: node chips

- One chip per node. No chip selected means all nodes. Several can be selected.
- The selection is kept in `sessionStorage` for the tab and is shared by both views. A node that is gone from the host list is dropped from the selection.
- When there is only one node, the chips are hidden.
- A chip for a node that is offline stays visible and muted, with its status.

### Web: Instances view

- If no chip is selected, the view shows the instances of all nodes. Otherwise it shows the instances of the selected nodes. It uses the existing per-node instance query. If more than one node shows, each node has a heading. This is my call.
- "+ New" stays here. If exactly one chip is selected, the dialog uses that node. Otherwise the dialog asks which node (a node field is added to `NewDialog`).

### Web: shell

- `HostPicker` is removed from the header. Its Update button and its step text are not needed: the Nodes page already updates nodes and shows the update-available arrow.
- Bottom bar: Sessions, the menu button, Instances. Nodes moves into the menu sheet. A node card on the Nodes page links to Instances with that node selected.
- The home address `/` goes to `/sessions`.
- The finished-update panel in `Shell.svelte` (shown for the selected node) moves to the Nodes page, next to its node. This is my call.
- `flow.selected` in `startflow.svelte.ts` is no longer "the active node". It becomes the node chosen for a new instance. The Permissions page also reads it and must take its host from the address instead (builder to check).

### Tests and docs

- Server tests: the node endpoint (several instances, one unreadable), the hub merge (one host offline, one 404, local only).
- Web tests: the sort, the chip selection rules, the notice for missing nodes, the New dialog node choice.
- Update `docs/api.md`, `docs/web-ui.md`, `docs/multi-host.md`, and the session part of `docs/session-files.md`.

## Left to the builder

- The two scan intervals, the active window, and the time limit and concurrency of the scan. Measure the cost of one scan on the real hub (many instances, cold name cache) before choosing.
- How the node invalidates the copy at the start or stop of an instance. A new instance then shows before the next scan.
- How the chips look (touch size, wrapping on a phone). Follow the shadcn components already in use.
- Whether the Instances headings and the Sessions rows need a node color or only text.
- The role check for the new route.

## Risks

- A scan of all instances can be slow. Only a request before the first scan ends waits for it. For all other requests, a slow scan only makes the data older. The passive scan still costs some work on an idle node. If a scan is too costly, the builder reports it and we lengthen the passive interval.
- The data can be up to one active interval old, and up to one passive interval old for the first view after a quiet period. If the age matters, the page can show it from the `scannedAt` time.
- Users on an old node see no sessions for it until they update it. The notice says so.

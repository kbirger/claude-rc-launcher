# HTTP API

The web UI and the CLI use this API. Every route under `/api` needs a browser session. The CLI uses the same handlers under `/cli/api` with `Authorization: Bearer <ID token>`. The hub checks the role on every route. A route that has no policy entry needs `admin`.

The command-line client uses the same handlers under `/cli/api` with `Authorization: Bearer <ID token>`:
`GET /cli/api/me`, the host routes below, and the host management routes `POST /cli/api/hosts/probe
{url, server_name?}`, `POST /cli/api/hosts {id, name?, url, server_name?, fingerprint, force?}` and
`DELETE /cli/api/hosts/:id`. `GET /cli/config` returns `{issuer, client_id}` and, when a role scope is set, `role_scope`. It needs no token.

`GET /instances`, `POST /instances {path, name?, user?, addTrust?}` (201), `DELETE /instances/:id`,
`GET /instances/:id/logs`, `GET /users`, `GET /fs?path=&user=`,
`POST /fs/mkdir {parent, name, user?}`, and `GET /api/me`. Unauthenticated `GET /healthz` for liveness.

- `GET /users` returns `{selectable, default, users: [{name}]}`. `selectable` is false when the node cannot switch users.
- `user` on `POST /instances` is the user that runs the unit. It defaults to the configured `service_user`. An unknown user, or any
  other user when `selectable` is false, gets a 400.
- `addTrust: true` adds the folder to that user's trust file. The server never adds trust unless the request says so.
- `user` on `GET /fs` selects the user whose trust is shown. Each directory entry always carries `trusted`, true or
  false. If `user` is omitted, `trusted` is for the configured `service_user`.
  A directory entry below a root also carries `kind`, either `git` or `github`. A regular folder has no `kind`.
  The roots-level listing has no `kind`.
- `user` on `POST /fs/mkdir` is the user that owns the new folder. The rules are the same as for `user` on
  `POST /instances`. If `user` is omitted and the node runs as root, the folder belongs to the configured
  `service_user`. The roots do not follow `user`.
- A start in an untrusted folder gets `428 {error, code: "untrusted", user, path}`. Retry with `addTrust: true` to trust it.
- A start in a folder that already has an instance gets `409 {error, instance}`. The `error` names the user that runs it,
  for example `already running in this directory as alice`.

Since multi-host support these instance and filesystem routes live under a host:
`/api/hosts/<id>/instances`, `/api/hosts/<id>/users`, `/api/hosts/<id>/fs`, ... (use `local` for the hub's own host), and
`GET /api/hosts` lists the hosts. A node serves the same routes at `/api/...` plus `GET /api/node`,
authenticated by bearer token only. The CLI reaches the same routes at `/cli/api/hosts/<id>/instances`,
`/cli/api/hosts/<id>/users` and `/cli/api/hosts/<id>/fs`. A node that is too old to serve `/users` returns 404. The web
UI then hides the selector and the locks.

Clone routes (see [Cloning a repo](web-ui.md#clone-a-github-repository)). Each one exists under `/api/hosts/<id>/...` on the hub and
under `/api/...` on a node. A node that is too old answers 404.

- `GET /node` returns `{ok, name, version, clone, clients}`. `clone` is a boolean. It is false when the node has no clone support. `clients` lists the client copies on the node with their versions.
- `POST /clone {repo, parent, user?}` returns 202 `{id, path}`. `path` is the new folder.
- `GET /clone/:id` returns `{state, path?, error?}`. `state` is `running`, `done` or `failed`.
- `GET /github/repos?user=` returns `{groups: [{owner, repos: [{name, private, pushedAt}]}]}`. If no login exists, it
  returns 409 `{error, code: "github-login-required"}`.
- `POST /github/login {user?}` returns 202 `{id, code, url}`. Always send a body, for example `{}`.
- `GET /github/login/:id` returns `{state, error?}`. `state` is `pending`, `done` or `failed`.

Version routes (see [Version check and updates in the web UI](updates.md#version-check-and-updates-in-the-web-ui)). They exist on the hub only.

- `GET /latest` returns `{version, checkedAt}`, the latest GitHub release. If GitHub never answered, it returns 503.
- `GET /updates` returns the update record of each machine.
- `GET /events` is a server-sent event stream. The CLI reads it at `GET /cli/api/events`. The first event is
  `snapshot`. Its data is `{ updates, logs, presence }`. `updates` is the record of each machine. `logs` maps a host id
  to its last lines, each `{ line, at }`. `presence` lists `{ host, status, version?, reason?, at }` for each node.
  Then three events follow. `update` carries a changed record entry. `log` carries a new line, `{ host, line, at }`.
  `presence` carries a changed status of a node. The hub also sends keepalive comments.
- Each entry of `GET /hosts` also carries `clientVersion`, `noClient`, `stale` and `target`.

Event route of a node. The hub opens it for each node, with the same authentication as the other node routes.

- `GET /api/events` is a server-sent event stream. The first event is `snapshot` with `{ version, update, sessions }`.
  `sessions` is the last sessions payload of the node, or `null` before the first scan. The kept
  lines of the current update follow as `log` events, each `{ line, at }`. Then each step of an update sends a `step`
  event, and each line sends a `log` event. The node sends keepalive comments. A node accepts 8 open connections.
  The ninth gets 429.

## The list of all sessions

`GET /api/sessions` on the hub (and `GET /cli/api/sessions` for the CLI) lists the sessions of every instance on every host. The role `read` is enough. The hub answers from its own store, which holds the last list of each host. It calls no node, so a node that is down does not slow the answer. The hub does not sort the rows. The answer is:

```json
{
  "sessions": [{ "id": "...", "root": "...", "startedAt": "...", "lastActiveAt": "...", "instance": { "id": "...", "name": "...", "path": "...", "state": "active" }, "host": { "id": "local", "name": "hub" } }],
  "hosts": [{ "id": "local", "name": "hub", "status": "ok", "scannedAt": "2026-01-01T00:00:00.000Z" }]
}
```

The fields of a session are the fields of `GET /instances/:id/sessions`, plus `instance` and `host`. The `status` of a host is one of these:

- `ok`: the list of the host is in the rows.
- `offline`: the node watcher says the node is not online. The host has no rows, and `error` gives the reason.
- `error`: the watcher reports an error for the node. The host has no rows.
- `unavailable`: the node has no session files, so it cannot list sessions.
- `loading`: the hub has no list of this host yet. This is the case just after a hub start or after a host is added.

A host with the status `ok` can also have `truncated: true`. Then the node sent only its newest rows, because the whole list was too large. The field is absent when the list is whole. Read [Known limits](session-files.md#known-limits).

A host that has no rows still gives status 200 for the call. The `unsupported` status does not exist.

`GET /api/hosts` gives each host a field `sessions` (`HostInfo.sessions`). It is `false` when the node has no session files, and `true` otherwise. The web app uses it to hide the Sessions button of an instance.

### The sessions stream

`GET /api/sessions/events` is a server-sent event stream for browsers. It is a GET, so the CSRF rule does not apply. It sends two events:

- `snapshot` has the same body as `GET /api/sessions`. It is the first event. The hub sends a new `snapshot` after a host is added, removed or renamed.
- `host` has `{ host, rows }`. It replaces the status and the rows of one host and keeps the others. The hub sends it when the list of the host changes, and when the presence of the host changes.

The hub sends keepalive comments. Each open stream counts as one viewer of the beat loop. Read [The list of all sessions](session-files.md#the-list-of-all-sessions).

### The node routes

A node serves `GET /api/sessions` with the answer `{ scannedAt, sessions }`, with `instance` on each session. It answers from a copy in memory. The hub does not use this route now. It stays for debugging with `curl`.

A node also serves `POST /api/sessions/watch`. The hub calls it with the body `{}` as a heartbeat. The answer is 204. Each call keeps the node in the active mode for 60 000 ms. The node sends its sessions to the hub in `GET /api/events`: the `snapshot` event has a field `sessions`, and the `sessions` event has `{ scannedAt, available, sessions }`. If the list is over 900 000 bytes of JSON, the node sends only the newest rows that fit and adds `truncated: true`. The node writes no audit line for this heartbeat.

## SSH provisioner routes

This section lists only the routes and fields of the provisioner key. They are under `/api/ssh` and `/cli/api/ssh`. Read [The provisioner key](ssh-delegation.md#the-provisioner-key) for what they mean. A `write` user can read `GET /status`, `GET /targets` and `GET /grants`. Every other route here needs the `admin` role.

### Routes

- `POST /targets/:id/provisioner-key` with `{unlock}` makes the key. The answer is 200 `{publicLine, fingerprint}`.
- For a wrong unlock, the answer is 403. That check comes before the 409 for a key that exists already.
- A managed target or a `windows` target gets 400.
- `DELETE /targets/:id/provisioner-key` removes the key. The answer is 204, or 404 for no key.
- `GET /targets/:id/provisioner-install` gives the install script, as 200 `{shell: "sh", script}`. A `dropbear` target gets the router version.
- The install route answers 409 for a missing main key or provisioner key. If `local` is off or has no source address, the answer is 409 too.
- If a source address is a pattern, the answer is 409 with "the install script cannot be made". A router also needs an IP address for `local`.
- `POST /targets/:id/provisioner-installed` with `{script}` stores the script path. The answer is 200 with the target.
- For a router, the path must be `/jffs/scripts/claude-rc-provisioner-<id>.sh`. Else the path must end with `/provisioner-<id>.sh`. A wrong path gets 400.
- `POST /targets/:id/reinstall` answers 202 `{maintenance}` with the action `install`.

### Changed routes

- `PATCH /targets/:id` with `nodes`, for a target with a key and a provisioner, answers 202 `{maintenance}` with the action `sources`.
- The new body field `confirm` is a boolean. Else the answer is 400.
- If the new list shares no address with the old list, the answer is 409 without `confirm: true`. This does not hold for `dropbear`.
- For a target with a provisioner, a body with both `state` and `nodes` gets 400.
- `DELETE /targets/:id` for a target with a provisioner answers 202 `{maintenance}` with the action `uninstall`. The target goes to `disabled`.
- With `?cleanup=none`, the answer is 200 with the retire answer and `line: "manual"`. Another value of `cleanup` gets 400.
- `POST /grants/:id/approve` for a maintenance grant ignores `minutes`. For `sources`, the answer is 200 `{...grant, target, pushed, lineUpdated: true}`.
- For `uninstall`, the answer is 200 `{...grant, retired}`. A failed run still retires, with `line: "failed"` and a detail.
- For `install`, the answer is 200 with the grant. A failed `sources` or `install` run gets 502 with the reason.
- If another change runs, the approve answers 409.
- The answer of `PUT /nodes/local` has `staleProvisioners`, a list of target ids. These targets need the repair command.
- `GET /targets/:id/salt` and `POST /targets/:id/rewrap` take `key`, which is `main` or `provisioner`. Another value gets 400.

### Fields

- A target can have `provisionerFingerprint`, `provisionerSource` and `provisionerScript`.
- `GET /status` has `pendingProvisionerRewrap`, a list of target ids.
- In `GET /grants`, a maintenance grant has `maintenance`. It holds `action`, `fromNodes`, `toNodes`, `fromSources`, `toSources`, `result`, `detail` and `started`.

### Refusals of a maintenance request

The three routes that answer 202 refuse a request in these cases:

- If the hub has no client for the node `local`, the answer is 501.
- A second request for the same target gets 409 "a maintenance request waits for this target".
- No provisioner, no `ssh` program, or `local` off gets 409.
- A changed source address of `local`, a key that waits for a re-lock, or no pinned host key gets 409.
- A node source address that is not exact gets 409.

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

- `GET /api/events` is a server-sent event stream. The first event is `snapshot` with `{ version, update }`. The kept
  lines of the current update follow as `log` events, each `{ line, at }`. Then each step of an update sends a `step`
  event, and each line sends a `log` event. The node sends keepalive comments. A node accepts 8 open connections.
  The ninth gets 429.

## The list of all sessions

`GET /api/sessions` on the hub (and `GET /cli/api/sessions` for the CLI) lists the sessions of every instance on every host. The role `read` is enough. The hub asks its own node and each paired node for `GET /api/sessions` and merges the answers. It does not sort them. The answer is:

```json
{
  "sessions": [{ "id": "...", "root": "...", "startedAt": "...", "lastActiveAt": "...", "instance": { "id": "...", "name": "...", "path": "...", "state": "active" }, "host": { "id": "local", "name": "hub" } }],
  "hosts": [{ "id": "local", "name": "hub", "status": "ok", "scannedAt": "2026-01-01T00:00:00.000Z" }]
}
```

The fields of a session are the fields of `GET /instances/:id/sessions`, plus `instance` and `host`. The `status` of a host is `ok`, `offline`, `error` or `unsupported`. A node that answers 404 or 501 is `unsupported`: it runs a release without this route. A host that does not answer has no rows, and the call still gives 200. The hub does not call a host that its node watcher knows is not online: it reports the status of the watcher at once, so a node that is down does not slow the list.

A node serves the same route as `GET /api/sessions`. Its answer is `{ scannedAt, sessions }`, with `instance` on each session. The node answers from a copy in memory. Read [The list of all sessions](session-files.md#the-list-of-all-sessions).

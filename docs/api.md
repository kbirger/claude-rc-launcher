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

## SSH routes

The SSH routes are under `/api/ssh` and `/cli/api/ssh`. A target is a machine that a node reaches with SSH. A grant is a time-limited approval that lets one session use the key of a target. An unlock is the secret that opens a key. Read [SSH delegation](ssh-delegation.md) for what these mean.

- If SSH delegation is not built in, the hub has no SSH routes. Each write writes one audit line.
- A `write` user can read `GET /status`, `GET /targets` and `GET /grants`. Every other route needs the `admin` role.
- Until `POST /setup` has run, every route except `GET /status` and `POST /setup` answers 409 "SSH access is not set up".
- An unlock in a body is `{method, secret}`. The `method` is `prf` or `passphrase`, and it must match the method of the hub. The `secret` is base64url text.
- A bad unlock gets 400. A wrong unlock gets 403. A node that fails or cannot be reached gets 502. A 404 names a target or a grant that does not exist.
- No route returns a private key or an unlock. Only `POST /setup` returns the recovery code, and only once.
- The provisioner key, the maintenance requests and the stale provisioners are in [SSH provisioner routes](#ssh-provisioner-routes). The routes there are not repeated here.

### Setup and recovery

- `GET /status` has the role `write`. The answer is 200 `{setUp, method?, credentialId?, pendingRewrap, pendingProvisionerRewrap, hasKeys, nodes}`.
- The field `nodes` is a list of `{host, enabled, sourceAddress}`, one for each host. The fields `pendingRewrap` and `pendingProvisionerRewrap` are lists of target ids.
- `POST /setup` has the role `admin`. The body is `{method, credentialId?}`. The `credentialId` is base64url text. A `prf` method needs it, and a `passphrase` method must not have it.
- If setup has run already, `POST /setup` answers 409. A bad body gets 400. The answer is 200 `{recoveryCode}` with `cache-control: no-store`.
- `POST /recovery/begin` has the role `admin`. The body is `{code, method, credentialId?}` with the rules of `POST /setup`. The `code` is the recovery code.
- The answer is 200 `{targets}`, a list of target ids that need a re-wrap. All active grants end with the reason `revoked`. A wrong recovery code gets 403.
- `PUT /nodes/:host` has the role `admin`. The body is `{enabled, sourceAddress}`. The `enabled` field is a boolean, and `sourceAddress` is text.
- The answer is 200 `{host, enabled, sourceAddress, pushed}`, with `staleProvisioners` for `local`. If a node did not get its target list, `pushed` is false.
- An unknown host gets 404. A source address that is not valid gets 400.

### Targets

- `GET /targets` has the role `write`. The answer is 200 with the list of targets.
- A target has `id`, `address`, `port`, `account`, `systemType`, `nodes` and `state`. It can have `managedHost`, `keyFile`, `hostKey`, `keyFingerprint` and the provisioner fields.
- `POST /targets` has the role `admin`. The body needs `id`, `account`, `systemType` and `nodes`. The `systemType` is `linux`, `windows`, `synology` or `dropbear`.
- The body can have `managedHost`, `keyFile`, `address` and `port`. The default `port` is 22. A target needs an `address`, or a `managedHost` from which the hub takes it.
- For `managedHost` set to `local`, the hub cannot tell the address, so it uses the source address of `local`. Without one, the answer is 400.
- The answer is 201 with the target. A bad body gets 400. An `id` that exists gets 409.
- `GET /targets/:id` has the role `admin`. The answer is 200 with the target and `notes`, a list of install notes for its system type.
- `PATCH /targets/:id` has the role `admin`. The body has `state`, `nodes` or both. The `state` is `disabled` or `draft`. The field `confirm` is a boolean.
- The answer is 200 with the target. It adds `pushed` for a new `nodes` list, `installLine` for an external target with a key, and `lineUpdated` for a managed target.
- A body with neither field gets 400. A target in a retire or another change gets 409. A new list with no usable source address gets 409.
- If the managed target did not take the new key line, the answer is 502 and the list stays as it was. A target with a provisioner is in [Changed routes](#changed-routes).
- `DELETE /targets/:id` has the role `admin`. The answer is 200 `{id, account, address, port, systemType, managed, line}`. The grants of the target end.
- The field `line` is `removed`, `not-found`, `failed` or `manual`. It can also have `detail`, `comments` and `script`.
- A target in a retire or another change gets 409. The other cases are in [Changed routes](#changed-routes).
- `GET /targets/:id/salt` has the role `admin`. The answer is 200 `{salt, method, credentialId?}`. The client needs the salt to make the unlock of a key.
- The query `key` is `main` or `provisioner`. Another value gets 400. A target in a retire gets 409.
- `POST /targets/:id/rewrap` has the role `admin`. The body is `{code, unlock, key?}`. It seals a key again after a recovery. The answer is 204.
- A target that needs no re-wrap gets 409. A wrong recovery code or a wrong unlock gets 403.
- `POST /targets/:id/key` has the role `admin`. The body is `{unlock}`. It makes the main key. The answer is 200 `{publicLine, fingerprint, installLine, notes}`.
- A target that has a key, or has no node with a source address, gets 409. A target in a retire or another change gets 409.
- `GET /targets/:id/provision` has the role `admin`. The answer is 200 `{shell, script}`. The script installs the key line on the target. The `shell` is `sh` or `powershell`.
- A target with no node that has a source address gets 409.

### Host keys and tests

- `POST /targets/:id/scan` has the role `admin`. The body is `{node}`. The node reads the host keys of the target. The hub does not store them.
- The answer is 200 `{keys}`, a list of `{line, fingerprint}`. A node that is not in the list of the target gets 409.
- `POST /targets/:id/pin` has the role `admin`. The body is `{hostKey}`, one line `<type> <base64>`. The answer is 200 with the target. A bad line gets 400.
- `POST /targets/:id/pin-managed` has the role `admin`. It has no body. The managed node reads its own host key, and the hub pins it. The answer is 200 `{keys}`.
- A target that is not managed gets 409. A node that returns no key gets 502.
- `POST /targets/:id/authorize` has the role `admin`. It has no body. The managed node puts the key line into the key file of the account. The answer is 200 `{ok: true}`.
- A target that is not managed gets 409. A target with no usable source address gets 409. A failed node gets 502.
- `POST /targets/:id/test` has the role `admin`. The body is `{node, unlock}`. The hub makes a test grant and runs `ssh` from the node.
- The answer is 200 `{ok, error?}`. A good test sets the state of the target to `ready`. A node that is not in the list of the target gets 409.
- A wrong unlock gets 403 and the test grant is denied. A target with no pinned host key gets 409.

### Grants

- `GET /grants` has the role `write`. The answer is 200 with the list of grants.
- A grant has `id`, `nodeId`, `instanceId`, `targetId`, `minutes`, `test`, `state` and `requestedAt`. The `state` is `pending`, `active` or `ended`.
- A grant can have `reason`, `approvedAt`, `endsAt`, `approvedBy`, `endReason` and `maintenance`.
- `POST /grants/:id/approve` has the role `admin`. The body is `{unlock, minutes?}`. The field `minutes` is a number of at least 1. The hub cuts it to its maximum.
- The answer is 200 with the grant. A grant that is not pending gets 409. A target with no pinned host key gets 409. A wrong unlock gets 403.
- A target that waits for a re-wrap gets 409. A maintenance grant is in [Changed routes](#changed-routes).
- `POST /grants/:id/deny` has the role `admin`. It has no body. It ends a pending grant. The answer is 200 with the grant. Another state gets 409.
- `POST /grants/:id/revoke` has the role `admin`. It has no body. It ends an active grant. The answer is 200 with the grant. Another state gets 409.

### The node SSH routes

A node serves its SSH routes under `/api/ssh`, with bearer token authentication. Only the hub calls them. They have no roles. A node without SSH grants answers 501 on the grant routes. The managed routes work on every node.

- `GET /status` answers 200 `{ssh, dir, reason?}`. If the node has an `ssh` client, `ssh` is true. If the grant folder is ready, `dir` is true.
- `POST /grants` starts an agent for a grant. The body has `grantId`, `instanceId`, `targetId`, `publicKey`, `address`, `port`, `account`, `hostKey` and `endsAt`. It can have `requestId`.
- The answer is 200 `{socket, config}`. A bad field gets 400. A grant that exists gets 409. A request that no session waits for gets 409.
- `POST /requests/:requestId/reject` takes `{reason}` and answers 204. It ends the wait of a session. A bad `reason` gets 400.
- `PUT /targets` takes `{targets}`, a list of `{id, account, address}`. The node lists these targets to its sessions. The answer is 204.
- `POST /grants/:id/probe` runs `ssh` with the configuration of the grant. The answer is 200 with the result. An unknown grant gets 404.
- `DELETE /grants/:id` ends the agent of a grant and removes its files. The answer is 204.
- `POST /sign-result` takes `{signId, signature}` or `{signId, error}`. The signature is 64 bytes in base64. The answer is 204. An unknown `signId` gets 404. A bad signature gets 400.
- `POST /reset` ends every grant on the node. The answer is 204.
- `POST /scan` takes `{address, port}`. The answer is 200 `{keys}`, a list of `{line, fingerprint}`. A bad field gets 400.
- `GET /hostkey` answers 200 `{keys}` with the host key of the node.
- `POST /authorize` takes `{account, systemType, line, keyFile?}`. It adds the key line to the key file of the account. The answer is 204. If the body has `keyFile`, the answer is 200 `{keyFile}`.
- `POST /deauthorize` takes `{account, systemType, id, key, keyFile?}`. It removes the key line. The answer is 200 `{result}` with `removed` or `not-found`.
- Both managed routes answer 400 for a bad field or an account with no profile. If the script fails, they answer 500.

## Push routes

The push routes are under `/api/push` and `/cli/api/push`. They register a device for push notifications about SSH requests. If push is not built in, the hub has no push routes. All three routes need the `admin` role.

- `GET /key` answers 200 `{key}`. The `key` is the public VAPID key in base64url text. The browser needs it to subscribe.
- `POST /subscribe` takes `{endpoint, keys: {p256dh, auth}}` and stores the subscription of the caller. The answer is 204.
- A missing field gets 400. An `endpoint` that is not an `https` URL gets 400. A failed save gets 500. Each user can have at most 20 subscriptions.
- `POST /unsubscribe` takes `{endpoint}`. The answer is 204. A subscription that does not exist gets 404.
- Each write writes one audit line with the user and the path. The line has no endpoint and no key.

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

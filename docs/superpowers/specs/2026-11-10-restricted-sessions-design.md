# Restricted Windows sessions: design

Status: draft, from a chat with the user. Date: 2026-11-10. Builds on the findings in `spikes/win-token/FINDINGS.md` (branch `spike/win-token`).

## Intent

A Windows node runs as one user account, and every session runs as that account. If the account is a local administrator, Windows gives the service its full admin token (services get no UAC filtering). So every session, and every tool that `claude` starts, has admin rights. The user wants sessions to run without admin rights by default and to choose admin per session.

The spike showed that the service can start a session with a restricted copy of its own token. A real `claude -p` run under that token worked.

## Goals

1. By default, a session on a Windows node runs with a restricted token: Administrators deny-only, Medium integrity, one privilege (`SeChangeNotifyPrivilege`), as UAC gives a normal program.
2. When the service account is an administrator, the user dropdown lists two entries: `<user>` and `<user> (admin)`. `<user>` is the default. `<user> (admin)` starts the session with the service's own full token, as today.
3. The instance list shows which user entry each session runs as.
4. If the node cannot build the restricted token, the start fails with a clear error. It never falls back to the full token.
5. A session that the node restores after a restart keeps its choice.

## Non-goals

- Starting sessions as other users, or a per-user service. That is a separate design.
- Elevating a running session (`sudo`, `gsudo`, UAC). A session has no desktop, so no one can approve a prompt.
- Admin-only control of who can pick `(admin)`. Until the OIDC admin group exists, any logged-in user of the hub can pick it, as any user can start a session today.
- Changes to the Linux node, the hub or the web code, unless the builder finds one is needed.
- A password prompt change in `install.ps1`.

## Anti-goals

- A session started with the default entry must never hold the administrator group enabled, High integrity or more than the one privilege.
- A failure to restrict the token must never start the session with more rights than the user chose.
- A standard (non-admin) service account must not see an `(admin)` entry.

## Design

### The two entries

`GET /users` on a Windows node returns `selectable: true` and `users: [{ name: "<user>" }, { name: "<user> (admin)" }]` with `default: "<user>"`, when the service's token is an administrator token (the group is enabled in it). Otherwise it returns today's answer: `selectable: false` and one entry. The existing `user` field of `POST /instances` carries the choice, so the dropdown and the CLI `--user` need no change. `Instance.user` shows the entry that the session runs as. The suffix is exactly ` (admin)`, with one space.

`checkUser` accepts only those two strings (and the bare service user as today). Any other value is a 400.

### Starting a restricted session

For the default entry on an administrator service, the node starts the process with a token that the service builds from its own:

1. `CreateRestrictedToken` with `LUA_TOKEN` and `DISABLE_MAX_PRIVILEGE`.
2. `SetTokenInformation` for the default DACL (the user and SYSTEM get `GENERIC_ALL`) and for the owner (the user). Without this, the child cannot open its own token and console programs fail with `0xC0000142`.
3. `SetTokenInformation` for the integrity level `S-1-16-8192` (Medium).
4. `CreateProcessAsUserW` with that token.

These calls use `bun:ffi` (the spike proved they work in a compiled Bun executable). They live in one module, `server/src/win/token.ts`. The child's output goes to the same instance log file as today. Stopping a session still uses `taskkill /T`.

For the `(admin)` entry, and for a standard service account, the node starts the process as today, with `Bun.spawn` and no token work.

### The state file

Each entry in `instances.json` gets an optional `admin: true`. An entry without it restores with the restricted token. This changes sessions that were saved before this release: on an administrator service they restart restricted. The README and the release notes say so.

### Errors

- A failure to build the token or to start the process is a 500 `failed to start claude: <reason>`, as for any start failure.
- If the token module cannot load (a missing DLL or a failed call), `GET /users` still lists the entries but the node logs the reason once, and a restricted start fails with the 500 above. The `(admin)` entry still works.

### Details settled after the builder check

- Every endpoint that takes `user` (`/fs`, `/fs/mkdir`, `/clone`, the GitHub routes and `POST /instances`) accepts both entries, through the same `checkUser`. Both entries are the same operating-system user, so file access, trust and git identity do not differ between them. Only the instance start looks at the `(admin)` suffix.
- The 428 "untrusted" answer returns the entry the person chose in its `user` field, so the retry with `addTrust` (in the web and in the CLI) keeps the choice. The trust file is still the service user's. The builder checks the CLI `--user` retry path as well and fixes it if it drops the suffix.
- `Instance.user` is set only when the dropdown has two entries. A standard service account leaves it unset, as today.
- A restricted session loses any access that only the Administrators group gave. A folder whose permissions grant access only through that group may not be readable or writable. This is the intended cost. The README says so.
- A failure to build the token is permanent for the life of the process. The instance goes to `failed` and the node stops retrying it. The node logs the cause once.

## Constraints

- Windows only. Bun, TypeScript, `bun:ffi`. No helper program and no new dependency.
- The token code runs in the CI Windows job, which has an administrator account. On Linux its tests skip. A pure function (building the user list, validating the entry) has tests that run everywhere.
- No change to how the node installs or to the service account.

## Calls made by the author

1. The choice rides in the existing `user` field with the suffix ` (admin)`. This keeps the dropdown, the CLI and the instance list unchanged and shows the choice in the list for free.
2. A saved session without `admin: true` restores restricted. It is a behavior change, accepted for safety.
3. A standard service account sees one entry and runs as today.
4. No fallback to the full token on error.

## Left to the builder

The names of the functions and types in `token.ts`, how a child's output reaches the log file (inheritable handles in `STARTUPINFO` or another way), how the node learns that a restricted child exited (polling `GetExitCodeProcess` or a wait), and the exact error text.

## Tests the builder must add

- User list: administrator service gives two entries with the default first. A standard service gives today's single entry. Any other `user` value is a 400.
- Token (Windows CI): a child started restricted reports Administrators deny-only, Medium integrity and one privilege, and can run `whoami /groups` (the default DACL step works). A child started with `(admin)` reports Administrators enabled and High integrity. A failure to build the token fails the start and starts nothing.
- State file: `admin: true` round-trips. An entry without it restores restricted.
- Instance list shows the entry.

## Real-machine check (the user does it)

Before a release, run a long-lived `claude remote-control` session restricted on KIRSTATION4 and confirm that the sign-in, the workspace trust and a remote prompt still work. The spike tested only `claude -p`.

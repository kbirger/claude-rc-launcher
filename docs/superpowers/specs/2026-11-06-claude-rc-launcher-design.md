# Claude Remote-Control Launcher — Design

## Intent
The user sometimes needs to reach a Claude session on a host where `claude remote-control`
isn't running, and today has to SSH in (from a phone) to start it. This tool is a small web
service on the host that starts/stops `claude remote-control` in a chosen directory, so it
can be done from a phone browser instead. The user has already proven the underlying
approach by hand with a systemd unit (see "Proven unit template"); this tool automates exactly that.

## Goals
- HTTP API to start `claude remote-control` in a given directory, list running instances, and stop them.
- Each instance is a **systemd service** matching the proven template.
- Simple Svelte UI: list of running instances with a Stop button each; a "New" button opening a
  directory drill-down with "create folder" and "start here".
- OIDC login (Authentik or any compliant provider).
- One port serves both UI and API. Plain HTTP only; designed to sit behind a reverse proxy.

## Non-goals
- TLS, rate limiting, multi-host management, a database, user management.
- Interacting with the Claude session itself (remote control in the Claude app does that).
- Editing/deleting files or directories beyond creating a folder.

## Anti-goals
- Becoming an arbitrary-command or arbitrary-filesystem remote shell. The API can only run one fixed
  command (with fixed flags) and can only touch paths under configured roots.
- Losing track of running instances if the launcher restarts.

## Technology (builder-chosen defaults — user can override)
- Backend: **Bun** + TypeScript + Hono. OIDC via `openid-client` or `jose` (verify the flow works on Bun early).
  Shipped as a single executable via `bun build --compile` with the built Svelte files embedded, so the host needs no JS runtime.
- Frontend: Svelte 5 + Vite, built to static files served by the same process.
- Process control: shell out (argv arrays, never a shell string) to `systemctl` / `journalctl`.
- Linux only (systemd).

## Proven unit template (user-supplied, known to work headless — no TTY needed)
```ini
[Unit]
Description=Claude Code Remote Control Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/srv/claude/projects/monitoring
Environment=HOME=/root
Environment=PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=SSH_AUTH_SOCK=/run/ssh-agent.sock
ExecStart=/root/.local/bin/claude remote-control --name myhost-monitoring --spawn same-dir --no-create-session-in-dir
StandardOutput=null
StandardError=journal
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```
The launcher renders this template per directory. Per-instance values: `WorkingDirectory`, `--name`, and a
marker comment (below). Host-wide values come from launcher config: `User`, `HOME`, `PATH`, optional `SSH_AUTH_SOCK`, claude binary path.

## Architecture
```
Browser ──HTTP──> reverse proxy ──HTTP──> launcher
                                           ├─ /api/*   (auth required)
                                           ├─ /auth/*  (OIDC login/callback/logout)
                                           └─ /*       (built Svelte SPA)
                                           │
                                           └─ systemctl ──> claude-rc-<id>.service ──> claude remote-control
```

### Instance model (no database)
- **Persistent unit files**, matching the proven setup (instances come back after reboot, `Restart=always`).
  This is the builder's call over transient units; it follows from the user's template being `WantedBy=multi-user.target`.
- Unit file: `<UNIT_DIR>/claude-rc-<id>.service`, `id` = first 12 hex of sha256(realpath of dir).
  One instance per directory; start is idempotent (already exists → 409 with the existing instance).
  First line of each generated file: `# managed-by: claude-rc-launcher path=<abs path>` — the launcher only ever lists/stops files carrying this marker and the `claude-rc-` prefix.
- Start: write unit file → `systemctl daemon-reload` → `systemctl enable --now claude-rc-<id>.service`.
- Stop: `systemctl disable --now` → delete unit file → `daemon-reload`. (Stop means "remove", so it doesn't restart on reboot.)
- List: scan `UNIT_DIR` for managed files; for each, `systemctl show -p ActiveState,SubState,ActiveEnterTimestamp`. Returns `id`, `path`, `name`, `state`, `startedAt`.
- `SYSTEMD_SCOPE=system|user` (default `system`, as the user's setup is). `user` scope uses `systemctl --user` and `~/.config/systemd/user` (needs linger).
- `--name`: defaults to `NAME_PREFIX` + directory basename (user's example `myhost-monitoring` suggests a host prefix like `myhost-`); optionally overridden by `name` in the start request. Validate `^[A-Za-z0-9._-]{1,64}$`.
- Fixed flags: `--spawn same-dir --no-create-session-in-dir` (from the proven unit); configurable via `CLAUDE_RC_ARGS` only by the operator, never by API callers.
- Unit-file rendering must be injection-safe: reject paths containing control characters or newlines; escape `%` as `%%`; quote ExecStart args per systemd rules. Covered by tests.
- `StandardOutput=null` as in the template, so there is no stdout to show; stderr goes to the journal.

## API (JSON, all under `/api`, all require a valid session)
| Method | Path | Behavior |
|---|---|---|
| GET | `/api/instances` | List managed instances |
| POST | `/api/instances` `{path, name?}` | Validate path, render unit, enable+start. 201 / 409 if exists |
| DELETE | `/api/instances/:id` | Stop, disable, remove. 204 |
| GET | `/api/instances/:id/logs?lines=100` | Recent journal (stderr) lines. Secondary feature |
| GET | `/api/fs?path=` | List subdirectories (no files) of `path`; omit `path` to list configured roots |
| POST | `/api/fs/mkdir` `{parent, name}` | Create one directory; `name` is a single segment: no `/`, `..`, leading `.` |
| GET | `/api/me` | Current user |
| GET | `/healthz` | Unauthenticated liveness |

Errors: `{error: string}` with appropriate 4xx/5xx. `id` is validated against `^[0-9a-f]{12}$`.

## Filesystem safety
- `ROOTS` config (default: the configured service user's home). Paths are resolved with `realpath`
  and must be inside a root *after* symlink resolution, else 403.
- Browse/mkdir/start all go through one `resolveWithinRoots()` function, unit-tested with `..`, symlink escape,
  and sibling-prefix cases (`/home/kir` vs `/home/kir2`).
- Hidden directories not listed by default.

## Privilege note
The proven setup runs Claude as root, so the launcher must be able to write to `/etc/systemd/system` (it will typically run as root).
That makes the OIDC provider's access bindings and the filesystem roots the only barriers between a login and root-level command execution. README must say this plainly (restrict the application in the provider to the intended users),
and recommend a dedicated non-root service user (`User=` in the template) where possible.

## Authentication
- OIDC authorization-code flow with PKCE, discovery via `OIDC_ISSUER`.
- Config: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `PUBLIC_URL` (redirect URI = `PUBLIC_URL/auth/callback`), `SESSION_SECRET`.
- Authorization is delegated entirely to the OIDC provider (user decision): anyone who completes login is allowed. Access is controlled by the provider's application bindings/policies (e.g. Authentik), not by the launcher. No allow-list in the launcher.
- Session: signed/encrypted HttpOnly SameSite=Lax cookie, `Secure` when `PUBLIC_URL` is https, default 12h expiry.
- CSRF: state-changing endpoints require `Content-Type: application/json`; reject when `Origin` is present and doesn't match `PUBLIC_URL`.
- `TRUST_PROXY=true` honours `X-Forwarded-*`.
- Unauthenticated browser requests to `/` redirect to `/auth/login`; unauthenticated `/api` returns 401.

## UI (Svelte, mobile-first — primary use is a phone)
- **Main screen:** header with user + logout; instance list (name, directory, state, uptime) each with **Stop** (confirm on tap); **New** button; polls `/api/instances` every ~5s; empty state.
- **New dialog (full-screen on mobile):** breadcrumb, subdirectory list (tap to drill in, up/back), **New folder** (inline name input), **Start here**; optional name field. Inline errors (already exists, outside roots).
- Optional "Logs" view per instance.
- Plain responsive CSS, respects dark mode.

## Configuration summary (env vars)
`PORT` (8080), `HOST` (0.0.0.0), `PUBLIC_URL`, `ROOTS`, `SYSTEMD_SCOPE`, `UNIT_DIR`, `SERVICE_USER`, `SERVICE_HOME`, `SERVICE_PATH`,
`SSH_AUTH_SOCK` (optional; if set, emitted as `Environment=SSH_AUTH_SOCK=...` in every unit, else omitted), `CLAUDE_BIN`, `NAME_PREFIX`, `OIDC_*`, `SESSION_SECRET`, `TRUST_PROXY`.

## Deliverables
- Repo layout: `server/`, `web/`, root scripts `build` (web build then `bun build --compile`), `dev`, `test`.
- `deploy/claude-rc-launcher.service` unit for the launcher itself + README: Authentik provider setup (redirect URI, scopes `openid email profile`, and binding the application to the intended users/groups), reverse-proxy snippet (nginx/Traefik), env file, privilege note.
- Tests: path resolution; unit rendering (injection cases); systemd wrapper against an injectable fake command runner; API tests with auth stubbed. Final manual check on a real Linux host.

## Left to the builder
- OIDC/session library choice, UI styling, polling vs SSE, hidden-directory toggle.
- Handling of failed units (show `failed` state; Stop still removes them).

# Permissions: audit, edit, and fix blocked tool calls

Date: 2026-11-14. Status: draft, waiting for approval. Related notes: the spike results in the project memory `permissions-spike-results`.

## Intent

The user runs Claude Code sessions from a phone. A tool call that needs approval stalls the session, and nobody can answer the prompt in a terminal. The user wants to do three things in the web app:

1. See the permission rules that apply to a session, and which file each rule comes from.
2. Add, change, and remove those rules.
3. See the tool calls that were blocked recently, add a rule for one with one tap, and make the running session try again.

## Goals

- Show the rules of three files for one session: the user file `~/.claude/settings.json`, the shared project file `.claude/settings.json`, and the local project file `.claude/settings.local.json`. If the node can read a managed file, show it as read-only.
- Show the user file once for each instance (one Claude home), not once for each session.
- Edit `permissions.allow`, `permissions.ask`, and `permissions.deny` in the three writable files.
- List recent blocked tool calls from the session transcripts. Show the reason with each call if it is known.
- Turn a blocked call into a suggested rule. The user can edit the rule text before it is saved.
- After a rule is saved, offer to tell the running session to try again.

## Non-goals

- Other settings keys, such as `defaultMode`, hooks, and environment variables.
- Writing managed settings.
- Committing the shared project file. The node changes the file in the working tree and the user commits it.
- A full copy of the Claude Code rule matcher. The tool shows exact and simple prefix matches only, and says so.
- The Windows node in the first release (see Phase 3).

## Anti-goals

Each of these makes the feature a failure, whether or not the rest works.

- The node must never run a blocked action itself. That bypasses the permission system.
- The node must never add a rule without a user tap and a confirmation that shows the exact file and rule.
- The messaging token (`peerToken`) must never leave the node process or reach a log, an API answer, or the web app.
- A bad write must never leave a settings file broken or owned by the wrong user.

## What the spike proved

On 2026-11-14 a throwaway `claude -p` session in default permission mode had a `touch` command denied. The script wrote `permissions.allow: ["Bash(touch *)"]` to `.claude/settings.local.json`, then posted a message to the session inbox socket. The same running session tried again and the command ran, with no restart. So:

- Claude Code reloads permission edits in a running session (the documentation says the same).
- A message on the inbox socket starts a new turn in an idle session. The wire format is an optional auth line, then `{"type":"user","message":{"role":"user","content":"..."}}`. On Linux the auth line is optional, so the node does not need the token.
- The denial text for a call that needs approval is in the transcript as a `tool_result` with `is_error: true`.

Not proven: whether an allow rule clears a denial made by the auto mode classifier. The first task of Phase 2 is to test it.

## Approaches considered

1. Read first, then edit, then nudge, as three releases. Safe, but the part the user cares most about comes last.
2. Spike the two unknowns, then build in the same three phases. The user chose this one. The spike is done.
3. Build everything as one piece. Rejected: a wrong guess is found late.

The user chose approach 2.

## Constraints from the code and from Claude Code

- The hub proxies to nodes. Files live on the node, so the node reads and writes them. The hub adds routes next to the existing session routes in `server/src/hosts.ts` (`forwardJson`).
- The node can run as a service account while the files belong to the instance user. The write follows `server/src/trust.ts`: open without following symlinks, refuse hard links and non-regular files, cap the size, write a temp file, rename it, keep the mode, set the owner. Move the safe read and write code from `trust.ts` into a shared module instead of copying it.
- Claude Code also writes these files. Just before it writes, the editor reads the file again. The read returns a hash. If the hash differs from the hash the user loaded, the editor refuses with a conflict.
- Settings files are strict JSON. The writer keeps unknown keys and the key order, and keeps the indent it finds (default two spaces).
- Rule precedence is deny, then ask, then allow, and the first match wins. A lower scope cannot undo a deny. Lists merge across files. The UI marks an allow rule that a deny or ask rule overrides.
- Allow rules in the shared project file apply only after the folder is trusted. The trust code in `trust.ts` tells whether it is. If the folder is not trusted, the UI warns the user.
- Claude Code puts the local file at the git root since v2.1.211, and reads the shared file from the session start folder. The node computes both paths and the UI shows the exact path before any write. It also reads a local file that an older version left in the start folder and marks it read-only. In a git worktree, or if the root is unclear, the node refuses to write the local file. It says why.
- `defaultMode: auto` and `bypassPermissions` have no effect from project files. The editor does not touch `defaultMode`.

## Design

### Parts (suggested file names, builder may change them)

- `server/src/settingsfile.ts`: safe read and write of one settings file, with the hash check. Shared with `trust.ts`.
- `server/src/permrules.ts`: parse a rule string `Tool(specifier)`, format it, suggest a rule from a tool call, find duplicates and shadowing.
- `server/src/blocked.ts`: scan transcripts for blocked calls. It follows `touched.ts`: stream the lines, parse only lines with `tool_use` or `tool_result`, pair by id, fail closed.
- `server/src/nudge.ts` (Phase 3): find the live session socket and post one message.
- `server/src/permissionsapi.ts`: node routes. Hub proxy routes in `hosts.ts`.
- `web/src/lib/features/permissions`: queries, the instance page, and the session tabs.

### Node API

- `GET /instances/:id/permissions`: the user file for that instance (rules, path, hash, status).
- `GET /instances/:id/sessions/:sid/permissions`: all layers for the session, merged view with the source of each rule.
- `GET /instances/:id/sessions/:sid/blocked`: blocked calls, newest first.
- `POST` and `DELETE` on a rule route (Phase 2). The body names the scope, the list, the rule, the expected hash, and for a nudge the flag `nudge`. A conflict gives 409.

### Blocked calls

A blocked call is a `tool_use` paired with a later `tool_result` that has `is_error: true` and a known denial text. A command that failed on its own (exit code 1) also has `is_error: true`. So the scan matches denial text. It does not take every error. Reasons:

- `needs_approval`: the call needed a prompt and nobody answered. A rule fixes it.
- `user_rejected`: the user said no. Shown, but the add-rule button asks for an extra confirmation.
- `classifier`: the auto mode classifier denied it. The button shows a warning until the Phase 2 test says whether a rule helps.
- `deny_rule`: a deny rule matched. No allow rule helps. The UI shows the deny rule and its file instead of an add button.
- `safety_check`: a built-in guard (for example `rm -rf`). No button.

The denial texts are Claude Code internals and can change with a version. The builder first samples real transcripts on this machine (the notes list about 366) to build the text catalog. An unknown text is not shown (a lower bound, like the touched list). A fixture file of real samples keeps the catalog honest.

A denial older than the modification time of a file that now has a matching rule is shown as "probably fixed", not hidden.

### Suggested rules

- Bash: the user picks between the exact command and a prefix with `*` (for example `Bash(git log *)`). A compound command is split into its parts and each part gets its own suggestion. The UI shows what else the wildcard will allow.
- Edit, Write, and Read: a path rule.
- WebFetch: `WebFetch(domain:<host>)`.
- MCP tools: the full tool name. Other tools: the bare tool name.
- The rule text is editable before it is saved.

### Confirmation and audit

Every write shows the file path, the list, and the exact rule first. A write to the user file adds a warning that it applies to every project of that user. A write to the shared project file adds a warning that it changes a tracked file. The node writes one log line for each change: the hub user, the instance, the file, the action, and the rule. The log line does not contain the file content.

### Nudge (Phase 3)

- After a save, the checkbox "Tell the session to try again" is on by default if the session is live.
- The message is a fixed template that names the rule and the file. It never contains the blocked command text, so a command that Claude wrote earlier cannot become an instruction.
- The node finds the socket from `<home>/.claude/sessions/<pid>.json` (`messagingSocketPath`) after the existing pid checks in `livesessions.ts`. Before it connects, it checks that the path is a real socket (lstat, no symlink) that the instance user owns. The user controls the session file, so without this check a user can point a privileged node at a socket such as the Docker socket. The connection runs as the instance user, using the existing `asuser.ts` pattern when the node is privileged.
- The socket path stays in the node. It does not reach the web, as `bridgeId` and the token do not today.
- The node sends no auth line on Linux, so it never opens the `.key` file.
- The UI says "sent", never "received". A session that bypasses permissions holds an outside message for approval, and the node cannot see that.
- If the session is not live or the socket check fails, the rule is still saved and the UI says the session was not told.

## Interface

Mobile first, with the existing shadcn and Bits UI parts.

```
Instance page: Permissions            Session screen
  User file  ~/.claude/settings.json    [Files] [Permissions] [Blocked 3]
  Allow (12)   Ask (0)   Deny (2)       Blocked
  Bash(git log *)             [x]       Bash  rm -rf build/        needs approval
  ...                                    [Allow...]  [Details]
  [Add rule]                            Edit  src/app.ts           classifier
```

The session Permissions tab lists the merged rules, grouped by file, with a mark on a rule that another rule overrides.

## Phases

1. Read-only. Shared settings reader, rule parser, layers API, blocked scan, instance page, and session tabs. Ships on its own.
2. Edit. Safe writer, conflict check, rule editor, add-rule from a blocked call, confirmation, audit log. First task: test auto mode with an allow rule.
3. Nudge. Linux node. The Windows named pipe, which needs the token, comes later and needs its own decision about reading the `.key` file.

## Testing

- Unit tests with the existing fake filesystem pattern: the writer (symlink, hard link, size, owner, conflict), the rule parser, and the blocked scan against fixture transcripts that include real samples.
- A nudge test with a fake Unix socket server, including the refusal cases (symlink, wrong owner, not a socket).
- A manual check that reuses the spike script against a real `claude -p` session before each release of Phase 2 and Phase 3.

## Left to the builder

The exact file names, the rule matcher scope for the "already allowed" mark, the worktree path rules, how the blocked list pages, and the visual details.

## My calls (the user has not confirmed these)

- The user file is shown at the instance level, because one node can host several users and each has its own Claude home. The user said "per node".
- Local project file edits go to the git root, to match Claude Code.
- A blocked call that a deny rule caused has no add button.
- The nudge message is a fixed template without the blocked command text.
- The Windows node waits for a later phase.

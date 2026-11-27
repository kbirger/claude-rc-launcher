# Permissions: deferred minor findings

Date: 2026-11-14. These came from the task reviews and the final review of Phase 1 and Phase 2 (branch `feat/permissions`). None blocks a release. Each line says where to look. Review the list before Phase 3 and before the next release.

## Release notes (say these to the user)

- Adding or removing a rule rewrites the whole settings file with `JSON.stringify`. Short inline arrays become one item per line. Numbers like `1.0` and `1e2` become `1` and `100`. Escapes such as `\/` are decoded. CRLF becomes LF. Duplicate keys collapse to the last one. A trailing newline is added.
- On a root node, a trust add now fails with a 500 for a service user that exists only in LDAP or sssd. Such a user is not in `/etc/passwd`. Before, the node wrote `.claude.json` as root, and the service user had no read access to it. The 500 text ("the owner of the file is not known") does not name the cause (`server/src/instances/trust.ts`).
- On a root node, the node now checks the owner of each settings file of the default user at each read. A root-owned committed `.claude/settings.json` reads as refused. Git for the Changed list now runs as the service user (`server/src/instances/InstanceService.ts`, `claudeHome`).

## Not verified by any test or run

- The real `claude -p` loop with the node route. The Phase 3 check ran against a fake socket server, not a real session. The real loop was checked earlier by the spike script, which wrote the file and the socket message itself.
- The web UI against a live node, and the blocked route over HTTP with a real denial.
- Whether an allow rule clears an auto mode classifier denial. The spike never got a denial, so the warning stays (spec, "What the spike proved").
- A DELETE request with a JSON body through the real reverse proxy in front of the hub.
- Whether a session in bypass mode holds an inbox message for approval (Phase 3).

## Server

- `safefile.ts` `writeUserFile`: an error from `fh.close()` can hide the first error. A dangling symlink is replaced by a regular file instead of creating the target. An existing file gets the group of its folder on a root node, not its own group.
- `trust.ts` could pass `expectedHash` to stop lost updates against Claude Code's own writes to `.claude.json`. The lstat-then-open gap on `.claude.json` is still there.
- `sessions/SettingsFile.ts` `makeFolder`: if the folder step works and `writeUserFile` then refuses, the new empty `.claude` folder stays (it belongs to the user). The `/proc/self/fd` check runs on Linux only. A parent folder swapped for a symlink between the check and the rename is an accepted gap (Node has no `renameat`).
- `checkRule` also runs on remove, so a malformed rule already in a file cannot be removed (the rule list hides such rules). A bad rule on a managed file gives 400 before 403. `detectIndent` can return more than 10 spaces, and `JSON.stringify` clamps that to 10.
- A DELETE with `expectedHash: null` always gets 409.
- The failed-request audit line holds the raw rule up to the body cap. `JSON.stringify` does not escape U+2028 and U+2029.
- `hosts/api/forward.ts`: the hub log status folds any 2xx other than 200, and any 3xx, into 502. The hub imports `parseRuleEdit` from `sessions/requests.ts` now, no longer from the permission routes. No test sets a real hub user for the hub audit line.
- The blocked scan reads the whole transcript on every request with no cache. No tsc run for the server (it has no tsconfig).
- A 5-scope node route accepts managed and legacy-local and answers 403. The plan said the session routes accept three scopes.

## Web

- `suggest.ts`: heredoc bodies split on newline into extra parts. A tab gives no suggestion. A subshell or brace group after `&&` or `;` is still split badly. The no-prefix list is fixed, so a wrapper that is not on it still gets a prefix rule. `docker exec *`, `docker run *`, `kubectl exec *`, `bun run *`, and `npm run *` get a prefix rule on purpose and carry the "broad" label. `MultiEdit` is a file tool in `format.ts` but not in `suggest.ts`, and the two files read `file_path` and `notebook_path` in a different order.
- `format.ts` `probablyFixed` and `deniedBy`: over-match when the command has `$(` or a backtick (a hint only, the Allow button stays). `probablyFixed` ignores time. The spec asks for a mark only when the rule is newer than the denial.
- `RuleSheet.svelte`: it trims the rule, so a rule with spaces at its edges cannot be removed. The "file changed" text stays after the refetch, and Save works again against the new hash. The error text is not cleared when the user edits. The confirm line is not an `aria-live` region. The remove sheet keeps a snapshot of the layer taken at the tap (it fails safe through the hash check). While the layers load, a `deny_rule` row briefly says "a deny rule".
- Cosmetic: the Remove button in a rule row is plain. The section switch (Files and Permissions) shows the active section only by a light grey background. No docs page describes the screens.
- The trust warning for allow rules in the shared project file is not shown (`PinnedRoot` has no trust call). The sheet shows only the "git tracks this file" warning.

## Phase 1 items still open

- The `deny_rule` and `user_rejected` denial texts come from the binary strings, not from a transcript. `bun scripts/sample-denials.ts` checks them again.
- No real-hub run with a login. The UI was checked with Playwright route mocks.

## Phase 3 (the nudge): left open on purpose

- The Windows named pipe is not built. It needs the peer token from the `.key` file. We must decide first whether the node may read that file. On Windows the nudge answers `unsupported`.
- A busy session: no test covers what happens when the session is busy while the nudge arrives.
- A remove does not send a nudge. This is on purpose, because a removed rule does not unblock anything. A remove with `nudge` now gives 400 on the node and on the hub.
- The live check on 2026-11-14 used a fake socket server, not a real `claude` session. The throwaway home had no credentials and we did not copy any. The node sent one line, the fake session got it, and the rule was in the file. Two refusal checks gave `socket_refused` with no connect: a symlink to a real socket, and a socket owned by another uid. The real `claude` loop through the node route, including a Remote Control session, is still to run before release.

## Phase 3: review minors from Tasks 1 to 4

- `findSessionSocket` builds a full `LiveInfo` for every live session, with the `/proc` `firstSession` reads. Add a `sessionId` filter to `liveEntries` so it reads one session only.
- `checkSocket` refuses a path that is not canonical. A socket under a folder that is a symlink is refused, even when the user owns it.
- No test covers a reused pid for `findSessionSocket`.
- The audit `nudge` reason is not passed through `known()`. Today the reason comes from a fixed set, so this is safe, but the code does not show it.
- When the node runs from source, the as-user send cannot work. `process.execPath` is `bun` then, so the child cannot start the packaged `nudge-send` entry.
- The kill test child runs `sh -c sleep`. Use `exec sleep` so the kill reaches the sleep itself.
- The sheet reads the default value of the nudge once, at mount. A later change of the default does not show.
- Focus and aria handling after the result shows: focus does not move to the result, and the result is not an `aria-live` region.
- No test at the `SessionView` level covers the `live` prop.

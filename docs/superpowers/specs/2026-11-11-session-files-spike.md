# Session files spike: findings

Date: 2026-11-11. Claude Code 2.1.322 on Linux. Script: `scripts/spike-sessions.ts`. Run: `bun scripts/spike-sessions.ts /root/git/claude-rc-launcher /root`.

## Summary

The plan layout mostly holds. Two things differ from the plan. First, a session that runs in a work tree files its transcript under the work tree folder, not under the instance folder. Second, no record marks a session as a Remote Control session with certainty. There is a strong hint that the plan can use. The details follow.

## Confirmed layout

- Transcripts live at `<home>/.claude/projects/<folder name>/<session uuid>.jsonl`.
- The folder name is the working folder path with every character that is not a letter or digit replaced by `-`. For `/root/git/claude-rc-launcher` it is `-root-git-claude-rc-launcher`. The Claude Code documentation states this rule for the scratchpad folder and shows the same pattern for `projects/<project>`.
- The spike found 22 transcripts for this repository. This session is one of them (`35ae53af...`), with branch `feat/session-files`.
- Each line is one JSON record. Records of type `user`, `assistant`, `system` and `attachment` carry `sessionId`, `cwd`, `gitBranch` and `entrypoint`. Other record types (`permission-mode`, `bridge-session`, `api-request-blob`, and more) do not carry `cwd`.
- The first `cwd` was the instance folder in all 22 transcripts. Good: first `cwd` is a usable session root.
- The last `cwd` is not the root. In 10 of the 22 transcripts here the `cwd` changed because Claude ran `cd`. Across all projects on this machine, 28 transcripts show drift. The plan must use the first `cwd` only.
- `gitBranch` can change during a session. The script prints the last one seen.
- Transcripts are large. The biggest here is several MB because of `api-request-blob` records. The reader must stream lines and must skip bad lines.
- Subagent transcripts are in `<session uuid>/subagents/agent-*.jsonl`. They are separate files with the same format. The plan must decide whether files touched by subagents count. The spike did not read them.
- Claude Code deletes transcripts older than `cleanupPeriodDays` (default 30 days).

## (a) Which tools write files

Tool calls are `tool_use` blocks inside `message.content` of `assistant` records. The tool name is `name`. The arguments are in `input`.

| Tool | Path field | Seen in these transcripts |
| --- | --- | --- |
| `Write` | `input.file_path` | yes |
| `Edit` | `input.file_path` | yes |
| `NotebookEdit` | `input.notebook_path` | no (the documentation lists it as a file editing tool) |
| `MultiEdit` | `input.file_path` | no (not in current tool lists, kept for old transcripts) |

Things the plan must handle:

- Paths are absolute in nearly all cases. One was `/root/git/claude-rc-launcher/../medium-post-claude-rc-launcher.md`. The reader must normalize `..`.
- Some paths are outside the instance folder, for example under `~/.claude/projects/.../memory/`. The plan must decide whether to list them. The design should only serve files under the session root or an allowed root.
- Files that Claude creates with the `Bash` tool (redirects, `cp`, `mv`, `sed -i`) do not show up. Bash is the most used tool by far (5545 calls on this machine against 351 `Write` and 523 `Edit`). Here 8 of 22 sessions used no `Write` or `Edit` at all. The list of touched files is therefore a lower bound. The user interface should say so or the plan should accept it.
- A tool call might have failed. The `tool_use` record alone does not say. The matching `tool_result` is in the next `user` record. The spike did not check it. The server should check that the file still exists anyway.

## (b) Remote Control session or terminal session

There is no record that says "Remote Control spawned this session". These signals exist:

1. `entrypoint` on each record. Sessions that Remote Control spawned have `entrypoint` = `sdk-cli`. Sessions typed in a terminal have `entrypoint` = `cli`. Here: 19 transcripts are `sdk-cli` and 3 are `cli`. Caveat: any program that drives Claude Code through the Agent SDK also gives `sdk-cli`, so this is a hint and not proof.
2. User records carry `promptSource`. It is `sdk` and `clientPlatform` is `android` or `desktop_app` for prompts that came from the phone or the web app. It is `typed` in a terminal session. Same caveat.
3. A `bridge-session` record (with `bridgeSessionId` starting with `cse_`) appears in 2 transcripts. Both have `entrypoint` = `cli`. These are terminal sessions where the user turned Remote Control on, not sessions spawned by `claude remote-control`. The 19 `sdk-cli` transcripts have no `bridge-session` record. So this record does not mark a spawned session. It marks a terminal session that is attached to Remote Control.
4. The `remoteSourced: true` flag is on records of one of those two terminal sessions only. It is not on the spawned sessions.
5. `<home>/.claude/sessions/<pid>.json` has one file for each running session. It holds `sessionId`, `cwd`, `entrypoint`, `kind`, `name` and `bridgeSessionId` (set for all 7 live sessions here, all `sdk-cli`). This is the best signal, but it only covers sessions that are running now. The file is removed when the session exits.
6. `claude remote-control --continue` uses `<home>/.claude/projects/<folder name>/bridge-pointer.json`. It holds one cloud `sessionId` (`session_...`), an `environmentId`, `source`, `pid` and `procStart`. It exists for only some folders (4 here, not for this repository). It holds one entry per folder and the id is the cloud id, not the transcript uuid. It cannot list sessions and it cannot be matched to a transcript file. It is not useful for this feature.

Result for the plan: no reliable marker exists in a transcript. A good rule is: list a transcript when its first record with `entrypoint` has `sdk-cli`. Fall back to listing every session in the folder if the user prefers certainty over noise. The spec already allows the fallback. This rule is a guess to confirm with the user at the gate.

## (c) Where a work tree session lands

I created a work tree at `/tmp/spike-wt-session-files` with `git worktree add` and removed it again with `git worktree remove`. I did not start Claude in it. No transcript for a work tree existed on this machine, so this result comes from the naming rule and from the Claude Code documentation, and is not proven by a real transcript.

- The folder name for that work tree would be `-tmp-spike-wt-session-files`. This is not under the instance folder name.
- The documentation says `claude --worktree <name>` creates `<repo>/.claude/worktrees/<name>`. That folder name would be `-root-git-claude-rc-launcher--claude-worktrees-<name>`. Note the double dash: `/` and `.` each become `-`.
- With `--spawn worktree`, Remote Control starts each on-demand session in its own work tree. Those transcripts land in the work tree folder, not the instance folder. The pre-created session stays in the instance folder.
- The documentation also says that when Claude enters or leaves a work tree (the `EnterWorktree` tool or `/cd`), the transcript follows. Claude Code records the session under the new working directory. So one session can move folders.

This contradicts the plan. Listing only `<instance folder name>` would miss all work tree sessions. The plan must also scan sibling folders whose name starts with `<instance folder name>--claude-worktrees-`, and then check the first `cwd` of each transcript. A work tree made by hand with `git worktree add` outside the repository has an unrelated folder name, so only the first `cwd` and `git worktree list` can link it back.

Also note the folder name rule is lossy. `/a/b-c` and `/a/b/c` give the same name. The reader should verify the first `cwd` against the instance folder after it finds a transcript. Claude Code may also shorten very long names, but I did not verify that here.

## (d) Windows location

Source: Claude Code documentation, "Explore the .claude directory". On Windows `~/.claude` is `%USERPROFILE%\.claude`. If the `CLAUDE_CONFIG_DIR` variable is set, everything lives under that folder instead. So transcripts are in `%USERPROFILE%\.claude\projects\<folder name>\<session uuid>.jsonl`.

The documentation states the folder name rule (every character other than letters and digits becomes `-`) for the scratchpad path. It does not spell out an example for a Windows drive path in `projects/`. By the rule, `C:\Users\me\proj` becomes `C--Users-me-proj`. This is unverified on a real Windows node. Check it on a Windows node before relying on it. The plan should also honour `CLAUDE_CONFIG_DIR` on every platform. On Linux the same variable applies, so the plan should read it from the node environment if the node can see it.

## Things to carry into later tasks

1. Scan the instance folder and the `--claude-worktrees-` sibling folders. Verify each transcript by its first `cwd`.
2. Use the first `cwd` as the session root. Never use the last one.
3. Read `Write.file_path`, `Edit.file_path`, `NotebookEdit.notebook_path`, and old `MultiEdit.file_path`. Normalize and check each path against the allowed root. Say that Bash writes are not listed.
4. Stream the file. Skip bad lines. Ignore record types that have no `message`.
5. The Remote Control filter is a heuristic (`entrypoint` = `sdk-cli`). Confirm with the user.
6. On Windows, use `%USERPROFILE%\.claude` or `CLAUDE_CONFIG_DIR`. Confirm on a real node.

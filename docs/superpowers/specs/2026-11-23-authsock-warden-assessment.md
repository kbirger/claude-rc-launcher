# authsock-warden: why it does not fit

Date: 2026-11-23. Status: final for this decision.

This note belongs to the [SSH delegation design](2026-11-23-ssh-delegation-design.md). It explains why the design does not build on authsock-warden.

## Summary

authsock-warden does not fit, for two separate reasons. First, the shipped build does not enforce the main feature that the first plan relied on, the list of allowed processes. Second, even a complete tool does not match our need. It holds keys on the machine where it runs, and it identifies callers by process name. We need keys that stay on the hub and grants that the hub can end at any time.

## Source and method

- Repository: https://github.com/kawaz/authsock-warden, branch `main`, commit `6eca45312f66`, committed 2026-09-19. Read on 2026-11-23.
- The README and `docs/design.md` were read through a reading agent. `docs/design.md` is in Japanese, so the agent translated it.
- The Rust source files named below were downloaded and searched by the author of this note. Those findings are marked "verified".
- Findings marked "reported" come from the reading agent and were not read again by the author.
- Nobody ran the tool. The upstream project can change after this date.

## What the first plan needed

The first plan needed six things from the tool. It needed a separate socket for each session. It needed a limit on which processes can use a socket. It needed a lifetime for each key. It needed an approval step that an application controls. It needed a change of configuration without a restart. It needed a way to take a key back from outside.

## Findings

| Need | What the documents say | What the source shows |
|---|---|---|
| A limit on which processes can use a socket | Each socket has an `allowed_processes` list. | The list is parsed from the configuration but never passed to the proxy. The only place that builds a socket from command-line arguments sets `allowed_processes: vec![]` (`src/cli/commands/run.rs:330`). The function that applies the list, `check_sign_request` in `src/policy/engine.rs`, is called only by its own tests. Verified. |
| The limit applies to each request | The design applies the limit in the sign request. | When a client connects, the proxy reads the caller PID once (`src/agent/proxy.rs:77` and `src/agent/warden_proxy.rs:152`). Later requests on the same connection reuse that snapshot. Verified. |
| A caller is identified with certainty | The tool uses `SO_PEERCRED` and the `/proc` tree. | The match is on the basename of `/proc/PID/exe`. If the tool cannot read that link, it falls back to `/proc/PID/comm`. If it cannot read the caller PID at all, the policy code allows the request (`src/policy/engine.rs:116`). Verified. |
| An approval step under our control | `[auth]` with `method = "command"`. Exit code 0 means approved. | No code in the files that handle requests starts an external command. The TODO list shows the re-authentication step as not done. Verified. |
| A lifetime for each key | A per-key `timeout`, then `lock` or `forget`. | `docs/TODO.md` lists "per-key timeout + lock/forget lifecycle" as not done, and the link to the `run` command as not done. Verified. |
| A change of configuration without a restart | Not stated. | `docs/TODO.md` lists reload on `SIGHUP` as not done. The `run` command handles only the shutdown signals. Verified for the TODO entry, reported for the signal handling. |
| A way to take a key back from outside | Not stated. | No control socket, signal or subcommand for lock, forget or revoke. The TODO list shows the `refresh`, `status` and `keys` commands as not done. Reported, with the TODO entry verified. |

## Reasons that remain if the tool were complete

1. The tool does not sign remotely. It signs with keys that it holds, or it forwards to another agent. Our design needs the key to stay on the hub. If the tool runs on a node, the key sits on the node. A root session can read it there.
2. A process name is a filter, not proof of identity. A process can copy a program under an allowed name. A command that an allowed program starts also passes, because the match covers the whole chain of parents. The `ProxyCommand` of `ssh` is one example.
3. The tool gives root no special treatment, and root can read the memory of any process. Sessions run as root by default, so a process filter protects little against them.
4. When the connection opens, the tool identifies the caller. A connection that an allowed process opened can pass to another process, for example by inheritance of the file descriptor. The tool does not look again.
5. A sign request does not name the target host. No agent filter can tie a key to one host. Our design solves this with one key for each target.
6. Our grants need state on the hub: approval, an end time and revoke. A tool that reads its configuration once at start cannot follow that state. Each grant needs a restart or a new process.
7. The project is young. The first release is from 2026, the version is 0.1.x, it has one author and one star, and macOS is the main target. It has no written threat model.

## What it is good for

A person can put it in front of a personal agent on a workstation, to hide some keys from some programs. That is a different job from ours.

## What the design uses instead

A small agent of our own on each node. It answers only two requests, list identities and sign, and it sends every sign request to the hub. The hub holds the key and signs only while an approved grant is active. Protection comes from three facts: no key is on the node, a grant limits what the hub signs, and the socket is open only for the length of the grant.

## When to look again

Upstream must do four things before we look at the tool again:

- Enforce `allowed_processes` on every request.
- Run an approval command.
- Reload its configuration.
- Add a control path and a threat model.

Even then it adds only a filter in front of an agent. It does not replace the hub signing.

# SSH access on a Windows node: design note

Date: 2026-11-25. Status: draft, waiting for approval.

## Goal

A session on a Windows node asks for SSH access. The owner approves on the phone. The session then runs `ssh.exe` with the file that the node wrote. This works on a Linux node today. This note says how the Windows node does the same.

## What the spikes showed

All spikes ran on KIRSTATION4 with Win32-OpenSSH 9.5p2 and Bun 1.4.4. Each used a throwaway SSH server on 127.0.0.1 and a temporary folder. No real state was touched.

### Agent transport: a named pipe works

- `ssh-add -l` and `ssh.exe` talk to an agent on a Windows named pipe. Bun serves it with `node:net` and `listen("\\\\.\\pipe\\name")`.
- The existing `sshagentproto.ts` runs unchanged. A real login signed five times, and the server checked each signature.
- `Bun.listen` with `unix` works on Windows, but `ssh-add` fails with `Error connecting to agent` on a Unix socket path. So a Unix socket is not an option.
- The Windows `ssh-agent` service owns the pipe `openssh-ssh-agent`. Our pipe names never use that name.
- When the agent stops, the pipe disappears and `ssh` fails.

### Paths in the config file: write forward slashes

- The line `IdentityAgent \\.\pipe\name` is silently ignored. A quoted form with doubled backslashes works. The form `//./pipe/name` also works.
- The failure is quiet. `ssh` then loads the `.pub` file as a private key and prints `invalid format`. This message hides the real cause.
- Decision: write every path in the config with forward slashes and double quotes where a path holds a space. Both worked with a path that holds spaces.
- `StrictHostKeyChecking yes` works. A wrong pinned host key fails with exit 255. An empty `known_hosts` file also fails.
- `IdentitiesOnly yes` works. A decoy default key in a fake profile was not offered. This used a changed `USERPROFILE`, so the real profile is not proven.
- `GlobalKnownHostsFile` works with `/dev/null` and with `NUL`. The Linux value `/dev/null` is fine.

### Control channel: what a pipe gives and does not give

- The default access list of a `node:net` pipe is full control for the owner, SYSTEM and Administrators. Everyone and Anonymous get read only.
- A client that needs to write, which is every client of ours, is refused for any other normal user. This is read from the access list. It is not tested with a second account. The machine has one user and the session has no admin rights.
- A pipe name is not a secret. Every process can list `\\.\pipe\`.
- Bun gives no handle for the pipe. We cannot ask Windows who the caller is without custom code through `bun:ffi`.

## Threat model

Two threats matter.

1. Another Windows user on the machine. The access list stops it. Administrators can read everything anyway, as root can on Linux.
2. Another instance on the same node. Instance A must not use the grant of instance B.

On Linux, each instance runs as its own user, so the operating system separates them. On Windows, the node runs every instance as one user. That user can read the environment and memory of any instance process. So Windows cannot stop a hostile session from attacking a sibling session. It can stop a session that is confused or that copies the wrong path. This is a real limit. The owner must accept it.

## Design

### Transport

- One named pipe per grant for the agent. The pipe name is `claude-rc-ssh-agent-<random 128 bits>`. The agent code keeps its interface. Only the listen step changes.
- One named pipe for the control channel of each instance.

### Control channel and identity

- Each instance gets a random token and a pipe name in its environment variable `CLAUDE_RC_SSH_CONTROL`. The node keeps a map from token to instance.
- The CLI connects to the pipe and sends the token first. The node closes a connection with an unknown token.
- Every control request uses the instance that the token names. A token never names another instance.
- This stops a session that uses the wrong variable. It does not stop a hostile session of the same user that reads another process.
- Agent pipes: a session of instance A that learns the pipe name of the grant of B can connect to it. To close this gap, the agent pipe also needs a token. The `ssh` client cannot send one. So the agent pipe stays open to the same user. This is the same limit as above.

### Optional hardening for later

- Create pipes through `bun:ffi` with an explicit access list for the instance user only. Read the caller process id with `GetNamedPipeClientProcessId`. Accept only callers in the process tree of the instance. This stops a stolen token. It does not stop process injection by the same user. We do not plan this now. Say if you want it.

### Files and access lists

- The grant folder is `%ProgramData%\claude-rc-launcher\ssh\<instance>\`. The node removes inherited access at start. It gives full control to the service user, SYSTEM and Administrators only. It uses `icacls`.
- The config file, the `known_hosts` file and the public key file live there. Tests use a temporary folder and a platform injection, so no test touches `ProgramData`.
- At node start, the node removes every file that an earlier run left.

### Instance environment (question 5, answered in Task 1)

- The node starts each instance as a `claude remote-control` child in `win/instances.ts`. The plain path uses `Bun.spawn` and gives no environment option today.
- When the service user is an administrator, the node starts the instance with a restricted copy of its own token. This path is in `win/token.ts` and builds its environment from `CreateEnvironmentBlock`. It does not copy the node environment.
- This machine is that case. The service runs as `.\kir`, and `kir` is an administrator. A normal shell here has the Administrators group as deny only and Medium integrity. Sessions run with that same kind of token.
- So the plan adds an `env` option to both spawn paths. Each path adds `CLAUDE_RC_SSH_CONTROL` for that instance.

### Pipe access list with a restricted session (new finding)

- A restricted session cannot open a pipe whose access list gives full control only to SYSTEM and Administrators. The test used a pipe with exactly that list and got `Access to the path is denied`.
- The service has the full administrator token. A pipe that it creates by default most likely gets that kind of list, with no entry for the user alone. I could not run an elevated process, so I did not see this on the real service. The plan must treat it as true.
- The fix works. After `listen`, the node sets the access list of the pipe by name with `SetNamedSecurityInfoW` through `bun:ffi`. The list is SYSTEM and the service user SID, both with full control, and nothing inherited. A restricted client was denied with the first list and allowed with the second. `win/token.ts` already uses `bun:ffi`, so this is not new.
- This is a single call that sets the list. It is not the caller check that you declined. The pipe server stays `node:net`.
- Every agent pipe and the control pipe get this list at start. A short gap exists between `listen` and the call. The tests close it with a check before the pipe name goes to a session.

### Skill, option and docs

- The skill goes to `%USERPROFILE%\.claude\skills\ssh-access\` of the service user.
- The option `Allow SSH requests` returns for `win32`.
- The docs say that the node needs Win32-OpenSSH 9.x or later, and that the Windows `ssh-agent` service does not matter.

## Open risks

- Same-user limit between instances. See the threat model.
- Not tested with a second Windows account. We read the access list instead.
- The quiet `IdentityAgent` failure. A unit test must check the exact config text. An end to end test with `ssh.exe` must run on Windows.
- Bun on Windows named pipes. Five signs worked. We did not test high load or long idle time.
- The `ssh.exe` version. Only 9.5p2 is tested.

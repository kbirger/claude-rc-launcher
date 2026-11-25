# Plan: SSH access on a Windows node

Date: 2026-11-25. Status: draft, waiting for approval. Design note: `docs/superpowers/specs/2026-11-25-ssh-windows-node-design.md`.

## Process

- Each task has one implementer step, one review step and a fix loop.
- Commits are small. Stage files by name. No push without the owner saying yes.
- Tests use temporary folders. No test touches the real `ProgramData`, home or `.ssh` folder.
- Windows only tests skip on Linux. Linux tests use the `platform` injection.

## Answers to the six questions

1. Agent transport: a named pipe through `node:net`. Proven with `ssh-add` and `ssh.exe`.
2. Control channel: a pipe plus a per instance token. Same user limit is stated in the design note.
3. Files: a folder under `%ProgramData%\claude-rc-launcher\ssh\` with an access list from `icacls`. Built in task 3.
4. Config paths: forward slashes, double quotes for spaces. Proven.
5. Instance user and environment: open. Task 1 settles it before any wiring.
6. Win32-OpenSSH: 9.5p2 is installed here. The docs state the need.

## Tasks

### Task 1: Read the Windows instance start path

- Read how `runner.ts` starts an instance on `win32` and which environment it gives.
- Write a short note in the design file. Say which user runs the instances and how the variable reaches the session.
- Result: see the design note. Both spawn paths need an `env` option. The restricted path builds its own environment block.
- Result: a restricted session cannot open a default pipe of the full token. Task 2 sets the pipe access list with one `SetNamedSecurityInfoW` call.
- Still open: a test that shows the variable inside a real instance. It runs in Task 5.

### Task 2: Agent on a named pipe

- Add a pipe transport behind the interface of `GrantAgent`. Keep the Unix socket path for Linux.
- Pipe names come from a random value. Reject a name that matches `openssh-ssh-agent`.
- After `listen`, set the access list of the pipe to SYSTEM and the service user SID with `bun:ffi`. Test it with a restricted client.
- Tests: list, sign, bad frame, stop removes the pipe. They run on Windows. A fake transport test runs on Linux.

### Task 2a: SSH client check and install step

- Add `win/sshclient.ts`. It finds `ssh.exe` and `ssh-add.exe` in the Windows OpenSSH folders only, never on the PATH.
- It checks the version from `ssh.exe -V`. The minimum is 9.0. Tests give fake output.
- It runs the self test: a throwaway pipe agent and `ssh-add.exe -L`. This test reuses the Task 2 transport.
- The result is `{ ok, sshPath, sshAddPath, version }` or `{ ok: false, reason }`. The reason is plain English.
- The node runs the check at start and before each grant. The result decides the `sshRequests` option and the grant routes.
- `install.ps1` runs the same check. With no client, it installs `OpenSSH.Client` with `Add-WindowsCapability`. The switch `-NoSshClient` skips this.
- If the install fails, the script prints the reason, turns SSH access off and goes on. There is no winget fallback, because the only package is a preview build.
- The update path runs the check again.
- I do not run the install step on this machine without a yes from the owner.

### Task 3: Files and access lists

- Add a Windows files module. It makes the grant folder and sets the access list with `icacls`.
- Config text uses forward slashes. A unit test checks the exact text and the quoted space case.
- Tests use a temporary folder. A Windows test reads the access list back.

### Task 4: Control channel and CLI

- Add the pipe server with the token map. Unknown token closes the connection.
- Change `cli/src/sshcmd.ts` to connect to a pipe name on Windows and send the token first.
- Test: instance B cannot use the grant of instance A through its own token.

### Task 5: Wiring

- Mount the real grant routes on `win32` in `app.ts` and `sshnodewiring.ts`. Skip `asuser` and `accountIdentity` there.
- Give each instance its variable. Remove the 501 routes on Windows.
- Remove leftover files and pipes at node start.

### Task 6: Skill, option and docs

- Install the skill for the service user.
- Restore `sshRequests` in `settingsHelpFor` for `win32`.
- Edit `docs/ssh-delegation.md`, `docs/web-ui.md` and `docs/install.md` in plain English. Name the client check and the `-NoSshClient` switch.

### Task 7: Acceptance run

- Run the ten checks from the handover on this node with a test build.
- Ask the owner before the publish of a build, before the deploy and for each request approval.
- Report what is not tested.

## Needs from the owner

- A yes on this plan.
- Later: a yes to publish a test build, a yes to deploy it to `win`, the source address of this node on the `kirhub` key line, and approval of each request on the phone.

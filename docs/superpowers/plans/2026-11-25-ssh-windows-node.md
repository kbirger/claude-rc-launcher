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
- Done when a test shows the variable inside a real Windows instance.

### Task 2: Agent on a named pipe

- Add a pipe transport behind the interface of `GrantAgent`. Keep the Unix socket path for Linux.
- Pipe names come from a random value. Reject a name that matches `openssh-ssh-agent`.
- Tests: list, sign, bad frame, stop removes the pipe. They run on Windows. A fake transport test runs on Linux.

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
- Edit `docs/ssh-delegation.md`, `docs/web-ui.md` and `docs/install.md` in plain English.

### Task 7: Acceptance run

- Run the ten checks from the handover on this node with a test build.
- Ask the owner before the publish of a build, before the deploy and for each request approval.
- Report what is not tested.

## Needs from the owner

- A yes on this plan.
- Later: a yes to publish a test build, a yes to deploy it to `win`, the source address of this node on the `kirhub` key line, and approval of each request on the phone.

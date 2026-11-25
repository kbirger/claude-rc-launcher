# Handover: SSH access for sessions on a Windows node

Date: 2026-11-25. Branch: `feat/ssh-windows-node`. It starts from `feat/ssh-delegation` at commit `566344d`.
You work on the Windows node itself. Its host id is `win` and its machine name is KIRSTATION4. You can test each step on the real machine.

## Goal

A session on a Windows node asks the owner for temporary SSH access to a target. The owner approves on the phone. The session then runs `ssh` with the file that the node wrote. The hub signs on demand.

This works on a Linux node. It does not work on a Windows node. Your job is to close that gap.

Done means that every check in "Acceptance checks" passes on the Windows node.

## Not in scope

- A Windows hub. A Windows machine cannot be a hub.
- macOS nodes.
- The key file field for Windows targets. Windows has its own key files. The hub refuses a key file for a Windows target with a 400. Keep that.
- Windows as a target. It already works through the managed routes. Do not change it. The install script for a Windows target has only a syntax check. If you have time, test it.

## Rules from the owner

- Ask for an explicit yes before you push, publish, deploy or update any machine. A yes for one step does not cover the next step.
- Use temporary folders in tests. A test must never touch the real `ProgramData` state, the real home folder or the real `.ssh` folder.
- Write docs and screen text in plain English. Use at most 20 words in a step and 25 in a description. Use no contractions, no semicolons and no em-dashes. A hook checks every docs file after each edit.
- Do not commit the untracked file `docs/superpowers/plans/2026-11-20-session-events.md`. Do not commit a `.claude/` folder. Stage files by name.
- Work in small commits. Follow the owner's usual process: a short plan, one implementer step, one review step, then a fix loop.
- Never kill processes by name pattern. That command can kill your own shell.

## How the feature works on Linux

Read `docs/superpowers/specs/2026-11-23-ssh-delegation-design.md` first. Then read `docs/ssh-delegation.md`. This is the short version.

1. The hub holds one Ed25519 key for each target. The key never leaves the hub. The hub signs only while an approved grant is active.
2. A node holds no private key. For each grant, the node starts a keyless SSH agent on a Unix socket. When the OpenSSH client asks for a signature, the agent asks the hub to sign.
3. A session talks to the node through a control socket. The commands `claude-rc ssh targets` and `claude-rc ssh request` use it. The environment variable `CLAUDE_RC_SSH_CONTROL` of the instance holds its path.
4. The node tells the hub about a request with an `ssh.request` event. The owner approves on the phone. The hub answers through `POST /grants` on the node. The node then starts the agent and writes an `ssh` configuration file and a `known_hosts` file. It answers the waiting command with the paths.
5. The `ssh-access` skill tells a session how to use all this. The node installs the skill in the home folder of the instance user.

## Where the Unix assumptions are

This list is the work. For each item, find what the Windows version needs.

Grant routes:
- Files: `server/src/sshnodeapi.ts` (`unsupportedSshApi`), `server/src/app.ts` near line 507, `server/src/sshnodewiring.ts`.
- Today a node on `win32` mounts routes that answer 501. The wiring skips the grant routes and the sockets on `win32`.

Agent:
- File: `server/src/sshnodeagent.ts` (`GrantAgent`).
- It listens on a Unix socket with `Bun.listen`. The agent protocol in `server/src/sshagentproto.ts` is pure code and runs anywhere.

Socket files:
- File: `server/src/sshfiles.ts` (`listenStaged`, `MAX_SOCKET_PATH`).
- It uses a staging folder, `chmod` 700 and 600, `chown` and a rename. A socket path has at most 100 bytes.

Control socket:
- File: `server/src/sshnodecontrol.ts`.
- It is a Unix socket in a folder with mode 700. The identity of the caller is the socket itself.

Run folder and instance environment:
- File: `server/src/unit.ts`. The constant `SSH_RUN_DIR` is `/run/claude-rc-ssh`, a Linux path. The systemd unit gets the variable `CLAUDE_RC_SSH_CONTROL`.
- Find how a Windows node builds the environment of an instance. Start with `server/src/runner.ts` and the instance start on `win32`.

Run as another user:
- Files: `server/src/asuser.ts` and `accountIdentity` in `server/src/sshnodewiring.ts`.
- They use `setpriv`, `uid` and `gid`. A Windows service runs as one user, so this step is probably unnecessary.

Skill install:
- Files: `server/src/sshskill.ts` and `server/src/sshnodewiring.ts`.
- They write into a user home with `setpriv`. On Windows the target folder is `%USERPROFILE%\.claude\skills\ssh-access\`.

CLI:
- File: `cli/src/sshcmd.ts`.
- It connects to a Unix socket path.

Instance option:
- File: `server/src/instancesettings.ts` (`settingsHelpFor`).
- It removes the `sshRequests` option on `win32`, so the web UI never offers the switch. When the feature works, restore it.

The managed target routes (`sshManagedApi`) already work on Windows. Leave them alone.

## Questions to settle first

Run a short spike for each question on the real machine. Write each answer in the plan.

1. **Agent transport.** The Windows OpenSSH client `ssh.exe` accepts `IdentityAgent` with a named pipe such as `\\.\pipe\name`. It probably does not accept a Unix socket path for an agent. Test this on the machine. Then test what Bun can serve. Try `node:net` with `listen("\\\\.\\pipe\\name")`, and `Bun.listen` with `unix`. My recommendation is a named pipe with `node:net` under Bun. Test it with `ssh-add -l` and a real `ssh.exe` login. The agent protocol code stays as it is.
2. **Control channel for the CLI.** On Linux, a folder that only the instance user can open proves the identity. A named pipe has a wider default access list. Decide how an instance proves who it is. A good start is a long random pipe name that only that instance gets in its environment, plus an access list on the pipe. This step is security sensitive. In the plan, name the threat: another user or another instance on the machine. Instance A must never use the grant of instance B.
3. **Files and access lists.** The `ssh` configuration file, the `known_hosts` file and the public key file need the same protection as on Linux. Only the instance user can read them. Use `icacls` or the Windows API, not `chmod` and `chown`. Pick a folder under `%ProgramData%\claude-rc-launcher\` and set its access list at node start.
4. **Paths in the `ssh` configuration file.** The file holds `IdentityAgent`, `IdentityFile` and `UserKnownHostsFile`. Test quoting and backslashes with `ssh.exe -F`. Test that `StrictHostKeyChecking yes` and `IdentitiesOnly yes` work.
5. **Which user runs the instances.** The install guide says the service runs as the Windows user that signed in to `claude`. Check how instances start and which environment they get. This decides how the control pipe name reaches the session.
6. **Win32-OpenSSH.** Check that the client is installed and note its version. State in the docs what the node needs.

## Suggested order

1. Spike questions 1, 2 and 4. Keep the code in a scratch branch. Report what works.
2. Write a short design note and a plan in `docs/superpowers/`. Ask the owner to approve the plan before you build.
3. Build the agent on the chosen transport behind the same interface. Write tests that run on Linux through the `platform` injection. Write tests that run on Windows.
4. Build the control channel and the CLI side.
5. Wire the grant routes, the files, the environment variable and the instance option for `win32`.
6. Install the skill for the Windows user.
7. Update the docs. Edit `docs/ssh-delegation.md` where it says a Windows node cannot host sessions. Edit `docs/web-ui.md` and `docs/install.md`.

## Facts you need

- The hub runs on aihub at `https://clauderc.undisclosed.work`. The Windows node is host `win` at `https://192.168.1.102:18443`. The Linux node is `kirhub` at `https://192.168.1.111:8443`.
- Admin commands need the owner's admin login. An example is `claude-rc update --node win --release <tag>`. Ask the owner. Never use a login that is not yours.
- Test builds: run the Release workflow with `test_build` on. It publishes a pre-release named `vX.Y.Z-test.<branch>.<sha7>`. Run it with `dry_run` first. Ask the owner before you publish a build and before you deploy it.
- A target for tests is `kirhub` (`kir@192.168.1.111`). It uses an sshd drop-in file at `/etc/ssh/claude-rc/kir`. Its key line has `from="192.168.1.103"`, which is aihub. For a test from the Windows node, the owner adds the source address of the Windows node to that line. The owner also allows the node `win` for the target in the web UI. Ask the owner for both steps.
- On `kirhub`, a cron job rewrites `~/.ssh/authorized_keys` every hour from a gist. Never rely on that file for a hub key. Read the docs section "Keys that a job overwrites".
- The skill `ssh-access` says to run `claude-rc ssh request <target> --minutes <n> --reason "<why>"` in the background. The output shows `waiting for approval`, then `approved`, then the socket path, the file path and the `ssh -F` line.
- The hub sends a push notification for each new request. The owner can answer on the phone or on the SSH access page.
- One test in the suite fails now and then under load. When a test fails, run it on the base commit before you call it flaky or yours.
- On a Linux machine, `bun` lives in `~/.bun/bin` and is not always on the PATH. On Windows, find where `bun` is installed.

## Acceptance checks

Run these on the Windows node with a test build of your branch. The owner approves each request on the phone.

1. A session of an instance with `Allow SSH requests` on runs `claude-rc ssh targets`. It lists the targets that allow the node `win`.
2. The session runs `claude-rc ssh request <target> --minutes 5 --reason "test"`. The output shows `waiting for approval`. After the owner approves, it shows `approved` and the paths.
3. The session runs `ssh -F <file> <target> hostname`. It prints the host name. The hub log shows `signed`.
4. After the grant ends or the owner revokes it, the same command fails. The agent endpoint and the files of the grant are gone.
5. When the owner denies the request, the command ends with `the grant ended: denied`.
6. A second instance on the node cannot use the grant of the first one. Show this with a test.
7. A restart of the node removes the files that a grant left.
8. A user that is not the instance user cannot read the grant files. That user cannot open the agent or the control channel. Show this with a test where the machine allows it. Say in the report what you did not test.
9. The `Allow SSH requests` switch shows for the Windows node in the web UI and works.
10. The full test suite passes on Linux. On Windows, run the tests that apply and report the rest.

## What to report

- Which spikes worked, and what you chose.
- The plan, the commits and the review notes.
- What you did not test, and why.
- The open risks for the owner.

Do not push the branch. Ask the owner first.

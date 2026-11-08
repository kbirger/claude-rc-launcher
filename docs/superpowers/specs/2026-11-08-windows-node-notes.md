# Windows node: findings and plan

Status: research notes. No code is written yet. This file records the decisions and open questions so that work can continue on a Windows machine.

## Goal

Support a Windows machine as a node (an agent that a hub controls). Windows is not supported as a hub.

## Decision: run the node with WinSW

WinSW (Windows Service Wrapper) registers a normal `.exe` as a Windows service. A Bun executable made with `bun build --compile` cannot talk to the Service Control Manager (SCM, the part of Windows that starts and stops services). Windows stops a service that does not report its state within about 30 seconds. WinSW does that handshake and starts our `.exe` as a child process.

WinSW also provides restart on failure, log rotation, and capture of stdout and stderr. A small XML file maps onto our current systemd unit:

- `ExecStart` becomes `<executable>` and `<arguments>`.
- `Restart=always` and `RestartSec=5` become `<onfailure action="restart" delay="5 sec"/>`.
- `StateDirectory` becomes a folder under `C:\ProgramData`.

Options that we rejected:

- NSSM does the same job but is unmaintained. If you want a pure command line, use it.
- Calling `advapi32.dll` through Bun FFI works, but we must write and debug the SCM state machine ourselves.
- Task Scheduler has no real restart policy or service lifecycle.

## Why the Windows code can be isolated

A hub talks to a node only over HTTPS (`server/src/hostclient.ts` and `createNodeApp` in `server/src/app.ts`). The hub does not know how the node starts instances. A Windows node looks the same as a Linux node from the hub.

The Linux-specific code is in these places:

- `server/src/instances.ts`: `InstanceService` writes unit files and runs `systemctl` and `journalctl`.
- `server/src/unit.ts`: renders systemd unit text and assumes POSIX paths.
- `server/src/realupdate.ts` and `server/src/serviceupdate.ts`: use `systemd-run` and a `/bin/sh` watchdog.
- `cli/src/nodesetup.ts`: installs the unit file with `sudo` and `systemctl`.
- `server/src/owner.ts`, `server/src/users.ts`, `server/src/trust.ts`: use `id`, passwd, and a POSIX home directory.

## Proposed layout

`bun build --compile` bundles only what an entry point imports. Add a second entry point and a third binary. The existing Linux binaries never import the Windows code.

- `server/src/index.win.ts`: the Windows node entry point. It wires the Windows instance backend and the Windows updater.
- `server/src/win/`: the Windows instance backend and updater. Only `index.win.ts` imports this folder.
- `deploy/windows/claude-rc-launcher.xml`: the WinSW definition, in place of the `.service` file.
- `deploy/windows/install.ps1`: downloads the `.exe` and WinSW, writes the configuration, runs `winsw install`, and starts the service.
- A build target that produces `claude-rc-launcher-win.exe` and publishes it as a release asset.

The CLI command `claude-rc node setup` stays Linux-only. It must fail with a clear message on Windows. The PowerShell installer replaces it.

## The one change in shared code

`nodemain.ts` and `app.ts` take the concrete `InstanceService` class. Change that to an interface with the methods that `app.ts` already calls:

- `list`
- `start`
- `stop`
- `logs`
- `users`
- `trustFilter`
- `dirOwnerFor`

The current class becomes the systemd implementation and its behavior does not change. The Windows entry point passes its own implementation. Tests already inject dependencies, so this refactor has low risk.

Three smaller changes in shared code:

- Paths. `unit.ts` and `paths.ts` use `startsWith("/")` and `split("/")`. The Windows backend needs its own path rules, and `resolveWithinRoots` must accept drive letters and backslashes.
- Configuration. `scope`, `unit_dir` and `service_user` are systemd concepts. On Windows, ignore them or reject them with a clear message.
- Update. `createServiceUpdater` already takes an injectable `UpdateEnv`. The Windows entry point supplies one that replaces the `.exe` with a rename and a helper script.

## The Windows instance backend

This is new code, about 200 to 300 lines. It must do the following:

- Start `claude remote-control` as a child process with `Bun.spawn`.
- Track the PIDs and instance data in a state file, so that the list survives an agent restart.
- Write the output of each instance to a log file, and read the last N lines for the logs endpoint.
- Decide whether instances survive an agent restart. A Job Object setting can control this. The simple option is that instances restart with the agent.
- Drop user switching (`allowed_users`). Every instance runs as the service account.

## Self-update on Windows

Windows does not let a process overwrite its own running `.exe`. Use this sequence:

1. Download the new file next to the old one and check its hash.
2. Start a helper script that outlives the service.
3. The helper stops the service, renames the files, and starts the service.
4. If the new service does not become healthy, the helper restores the old file.

This is the same idea as the watchdog in `serviceupdate.ts`, written in PowerShell.

## Open risk: run claude remote-control as a service

Nobody has tested `claude remote-control` in a non-interactive Windows service yet. Its sign-in data lives in a user profile. A service that runs as `LocalSystem` cannot see that profile. The likely fix is to run the service as a named user account, which WinSW supports.

Test this by hand first, before any code:

1. Sign in to `claude` as a normal user on the Windows machine.
2. Install a trivial WinSW service that runs `claude remote-control` under that user.
3. Make sure that the session appears and survives a service restart and a logoff.

### Result of the manual test (2026-11-08)

Test setup: WinSW v2.12.0, claude 2.1.319, service installed with `install /p` as `KIRSTATION4\kir`. The test files are in `C:\Users\kir\winsw-test\`.

- **Passed:** a service that runs as a named user can read the `claude` sign-in data. The session connected and appeared in claude.ai/code.
- **Passed:** a service restart. WinSW stopped the child process (exit code 0), started a new one, and the session connected again.
- **Found:** `claude remote-control` exits with code 1 if the working directory is not trusted. The error is `Workspace not trusted. Please run claude in <dir> first`. WinSW then restarts it every 5 seconds. The Windows backend must mark each instance directory as trusted before it starts the instance. The Linux code does this in `server/src/trust.ts`. Open question: where Windows keeps the trust data.
- **Found:** `install /p` asks for the account password on the console. `install.ps1` must handle this. Do not write the password in the XML as plain text.
- **Not tested yet:** survival of a full logoff. A screen lock did not count as a test. Do this test later and update this section.

## Suggested order of work

1. Run the manual test for the open risk above.
2. Extract the instance interface in shared code. Make sure that the Linux tests still pass.
3. Add the path rules for Windows.
4. Write the Windows instance backend and `index.win.ts`.
5. Write the WinSW XML and `install.ps1`.
6. Write the Windows updater.
7. Add the build target and the release asset.

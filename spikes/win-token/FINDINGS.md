# Findings: Windows token spike

Date: 2026-11-09. Machine: KIRSTATION4 (Windows 11 Pro), Bun 1.4.4, user `kir` (local admin, Microsoft account).
Status: throwaway spikes. Nothing here ships. See `HANDOVER.md` for the original question.

## Spike 1 (`spike.ts`): SYSTEM service, token of a signed-in user

Run as SYSTEM through `schtasks`, with `kir` signed in (session 1).

- `bun:ffi` works for `WTSEnumerateSessionsW`, `WTSQueryUserToken`, `DuplicateTokenEx`, `CreateEnvironmentBlock` and
  `CreateProcessAsUserW`. The x64 struct layouts in the script were correct.
- `WTSQueryUserToken` gave the UAC-filtered token (`elevationType=limited`). The linked token is the full one.
- The probe process in the session saw `BUILTIN\Administrators` as `Group used for deny only`, integrity `Medium`
  and no `SeDebugPrivilege`. This is the target result.
- A session with no user (session 65536) fails with error 2, not 1008.
- Not tested: a standard user as a second session, a disconnected session, a user who is not signed in.

A signed-in user is required for this path. Without a session there is no token. `LogonUser` needs the password.
S4U (`LsaLogonUser`) needs no password but is untested.

## Spike 2 (`spike2.ts`): single user, service drops its own permissions

Question: a service runs as one user (as the current WinSW service does, `-Account`). Can it start a session with a
reduced token made from its own token? Run from an elevated shell, then as a real WinSW service (`.\kir`). Both gave
the same results.

The service's own token is the full admin token: High integrity, 24 privileges, Administrators enabled.

What works (variant H/I in the script):

1. `CreateRestrictedToken(own, LUA_TOKEN | DISABLE_MAX_PRIVILEGE)`.
2. `SetTokenInformation(TokenDefaultDacl)` and `SetTokenInformation(TokenOwner)` to the user's own SID. The DACL
   grants the user and SYSTEM `GENERIC_ALL`.
3. `SetTokenInformation(TokenIntegrityLevel)` to Medium (`S-1-16-8192`).
4. `CreateProcessAsUserW` with that token.

Result in the child: Administrators `Group used for deny only`, integrity `Medium`, one privilege
(`SeChangeNotifyPrivilege`). This matches a UAC-filtered token.

Pitfalls found:

- **Step 2 is required.** `LUA_TOKEN` alone makes Administrators deny-only. The default DACL of the new token still
  grants only Administrators and SYSTEM. The child cannot open its own token (`whoami /groups` says "Access is
  denied") and any launch that creates a console fails with `0xC0000142` (`STATUS_DLL_INIT_FAILED`).
- `LUA_TOKEN` leaves integrity at High. Step 3 is separate.
- `CreateProcessAsUserW` works without `SeAssignPrimaryTokenPrivilege`, because the token is a restricted copy of
  the caller's own token.
- Launch with no console flags (the child inherits or gets a console), `CREATE_NO_WINDOW` and `CREATE_NEW_CONSOLE`
  all work once step 2 is done. The `DETACHED_PROCESS` rows in the log print nothing, even for the unrestricted
  control. This is a probe artefact (`whoami` with no console). Ignore those rows.
- Disabling only the Administrators SID (variant D) or only the privileges (variant C) is not enough on its own.
  Variant C leaves the admin group enabled. Variant D leaves 24 privileges.
- The service cannot move the child into another session (needs `SeTcbPrivilege`). The child stays in the
  service's session. That is fine for headless Claude sessions.

## Spike 3 (`spike3.ts`): a real Claude session under the restricted token

`spike3.exe <restricted|own> <outfile> <command line>` runs `cmd /c <command line>` with the chosen token.
Ran `claude -p` (Claude Code 2.1.321) with the Bash tool, asked it to run `whoami /groups` and `whoami /priv`.
Run from an elevated shell, not from a service.

| What Claude reported | Own token | Restricted token |
|---|---|---|
| `BUILTIN\Administrators` | Enabled | Deny-only |
| Integrity | High | Medium |
| Privileges | 24 | 1 (`SeChangeNotifyPrivilege`) |

Both runs exited 0 and authenticated. No profile or credential problem. (Git Bash rewrote `/groups` as a path.
Claude fixed that with `MSYS_NO_PATHCONV=1`. It is not related to the token.)

## Not tested

- `claude remote-control` or any long-lived session under the restricted token.
- The Claude run as a registered service (only the spike 2 probe ran as a service).
- A standard (non-admin) user. A service that runs as a standard user has nothing to drop.
- Tools that expect admin rights, network access and mapped drives under the restricted token.
- Several users from one SYSTEM service: S4U for users who are not signed in, disconnected sessions, standard
  users in a second session.
- `CreateRestrictedToken` does not change the user. A token for another user needs `WTSQueryUserToken` (signed in) or
  S4U or `LogonUser` first.

## Reproduce

```
bun build --compile --target=bun-windows-x64 spike2.ts --outfile spike2.exe
bun build --compile --target=bun-windows-x64 spike3.ts --outfile spike3.exe
```

`spike2.exe` writes `C:\ProgramData\claude-rc-spike2\spike2.log`. To run it as a service, create a WinSW service
the way `deploy/windows/install.ps1` does (copy the WinSW exe, write an XML that runs `spike2.exe`, then
`<svc>.exe install /p` and enter the account and password). Remove it afterwards with `<svc>.exe uninstall`.
Do not commit the `.exe` files.

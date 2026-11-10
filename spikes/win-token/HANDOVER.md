# Handover: Windows token spike

Status: written and compiled on Linux. NEVER RUN on Windows. Every result below is unknown until you run it.
Date: 2026-11-09. Branch: `spike/win-token` (based on `main`, v0.8.4). Nothing here ships.

## Why this exists

Today the Windows node service runs as one ordinary user (`-Account`), asks for that user's password at install, and every session runs as that user. If that user is a local administrator, Windows gives the service the full admin token (services get no UAC filtering), so every session runs with admin rights.

The design we want: the service starts each session as an interactively logged-on user, with that user's own token. No stored password. This spike answers whether a Bun executable can do that with `bun:ffi` alone, and whether the token it gets is the UAC-filtered one.

## What you need

- A Windows machine (KIRSTATION4) and an elevated command prompt.
- Best test: two users signed in at once, one local admin and one standard user (fast user switching or RDP is fine). One admin user alone also gives the key answer.
- `spike.exe`. Build it with Bun on any machine: `bun build --compile --target=bun-windows-x64 spike.ts --outfile spike.exe` (run in this folder).

## Run it

```
copy spike.exe C:\Windows\Temp\spike.exe
schtasks /create /tn claude-rc-spike /ru SYSTEM /sc once /st 00:00 /tr C:\Windows\Temp\spike.exe /f
schtasks /run /tn claude-rc-spike
timeout /t 20
type C:\ProgramData\claude-rc-spike\spike.log
schtasks /delete /tn claude-rc-spike /f
```

Send back `C:\ProgramData\claude-rc-spike\spike.log`. Also send `C:\ProgramData\claude-rc-spike\session-*.txt` if the log looks odd.

Clean up afterwards: delete `C:\Windows\Temp\spike.exe` and `C:\ProgramData\claude-rc-spike`. The spike gives the Users group Modify rights on that folder so that the probe can write there.

## What the log tells us

For each session the log shows: the token that Windows hands to a SYSTEM service (`WTSQueryUserToken`), its elevation type, the linked token if any, and what a probe process in that session sees.

| Log shows | Meaning | Next step |
|---|---|---|
| a crash, or `CreateProcessAsUserW failed` | `bun:ffi` does not work here, or a struct offset is wrong | write the small Rust helper instead |
| `elevationType=limited` for an admin user | a service gets the filtered token by default | use it as is |
| `elevationType=full` for an admin user | the service must restrict the token itself | add `CreateRestrictedToken` and test again |
| probe admin group says `Group used for deny only` and integrity is `Medium` | the session is not admin (good) | this is the target result |
| probe admin group says `Mandatory group, Enabled group` and integrity is `High` | the session is admin | see the row above |
| `WTSQueryUserToken failed: 1008` | no user in that session | expected for idle sessions |

`GetLastError` through `bun:ffi` can be unreliable (Bun may overwrite it between calls). Treat error numbers as hints, not facts.

## Known gaps

- The struct layouts are for x64 and come from the Win32 documentation, not from a test.
- Disconnected sessions, RDP sessions and session 0 (services) are only reported, not examined.
- No `LogonUser` path (users who are not logged on). We dropped them for the first version.
- No `CreateRestrictedToken`, no stdout capture, no job object, no cleanup at logoff. Those come after the spike answers the first question.

## After the spike

If it works, the next step is a design and plan for a SYSTEM service that launches sessions per logged-on user. The v0.8.5 release (registry in HKLM and one parent folder `C:\Program Files\claude-rc\{bin,service}`) is separate and still waiting. See the earlier discussion in this session and `docs/superpowers/specs/2026-11-09-client-registry-design.md`.

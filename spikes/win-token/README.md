# Windows token spike (throwaway)

Question: from a Bun executable running as SYSTEM, can we start a process in each logged-on
user's session with that user's own token, using only `bun:ffi`? Is that token UAC-filtered?

## Build (any machine with Bun)

    bun build --compile --target=bun-windows-x64 spike.ts --outfile spike.exe

## Run on KIRSTATION4, as SYSTEM

Sign in as at least one user first (an admin user and a standard user is the best test; a
second session through fast user switching or RDP works). Then in an elevated prompt:

    copy spike.exe C:\Windows\Temp\spike.exe
    schtasks /create /tn claude-rc-spike /ru SYSTEM /sc once /st 00:00 /tr C:\Windows\Temp\spike.exe /f
    schtasks /run /tn claude-rc-spike
    timeout /t 20
    type C:\ProgramData\claude-rc-spike\spike.log
    schtasks /delete /tn claude-rc-spike /f

Send back `spike.log`. It names each session, the elevation type of the token that Windows
gives a service, and what the process inside the session sees (groups, integrity level).

## What the answers mean

- `CreateProcessAsUserW failed` or a crash: bun:ffi does not work for this. Use a Rust helper.
- `elevationType=limited` for an admin user: the service gets the filtered token by default.
- `elevationType=full`: the service must restrict the token itself (`CreateRestrictedToken`).

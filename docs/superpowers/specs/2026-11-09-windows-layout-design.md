# Windows layout and registry key: design addendum

Status: the direction is approved by the user in chat (registry key, one parent folder, fewer options). The details below are the author's calls until the user reviews them. Date: 2026-11-09.
This addendum replaces the Windows parts of `2026-11-09-client-registry-design.md` (the registry file with an ACL). The Linux parts stay as they are.

## Intent

The Windows installer has four folder options, and the client registry on Windows is a file in a folder that the installer must lock down. A review found that this folder can be planted before the installer runs. The user asked for a simpler design:

- Use the Windows registry to record the install, because only an administrator can write under `HKLM\SOFTWARE` by default. There is no folder to protect.
- Put both programs under one parent folder, like other Windows software.
- Offer fewer options.

## Goals

1. One parent folder, `C:\Program Files\claude-rc`, holds both programs: `bin\claude-rc.exe` (the client, on the machine PATH) and `service\` (the node service, WinSW and the launcher script).
2. The installer records the client path in `HKLM\SOFTWARE\claude-rc`. The node reads it. A user without administrator rights cannot change it.
3. A machine with the old layout keeps working after it updates, and the installer moves the client to the new place.
4. The only folder option of `install.ps1` is `-InstallDir`.

## Non-goals

- A per-user install under `%LOCALAPPDATA%` with `HKCU`. A later change can add it. The node must never read `HKCU` in system mode.
- Moving an existing service. A reinstall keeps the service where it is. Moving it needs an uninstall and an install.
- The restricted token for sessions and the per-user service. They are separate changes (see `spikes/win-token/FINDINGS.md`).
- Changes to Linux.

## Anti-goals

- A user without administrator rights must never make the node run a program, because of a registry value or a file.
- A missing or broken registry value must never stop the service or the host list.

## Design

### Folders

| Path | Holds | Who can write |
|---|---|---|
| `<InstallDir>` (default `C:\Program Files\claude-rc`) | the parent | administrators (inherited from Program Files) |
| `<InstallDir>\bin` | `claude-rc.exe`. This folder is on the machine PATH. | administrators |
| `<InstallDir>\service` | `claude-rc-launcher.exe`, WinSW, the XML, `claude-rc-launcher-run.ps1` | administrators and the service account (Modify) |
| `%ProgramData%\claude-rc-launcher` | config, certificate, state, logs | unchanged |

The installer gives the service account Modify rights on `service` only. The parent and `bin` get no extra grant. The service account cannot replace the client or anything on the PATH.

Parameters: `-InstallDir` stays. `-ClientDir` and `-RegistryDir` go away. `-DataDir` stays, because the tests and the config use it.

### The registry key

`HKLM\SOFTWARE\claude-rc`, value `Client`, type `REG_SZ`: the absolute path of `claude-rc.exe`. The installer writes it with the 64-bit view. A second install replaces the value. `-NoClient` writes nothing.

The node reads it with `%SystemRoot%\System32\reg.exe query HKLM\SOFTWARE\claude-rc /v Client /reg:64` and a 2 second timeout. Bun has no registry API. A missing key gives an empty list and no log line. Any other failure gives an empty list and one log line. The node applies the existing entry rules: a local drive path, no `..`, the file name `claude-rc.exe`.

The node does not check the key's ACL. By default only administrators and SYSTEM can create or change a key under `HKLM\SOFTWARE`. An administrator who loosens it takes that risk.

### Finding the clients

The Windows scan keeps PATH (split on `;`) and looks at two default places under `%ProgramFiles%`: `claude-rc\bin\claude-rc.exe` and the old `claude-rc\claude-rc.exe`. The old one lets a machine show its client before it is reinstalled.

### The installer

- A new install uses `<InstallDir>\bin` and `<InstallDir>\service`.
- A reinstall finds the old service (`%ProgramFiles%\claude-rc-launcher\claude-rc-launcher-svc.exe`) when `-InstallDir` is not given and the new `service` folder does not exist. It then keeps the service in the old folder and gives that folder the same Modify grant. It still installs the client into the new `bin`.
- If the old client `<InstallDir>\claude-rc.exe` exists, the installer deletes it, takes `<InstallDir>` off the machine PATH and adds `<InstallDir>\bin`. The service account cannot write that folder, so this is safe.
- `-Uninstall` removes the service, the firewall rule and both PATH entries. It keeps the files, the registry value and the data. It prints what is kept.
- `-ClientOnly` writes the client into `bin`, the PATH entry and the registry value.
- For tests, `-ClientRegistryKey` (default `HKLM:\SOFTWARE\claude-rc`) names another key, like `-PathRegistryKey`.

## Constraints

- PowerShell 5.1 and 7. Bun and TypeScript on the node. No new dependency.
- Tests need no real registry, no real Program Files and no administrator rights. The tests give a throwaway key under `HKCU` and temporary folders.
- The reader takes the registry call as an input (`regQuery`), so tests need no `reg.exe`.

## Calls made by the author

1. One `REG_SZ` value `Client`, not a list. The installer makes one client. The scan finds any other copy.
2. The node starts `reg.exe` with a synchronous call and a 2 second timeout. The client version cache (60 seconds) means it runs at most once a minute.
3. A reinstall keeps the old service folder. This avoids moving a running service and its WinSW registration.
4. `-DataDir` stays a parameter.

## Left to the builder

Function names, the exact log line, how the installer detects the old layout, and the PowerShell helpers.

## Tests the builder must add

- Reader (Windows): a `Client` value gives its path. A missing key gives `[]` and no log. A failed query gives `[]` and one log line. A value with a UNC path, `..`, a relative path or another file name gives `[]`. A value with spaces works.
- `findClients` on Windows finds `claude-rc\bin\claude-rc.exe` and the old `claude-rc\claude-rc.exe` under Program Files, with no PATH entry.
- Installer: the layout (`bin\claude-rc.exe`, `service\...`), the grant on `service` only, the registry value, a second run that changes nothing, the old-client migration (file deleted, PATH changed), the old-service reinstall, `-NoClient`, `-ClientOnly` and `-Uninstall`.

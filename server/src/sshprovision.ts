import type { SystemType } from "./sshtargets";

// Provisioning scripts. A script puts the public key line of a target into the `authorized_keys` list of the account on
// the target. The owner or the hub runs it on the target through a remote shell (the script goes to the shell on stdin).
// The script is safe to run twice: it adds the line only when it is not there yet. It prints nothing on success and
// exits with a code other than 0 on failure.
// The line is data. It goes into a single-quoted string, with each single quote escaped, so that no character in it can
// run as a command. The same holds for the account name of the Windows script.

export interface Script {
  shell: "sh" | "powershell";
  script: string;
}

export interface ProvisionOptions {
  /** Windows only: the account whose profile receives the key. Without it, the script uses the account that runs it. */
  account?: string;
}

/** Quote a value for a POSIX shell: single quotes, and each single quote becomes `'\''`. */
function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Quote a value for PowerShell: single quotes, and each single quote is doubled. */
function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function shScript(line: string, synology: boolean): string {
  return [
    "set -eu",
    "umask 077",
    `line=${shQuote(line)}`,
    'dir="$HOME/.ssh"',
    'file="$dir/authorized_keys"',
    ...(synology ? ['chmod go-w "$HOME"'] : []),
    'mkdir -p "$dir"',
    'chmod 700 "$dir"',
    'touch "$file"',
    'chmod 600 "$file"',
    'if ! grep -qxF -- "$line" "$file"; then',
    // A last line without a newline would swallow the new key.
    '  if [ -n "$(tail -c 1 "$file")" ]; then printf \'\\n\' >> "$file"; fi',
    '  printf \'%s\\n\' "$line" >> "$file"',
    "fi",
    "",
  ].join("\n");
}

function powershellScript(line: string, account: string | undefined): string {
  const profile =
    account === undefined
      ? "$env:USERPROFILE"
      : `(Join-Path (Split-Path -Parent $env:USERPROFILE) ${psQuote(account)})`;
  return [
    "$ErrorActionPreference = 'Stop'",
    `$line = ${psQuote(line)}`,
    "$identity = [Security.Principal.WindowsIdentity]::GetCurrent()",
    "$admin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
    `if (${account === undefined ? "$admin" : "$false"}) {`,
    "  $file = Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys'",
    "  $dir = Split-Path -Parent $file",
    "} else {",
    `  $dir = Join-Path ${profile} '.ssh'`,
    "  $file = Join-Path $dir 'authorized_keys'",
    "}",
    "New-Item -ItemType Directory -Force -Path $dir | Out-Null",
    "if (-not (Test-Path -LiteralPath $file)) { New-Item -ItemType File -Path $file | Out-Null }",
    "$lines = @([IO.File]::ReadAllLines($file))",
    "if ($lines -notcontains $line) {",
    "  $utf8 = New-Object System.Text.UTF8Encoding $false",
    "  $text = [IO.File]::ReadAllText($file)",
    "  $prefix = ''",
    '  if ($text.Length -gt 0 -and -not $text.EndsWith("`n")) { $prefix = "`r`n" }',
    '  [IO.File]::AppendAllText($file, $prefix + $line + "`r`n", $utf8)',
    "}",
    "if ($file -like '*administrators_authorized_keys') {",
    // SIDs, not names: S-1-5-18 is SYSTEM and S-1-5-32-544 is Administrators, on any display language.
    "  icacls.exe $file /inheritance:r /grant '*S-1-5-18:(F)' /grant '*S-1-5-32-544:(F)' | Out-Null",
    "  if ($LASTEXITCODE -ne 0) { throw 'icacls failed' }",
    "}",
    "",
  ].join("\n");
}

/**
 * Build the script that installs `line` for the given system type. Linux and Dropbear use `~/.ssh/authorized_keys`
 * (folder mode 700, file mode 600). Synology also removes group and other write from the home folder, because sshd
 * refuses keys when it is writable. Windows uses `administrators_authorized_keys` for an administrator (with access
 * for SYSTEM and Administrators only) and `%USERPROFILE%\.ssh\authorized_keys` for any other account.
 */
export function provisionScript(systemType: SystemType, line: string, options: ProvisionOptions = {}): Script {
  if (systemType === "windows") return { shell: "powershell", script: powershellScript(line, options.account) };
  return { shell: "sh", script: shScript(line, systemType === "synology") };
}

import type { SystemType } from "./sshtargets";

// Provisioning scripts. A script puts the public key line of a target into the `authorized_keys` list of the account on
// the target. The owner or the hub runs it on the target through a remote shell (the script goes to the shell on stdin).
// The script is safe to run twice: it adds the line only when it is not there yet. It prints nothing on success and
// exits with a code other than 0 on failure.
// Delivery contract for the Windows script: it is self-contained and runs from stdin with
// `powershell -NoProfile -NonInteractive -Command -`. In that mode PowerShell does not stop on an error and exits with 0,
// and it drops a last multi-line block that is followed by one newline only. So the body is wrapped in try and catch
// (a failure writes to stderr and exits with 1), and the script ends with a blank line.
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

/**
 * Quote a value for PowerShell: single quotes, and each single-quote character is doubled. PowerShell treats the
 * typographic quotes U+2018, U+2019, U+201A and U+201B as single quotes too, so they are doubled as well.
 */
function psQuote(value: string): string {
  return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;
}

// Two scripts on one account at the same time could lose a line. With flock, they wait for each other. The lock file is
// in the `.ssh` folder and belongs to the account. Without flock, or when the lock file cannot be made, the script runs
// without a lock. The node also runs the scripts of one account one after the other.
const LOCK_LINES = [
  'if command -v flock >/dev/null 2>&1 && ( : >> "$dir/.claude-rc.lock" ) 2>/dev/null; then',
  '  exec 9>> "$dir/.claude-rc.lock"',
  "  flock 9",
  "fi",
];

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
    ...LOCK_LINES,
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
  const body =
    account === undefined
      ? [
          "$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
          "$profileDir = $env:USERPROFILE",
        ]
      : [
          `$sid = (New-Object Security.Principal.NTAccount(${psQuote(account)})).Translate([Security.Principal.SecurityIdentifier])`,
          "$admin = @(Get-LocalGroupMember -SID 'S-1-5-32-544' | ForEach-Object { $_.SID.Value }) -contains $sid.Value",
          '$entry = "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\$($sid.Value)"',
          `if (-not (Test-Path -LiteralPath $entry)) { throw "no profile for account " + ${psQuote(account)} + ": the account has never logged on" }`,
          "$profileDir = [Environment]::ExpandEnvironmentVariables((Get-ItemProperty -LiteralPath $entry).ProfileImagePath)",
        ];
  return [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    `  $line = ${psQuote(line)}`,
    ...body.map((text) => `  ${text}`),
    "  if ($admin) {",
    "    $file = Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys'",
    "    $dir = Split-Path -Parent $file",
    "  } else {",
    "    $dir = Join-Path $profileDir '.ssh'",
    "    $file = Join-Path $dir 'authorized_keys'",
    "  }",
    "  New-Item -ItemType Directory -Force -Path $dir | Out-Null",
    "  if (-not (Test-Path -LiteralPath $file)) { New-Item -ItemType File -Path $file | Out-Null }",
    "  $lines = @([IO.File]::ReadAllLines($file))",
    "  if ($lines -notcontains $line) {",
    "    $utf8 = New-Object System.Text.UTF8Encoding $false",
    "    $text = [IO.File]::ReadAllText($file)",
    "    $prefix = ''",
    '    if ($text.Length -gt 0 -and -not $text.EndsWith("`n")) { $prefix = "`r`n" }',
    '    [IO.File]::AppendAllText($file, $prefix + $line + "`r`n", $utf8)',
    "  }",
    "  if ($admin) {",
    // SIDs, not names: S-1-5-18 is SYSTEM and S-1-5-32-544 is Administrators, on any display language.
    "    icacls.exe $file /inheritance:r /grant '*S-1-5-18:(F)' /grant '*S-1-5-32-544:(F)' | Out-Null",
    "    if ($LASTEXITCODE -ne 0) { throw 'icacls failed' }",
    "  }",
    "} catch {",
    "  [Console]::Error.WriteLine($_)",
    "  exit 1",
    "}",
    "",
    "",
  ].join("\n");
}

/**
 * Build the script that installs `line` for the given system type. Linux and Dropbear use `~/.ssh/authorized_keys`
 * (folder mode 700, file mode 600). Synology also removes group and other write from the home folder, because sshd
 * refuses keys when it is writable. Windows uses `administrators_authorized_keys` for an administrator (with access
 * for SYSTEM and Administrators only) and `.ssh\authorized_keys` in the profile for any other account. Without
 * `account`, that is the account that runs the script (`%USERPROFILE%`). With `account`, the script looks up the SID of the
 * account, checks the Administrators group, and reads the profile folder from the ProfileList registry key. It fails
 * when the account has no profile.
 */
export function provisionScript(systemType: SystemType, line: string, options: ProvisionOptions = {}): Script {
  if (systemType === "windows") return { shell: "powershell", script: powershellScript(line, options.account) };
  return { shell: "sh", script: shScript(line, systemType === "synology") };
}

// Removal scripts. They take the key line of a target out of the same `authorized_keys` file. A line goes when the key
// blob is one of its fields and its last field is the comment `claude-rc:<id>`. A line with only the blob or only the
// comment stays. The match does not use the whole line, because the `from=` part can change after the install.
// The script prints `removed` or `not-found`, and it is safe to run twice. The values are data: they are quoted like in
// the install scripts, and the shell script hands them to awk through the environment, so awk does not read escapes.

// A line goes only when its last three fields are `ssh-ed25519`, the blob and the comment. So a blob inside the options
// of another key does not match. A first field that starts with `#` is a comment line and stays. A CR at the end of the
// last field (CRLF file) is ignored for the match, and the kept lines keep their bytes. A missing final newline stays
// missing, unless the last line goes.
const AWK_PROGRAM = [
  '{ c = $NF; sub(/\\r$/, "", c); hit = 0',
  '  if (NF >= 3 && substr($1, 1, 1) != "#" && c == ENVIRON["RC_COMMENT"] && $(NF - 1) == ENVIRON["RC_BLOB"] && $(NF - 2) == "ssh-ed25519") hit = 1',
  '  if (ENVIRON["RC_MODE"] == "count") n += hit',
  "  else if (hit) kept = 0",
  '  else { if (have) printf "\\n"; printf "%s", $0; have = 1; kept = 1 } }',
  'END { if (ENVIRON["RC_MODE"] == "count") print n + 0',
  '  else if (have && !(ENVIRON["RC_NONL"] == "1" && kept)) printf "\\n" }',
].join("\n");

function shRemoveScript(blob: string, comment: string): string {
  return [
    "set -eu",
    "umask 077",
    `RC_BLOB=${shQuote(blob)}`,
    `RC_COMMENT=${shQuote(comment)}`,
    "export RC_BLOB RC_COMMENT",
    'dir="$HOME/.ssh"',
    'file="$dir/authorized_keys"',
    // A link would be replaced by a plain file, and the target of the link would stay as it was.
    'if [ -L "$dir" ] || [ -L "$file" ]; then echo "authorized_keys or its folder is a symbolic link" >&2; exit 1; fi',
    'if [ ! -f "$file" ]; then echo not-found; exit 0; fi',
    ...LOCK_LINES,
    `prog=${shQuote(AWK_PROGRAM)}`,
    'count=$(RC_MODE=count awk "$prog" "$file")',
    'if [ "$count" = 0 ]; then echo not-found; exit 0; fi',
    "RC_NONL=0",
    'if [ -n "$(tail -c 1 "$file")" ]; then RC_NONL=1; fi',
    "export RC_NONL",
    // A temporary file in the same folder and a rename keep the write atomic. cp -p keeps the mode of the file. A non-root
    // account keeps its own owner. When the folder is not writable, the script stops: it never rewrites the file in place,
    // because a failed write could leave a cut-off file.
    'tmp="$file.tmp.$$"',
    'if ! cp -p "$file" "$tmp" 2>/dev/null; then echo "cannot make a temporary file in $dir" >&2; exit 1; fi',
    'if RC_MODE=keep awk "$prog" "$file" > "$tmp" && mv -f "$tmp" "$file"; then :; else rm -f "$tmp"; exit 1; fi',
    "echo removed",
    "",
  ].join("\n");
}

function powershellRemoveScript(blob: string, comment: string, account: string | undefined): string {
  const body =
    account === undefined
      ? [
          "$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
          "$profileDir = $env:USERPROFILE",
        ]
      : [
          `$sid = (New-Object Security.Principal.NTAccount(${psQuote(account)})).Translate([Security.Principal.SecurityIdentifier])`,
          "$admin = @(Get-LocalGroupMember -SID 'S-1-5-32-544' | ForEach-Object { $_.SID.Value }) -contains $sid.Value",
          '$entry = "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\$($sid.Value)"',
          `if (-not (Test-Path -LiteralPath $entry)) { throw "no profile for account " + ${psQuote(account)} + ": the account has never logged on" }`,
          "$profileDir = [Environment]::ExpandEnvironmentVariables((Get-ItemProperty -LiteralPath $entry).ProfileImagePath)",
        ];
  return [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    `  $blob = ${psQuote(blob)}`,
    `  $comment = ${psQuote(comment)}`,
    "  $tmp = $null",
    ...body.map((text) => `  ${text}`),
    "  if ($admin) {",
    "    $file = Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys'",
    "  } else {",
    "    $file = Join-Path (Join-Path $profileDir '.ssh') 'authorized_keys'",
    "  }",
    "  if (-not (Test-Path -LiteralPath $file)) { [Console]::Out.WriteLine('not-found'); exit 0 }",
    "  $lines = @([IO.File]::ReadAllLines($file))",
    "  $kept = @()",
    "  foreach ($entryLine in $lines) {",
    "    $fields = @($entryLine.Trim() -split '\\s+')",
    "    if ($fields.Count -ge 3 -and -not $fields[0].StartsWith('#') -and $fields[-1] -ceq $comment -and $fields[-2] -ceq $blob -and $fields[-3] -ceq 'ssh-ed25519') { continue }",
    "    $kept += $entryLine",
    "  }",
    "  if ($kept.Count -eq $lines.Count) { [Console]::Out.WriteLine('not-found'); exit 0 }",
    "  $utf8 = New-Object System.Text.UTF8Encoding $false",
    "  $text = ''",
    '  if ($kept.Count -gt 0) { $text = ($kept -join "`r`n") + "`r`n" }',
    // A temporary file in the same folder and a replace keep the write atomic. The ACL of the old file goes to the new one,
    // and the administrator file gets the same permissions as the install script gives.
    "  $tmp = $file + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'",
    "  [IO.File]::WriteAllText($tmp, $text, $utf8)",
    "  Set-Acl -LiteralPath $tmp -AclObject (Get-Acl -LiteralPath $file)",
    "  [IO.File]::Replace($tmp, $file, $null)",
    "  $tmp = $null",
    "  if ($admin) {",
    "    icacls.exe $file /inheritance:r /grant '*S-1-5-18:(F)' /grant '*S-1-5-32-544:(F)' | Out-Null",
    "    if ($LASTEXITCODE -ne 0) { throw 'icacls failed' }",
    "  }",
    "  [Console]::Out.WriteLine('removed')",
    "} catch {",
    "  if ($tmp -and (Test-Path -LiteralPath $tmp)) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }",
    "  [Console]::Error.WriteLine($_)",
    "  exit 1",
    "}",
    "",
    "",
  ].join("\n");
}

/**
 * Build the script that removes the key line of a target: every line with `keyBlob` as a field and the comment
 * `claude-rc:<id>` as its last field. It uses the same file as `provisionScript` and the same handling of the Windows
 * account. It prints `removed` or `not-found` and exits non-zero on an error.
 */
export function deprovisionScript(
  systemType: SystemType,
  keyBlob: string,
  id: string,
  options: ProvisionOptions = {},
): Script {
  const comment = `claude-rc:${id}`;
  if (systemType === "windows")
    return { shell: "powershell", script: powershellRemoveScript(keyBlob, comment, options.account) };
  return { shell: "sh", script: shRemoveScript(keyBlob, comment) };
}

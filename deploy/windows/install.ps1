<#
.SYNOPSIS
  Installs claude-rc-launcher as a Windows node service (WinSW) and starts it once the config is ready.

.DESCRIPTION
  Run in an elevated PowerShell (Windows PowerShell 5.1 or PowerShell 7):

    .\install.ps1 [-Binary <exe>] [-Release v1.2.3] [-Account DOMAIN\user] [-OpenFirewall] [-NoClient]
    .\install.ps1 -ClientOnly [-Release v1.2.3]      only the claude-rc client and the PATH (no node, no service)
    .\install.ps1 -Uninstall

  What it does, in order:
    * Gets claude-rc-launcher-win-x64.exe: -Binary, else .\..\..\dist\, else the GitHub release (the latest, or
      -Release). A download is checked against the SHA256SUMS of the same release.
    * Gets the command-line client the same way (-ClientBinary, else .\..\..\dist\claude-rc.exe, else the release asset
      claude-rc-windows-x64.exe), installs it as <ClientDir>\claude-rc.exe and adds <ClientDir> to the machine PATH.
      Open a new terminal afterwards. -NoClient skips both. ClientDir is a folder of its own
      (C:\Program Files\claude-rc), not -InstallDir: the service account can write to -InstallDir, and a folder on
      the PATH must not be writable by it.
    * Gets WinSW (the Windows service wrapper) v2.12.0 and checks it against a pinned SHA-256.
    * Copies both into -InstallDir, with the launcher script, and writes the WinSW definition next to them. The
      service account gets Modify rights on -InstallDir: the agent updates its own binary there. The binary is written as a
      new file and moved over the old one, after the service is stopped.
    * Creates <DataDir>\config.toml from node.config.example.toml. An existing config.toml is NEVER changed.
    * Limits <DataDir> (it holds the certificate key) to SYSTEM, Administrators and the service account.
    * Registers the service. WinSW asks for the account and its password: enter -Account and its password.
      The service must run as the account that is signed in to `claude`, because the sign-in and the
      workspace-trust data live in that user's profile. SYSTEM and the built-in service accounts do not work.
    * Starts the service only when config.toml has no placeholders left and has at least one
      [[node_auth.hub_key]] or [[node_auth.secret]]. Otherwise it says what to fill in. Run it again afterwards.

  -OpenFirewall adds an inbound rule for the port in config.toml (Private and Domain networks only).
  -NoService only puts the files in place (for tests); it never changes the machine PATH, unless a test key is
  given with -PathRegistryKey. -Uninstall removes the service, the firewall rule and the PATH entry, and keeps the
  files, the config and the certificate.
#>
[CmdletBinding()]
param(
  [string]$Binary,
  [string]$Release,
  [string]$WinSW,
  [string]$ClientBinary,
  [string]$InstallDir = (Join-Path $env:ProgramFiles 'claude-rc-launcher'),
  [string]$ClientDir = (Join-Path $env:ProgramFiles 'claude-rc'),
  [string]$DataDir = (Join-Path $env:ProgramData 'claude-rc-launcher'),
  [string]$Account = [Security.Principal.WindowsIdentity]::GetCurrent().Name,
  # The registry key that holds the machine PATH. Only tests give another one.
  [string]$PathRegistryKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment',
  [switch]$OpenFirewall,
  [switch]$NoClient,
  [switch]$ClientOnly,
  [switch]$NoService,
  [switch]$Uninstall
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is much faster without the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Name = 'claude-rc-launcher'
$Repo = 'kbirger/claude-rc-launcher'
$AssetName = 'claude-rc-launcher-win-x64.exe'
$ClientAsset = 'claude-rc-windows-x64.exe'
$DefaultPathKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
# WinSW v2.12.0 WinSW-x64.exe, from https://github.com/winsw/winsw/releases/tag/v2.12.0 (hash seen on 2026-11-08).
$WinSWUrl = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'
$WinSWSha256 = '05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA'
$FirewallRule = 'claude-rc-launcher node'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$SvcExe = Join-Path $InstallDir "$Name-svc.exe"
$SvcXml = Join-Path $InstallDir "$Name-svc.xml"
$Dest = Join-Path $InstallDir "$Name.exe"
$ConfigFile = Join-Path $DataDir 'config.toml'

function Test-Admin {
  $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-Sha256([string]$Path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToUpperInvariant() }

function Assert-Executable([string]$Path, [string]$What) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 2 -or $bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) { throw "$What is not a Windows executable: $Path" }
}

function Get-Download([string]$Url, [string]$OutFile) {
  try { Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutFile } catch { throw "cannot download ${Url}: $($_.Exception.Message)" }
}

$ReleaseTagPattern = '^v?\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$'

function Get-ReleaseAsset([string]$Tag, [string]$TempDir, [string]$Asset) {
  $base = if ($Tag) { "https://github.com/$Repo/releases/download/$Tag" } else { "https://github.com/$Repo/releases/latest/download" }
  $bin = Join-Path $TempDir $Asset
  $sums = Join-Path $TempDir 'SHA256SUMS'
  Write-Host "==> Downloading $Asset ($(if ($Tag) { $Tag } else { 'latest' }))"
  Get-Download "$base/$Asset" $bin
  Get-Download "$base/SHA256SUMS" $sums
  $line = Get-Content -LiteralPath $sums | Where-Object { ($_.Trim() -split '\s+')[-1] -eq $Asset } | Select-Object -First 1
  if (-not $line -or ($line.Trim() -split '\s+')[0].ToUpperInvariant() -ne (Get-Sha256 $bin)) {
    throw "the checksum of $Asset does not match SHA256SUMS. Nothing was installed"
  }
  $bin
}

# ---- the machine PATH ---------------------------------------------------------------------------------------
# The PATH is read without expanding %VARIABLES%, and written back as an expandable string, so that entries such as
# %SystemRoot%\system32 stay as they are. An entry that is already there (any case, with or without a final \) is not
# added twice.
function Get-PathEntries([string]$KeyPath) {
  $key = Get-Item -LiteralPath $KeyPath
  $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  @($raw -split ';' | Where-Object { $_ -ne '' })
}

function Set-PathEntries([string]$KeyPath, [string[]]$Entries) {
  Set-ItemProperty -LiteralPath $KeyPath -Name Path -Value ($Entries -join ';') -Type ExpandString
}

# Returns $true when the PATH changed.
function Add-MachinePath([string]$Dir, [string]$KeyPath) {
  $want = $Dir.TrimEnd('\')
  $entries = @(Get-PathEntries $KeyPath)
  if (@($entries | Where-Object { $_.TrimEnd('\') -ieq $want }).Count -gt 0) { return $false }
  Set-PathEntries $KeyPath @($entries + $Dir)
  return $true
}

function Remove-MachinePath([string]$Dir, [string]$KeyPath) {
  $want = $Dir.TrimEnd('\')
  $entries = @(Get-PathEntries $KeyPath)
  $keep = @($entries | Where-Object { $_.TrimEnd('\') -ine $want })
  if ($keep.Count -eq $entries.Count) { return $false }
  Set-PathEntries $KeyPath $keep
  return $true
}

# ---- the claude-rc client -----------------------------------------------------------------------------------
# -ClientBinary, else dist\claude-rc.exe of a clone, else the release asset (checked against SHA256SUMS).
function Get-ClientSource([string]$TempDir) {
  $path = $ClientBinary
  if (-not $path) {
    $localClient = Join-Path $Here '..\..\dist\claude-rc.exe'
    $path = if (Test-Path -LiteralPath $localClient) { (Resolve-Path -LiteralPath $localClient).Path } else { Get-ReleaseAsset $Release $TempDir $ClientAsset }
  }
  if (-not (Test-Path -LiteralPath $path)) { throw "client binary not found: $path" }
  Assert-Executable $path 'the claude-rc client'
  $path
}

# The client lives in a folder of its own. Only administrators can write there, so a program on the PATH cannot be
# replaced by the service account (which can write to the node's install folder).
function Install-ClientAndPath([string]$Source) {
  $clientDest = Join-Path $ClientDir 'claude-rc.exe'
  try {
    New-Item -ItemType Directory -Force -Path $ClientDir | Out-Null
    Copy-Item -LiteralPath $Source -Destination "$clientDest.new" -Force
    Move-Item -LiteralPath "$clientDest.new" -Destination $clientDest -Force
    Write-Host "Installed $clientDest"
  } catch {
    Remove-Item -LiteralPath "$clientDest.new" -Force -ErrorAction SilentlyContinue
    Write-Warning "cannot install $clientDest (is claude-rc running? close it and run this script again): $($_.Exception.Message)"
  }

  $realKey = ($PathRegistryKey -eq $DefaultPathKey)
  if ($realKey -and $NoService -and -not $ClientOnly) {
    Write-Host 'The machine PATH was not changed (-NoService).'
  } elseif (-not (Test-Path -LiteralPath $clientDest)) {
    Write-Warning "the machine PATH was not changed, because $clientDest is not there"
  } elseif ($realKey -and -not (Test-Admin)) {
    Write-Warning 'the machine PATH was not changed: run this in an elevated PowerShell'
  } elseif (Add-MachinePath $ClientDir $PathRegistryKey) {
    if ($realKey) { Send-EnvironmentChange }
    Write-Host "Added $ClientDir to the machine PATH. Open a new terminal to use 'claude-rc'."
  } else {
    Write-Host "$ClientDir is already on the machine PATH"
  }
}

# Tells the running programs (Explorer, new terminals) that the environment changed. It never fails the install.
function Send-EnvironmentChange {
  try {
    if (-not ('ClaudeRc.Native' -as [type])) {
      Add-Type -Namespace ClaudeRc -Name Native -MemberDefinition '[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
    }
    $result = [UIntPtr]::Zero
    [void][ClaudeRc.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
  } catch { }
}

# The problems that keep the service from starting. Empty when config.toml is ready.
function Get-ConfigProblems([string]$Path) {
  $active = @(Get-Content -LiteralPath $Path | Where-Object { $_ -notmatch '^\s*#' })
  $problems = @()
  if ($active -match 'replace-with|example\.com|__SERVICE_USER__') { $problems += 'replace the placeholder values (example.com, replace-with-..., __SERVICE_USER__)' }
  if (-not ($active -match '^\s*\[\[node_auth\.(hub_key|secret)\]\]')) { $problems += 'enable at least one [[node_auth.hub_key]] or [[node_auth.secret]]' }
  $problems
}

function Get-NodeService { Get-Service -Name $Name -ErrorAction SilentlyContinue }

# ---- -Uninstall -------------------------------------------------------------------------------------------
if ($Uninstall) {
  if (-not (Test-Admin)) { throw 'run this in an elevated PowerShell (Run as administrator)' }
  $svc = Get-NodeService
  if ($svc) {
    if ($svc.Status -ne 'Stopped') { Stop-Service -Name $Name -Force; $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30)) }
    if (-not (Test-Path -LiteralPath $SvcExe)) { throw "the service exists but $SvcExe is missing: remove it with: sc.exe delete $Name" }
    & $SvcExe uninstall
    if ($LASTEXITCODE -ne 0) { throw "winsw uninstall failed (exit $LASTEXITCODE)" }
    Write-Host "Removed the service $Name"
  } else {
    Write-Host "No service named $Name"
  }
  if (Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue) {
    Remove-NetFirewallRule -DisplayName $FirewallRule
    Write-Host "Removed the firewall rule '$FirewallRule'"
  }
  if (Remove-MachinePath $ClientDir $PathRegistryKey) {
    Send-EnvironmentChange
    Write-Host "Removed $ClientDir from the machine PATH"
  }
  Write-Host "Kept: $InstallDir, $ClientDir, $DataDir (config, certificate, instance list). Delete them by hand to remove everything."
  return
}

# ---- checks -----------------------------------------------------------------------------------------------
if ($ClientOnly -and $NoClient) { throw '-ClientOnly and -NoClient cannot be used together' }
if ($ClientOnly) {
  # Only the client and the PATH. The machine PATH needs administrator rights.
  if ($PathRegistryKey -eq $DefaultPathKey -and -not (Test-Admin)) { throw 'run this in an elevated PowerShell (Run as administrator)' }
  if ($Release -and $Release -notmatch $ReleaseTagPattern) { throw "invalid release tag: $Release (for example v1.2.3)" }
  $tempClient = Join-Path ([IO.Path]::GetTempPath()) ("$Name-client-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tempClient | Out-Null
  try { Install-ClientAndPath (Get-ClientSource $tempClient) } finally { Remove-Item -LiteralPath $tempClient -Recurse -Force -ErrorAction SilentlyContinue }
  return
}
if (-not $NoService -and -not (Test-Admin)) { throw 'run this in an elevated PowerShell (Run as administrator)' }
if ($Account -match '^(NT AUTHORITY\\|NT SERVICE\\)|^(SYSTEM|LOCAL SERVICE|NETWORK SERVICE)$') {
  throw "the service must run as a user account that is signed in to claude, not '$Account'"
}
$ShortUser = ($Account -split '\\')[-1]
if ($Release -and $Release -notmatch $ReleaseTagPattern) { throw "invalid release tag: $Release (for example v1.2.3)" }

$temp = Join-Path ([IO.Path]::GetTempPath()) ("$Name-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  # ---- get the files --------------------------------------------------------------------------------------
  if (-not $Binary) {
    $local = Join-Path $Here "..\..\dist\$AssetName"
    $Binary = if (Test-Path -LiteralPath $local) { (Resolve-Path -LiteralPath $local).Path } else { Get-ReleaseAsset $Release $temp $AssetName }
  }
  if (-not (Test-Path -LiteralPath $Binary)) { throw "binary not found: $Binary" }
  Assert-Executable $Binary 'the binary'

  if (-not $NoClient) { $clientSource = Get-ClientSource $temp }

  if (-not $WinSW) {
    $WinSW = Join-Path $temp 'WinSW-x64.exe'
    Write-Host '==> Downloading WinSW v2.12.0'
    Get-Download $WinSWUrl $WinSW
    if ((Get-Sha256 $WinSW) -ne $WinSWSha256) { throw 'WinSW does not match the pinned SHA-256. Nothing was installed' }
  } elseif (-not (Test-Path -LiteralPath $WinSW)) {
    throw "WinSW not found: $WinSW"
  }
  Assert-Executable $WinSW 'WinSW'

  $template = Join-Path $Here "$Name.xml"
  $example = Join-Path $Here 'node.config.example.toml'
  $launcher = Join-Path $Here "$Name-run.ps1"
  foreach ($f in @($template, $example, $launcher)) {
    if (-not (Test-Path -LiteralPath $f)) { throw "$f missing (run from a full checkout)" }
  }

  # ---- stop the service so its files can be replaced ------------------------------------------------------
  $svc = Get-NodeService
  $wasRunning = $false
  if ($svc -and -not $NoService -and $svc.Status -ne 'Stopped') {
    $wasRunning = $true
    Write-Host "==> Stopping $Name"
    Stop-Service -Name $Name -Force
    $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
  }

  # ---- place the files ------------------------------------------------------------------------------------
  New-Item -ItemType Directory -Force -Path $InstallDir, $DataDir, (Join-Path $DataDir 'logs') | Out-Null
  # Write next to the destination, then move over it, so a failed copy never leaves half a file.
  foreach ($pair in @(@($Binary, $Dest), @($WinSW, $SvcExe))) {
    $tmp = "$($pair[1]).new"
    Copy-Item -LiteralPath $pair[0] -Destination $tmp -Force
    Move-Item -LiteralPath $tmp -Destination $pair[1] -Force
  }
  Write-Host "Installed $Dest"

  $xml = [IO.File]::ReadAllText($template)
  $xml = $xml.Replace('@CONFIG@', [Security.SecurityElement]::Escape($ConfigFile)).Replace('@DATA_DIR@', [Security.SecurityElement]::Escape($DataDir))
  [IO.File]::WriteAllText($SvcXml, $xml, (New-Object Text.UTF8Encoding($false)))
  Write-Host "Wrote $SvcXml"
  Copy-Item -LiteralPath $launcher -Destination (Join-Path $InstallDir "$Name-run.ps1") -Force
  Write-Host "Installed the launcher script $Name-run.ps1"

  # The agent updates itself: it renames its own .exe and puts the new one in place, so the service account needs to
  # change files in the install folder. The inherited permissions stay as they are.
  & icacls.exe $InstallDir /grant "${Account}:(OI)(CI)M" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls failed on $InstallDir (is '$Account' a valid account name?)" }

  if (-not (Test-Path -LiteralPath $ConfigFile)) {
    $conf = [IO.File]::ReadAllText($example).Replace('__SERVICE_USER__', $ShortUser)
    [IO.File]::WriteAllText($ConfigFile, $conf, (New-Object Text.UTF8Encoding($false)))
    Write-Host "Created $ConfigFile (contains no secrets)"
  } else {
    Write-Host "Keeping existing $ConfigFile"
  }

  # The data folder holds the certificate key: only SYSTEM, Administrators and the service account.
  & icacls.exe $DataDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "${Account}:(OI)(CI)M" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls failed on $DataDir (is '$Account' a valid account name?)" }

  # ---- the claude-rc client, and the PATH -----------------------------------------------------------------
  if (-not $NoClient) { Install-ClientAndPath $clientSource }

  if ($NoService) {
    Write-Host 'Files are in place (-NoService): no service was registered or started.'
    return
  }

  # ---- register the service -------------------------------------------------------------------------------
  if (-not $svc) {
    Write-Host ''
    Write-Host "==> Registering the service. WinSW asks for the account and its password:"
    Write-Host "    enter  $Account  and its Windows password."
    & $SvcExe install /p
    if ($LASTEXITCODE -ne 0) { throw "winsw install failed (exit $LASTEXITCODE)" }
    $start = (Get-CimInstance Win32_Service -Filter "Name='$Name'").StartName
    if ($start -and (($start -split '\\')[-1] -ne $ShortUser)) {
      Write-Warning "the service runs as '$start', not '$Account'. The agent will refuse to start unless instance.service_user matches."
    }
  } else {
    # WinSW 2.x cannot update a registered service. The XML (arguments, logs, stop timeout) is read at each
    # start, so a new XML applies now. The account and the recovery actions are fixed at install time.
    Write-Host "The service is already registered: its account and recovery actions stay as they are."
    Write-Host "To change them, run .\install.ps1 -Uninstall, then this script again."
  }

  # ---- firewall (opt in) ----------------------------------------------------------------------------------
  if ($OpenFirewall) {
    $port = 8443
    $m = Select-String -LiteralPath $ConfigFile -Pattern '^\s*port\s*=\s*(\d+)' | Select-Object -First 1
    if ($m) { $port = [int]$m.Matches[0].Groups[1].Value }
    if (-not (Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -DisplayName $FirewallRule -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -Program $Dest -Profile Private, Domain | Out-Null
      Write-Host "Added the firewall rule '$FirewallRule' (TCP $port, Private and Domain networks)"
    } else {
      Write-Host "Keeping the existing firewall rule '$FirewallRule'. If you changed the port, update it by hand."
    }
  }

  # ---- start it, when the config is ready -----------------------------------------------------------------
  $problems = @(Get-ConfigProblems $ConfigFile)
  if ($problems.Count -gt 0) {
    Write-Host ''
    Write-Host "The service is installed but not started. Edit $ConfigFile :"
    $problems | ForEach-Object { Write-Host "  - $_" }
    Write-Host 'Then run this script again.'
    return
  }
  Write-Host "==> Starting $Name"
  Start-Service -Name $Name
  (Get-Service -Name $Name).WaitForStatus('Running', [TimeSpan]::FromSeconds(15))
  Start-Sleep -Seconds 3  # a start that fails on bad config exits at once, and WinSW then restarts it
  $state = (Get-Service -Name $Name).Status
  Write-Host "$Name is $state."
  if ($state -ne 'Running') {
    Write-Warning "see $(Join-Path $DataDir 'logs')\$Name-svc.err.log"
  } else {
    Write-Host "Logs: $(Join-Path $DataDir 'logs')"
    Write-Host "Next: copy $(Join-Path $DataDir 'node-cert.pem') to the hub (its ca_file), register the node with 'claude-rc host add', then check it with 'claude-rc hosts'."
  }
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}

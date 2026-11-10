<#
.SYNOPSIS
  Installs claude-rc-launcher as a Windows node service (WinSW) and starts it once the config is ready.

.DESCRIPTION
  Run in an elevated PowerShell (Windows PowerShell 5.1 or PowerShell 7). One line, from the latest release:

    irm https://github.com/kbirger/claude-rc-launcher/releases/latest/download/install.ps1 | iex

  `| iex` cannot take parameters. Use environment variables instead (CLAUDE_RC_RELEASE=v1.2.3, CLAUDE_RC_CLIENT_ONLY=1,
  CLAUDE_RC_NO_CLIENT=1, CLAUDE_RC_OPEN_FIREWALL=1), or run it as a script block:

    & ([scriptblock]::Create((irm <url>))) -ClientOnly

  A lone install.ps1 (this file, without the files of the release zip next to it) downloads the release zip, checks it
  against SHA256SUMS and runs the install.ps1 inside. From a clone or an unpacked zip it uses the files next to it:

    .\install.ps1 [-Binary <exe>] [-Release v1.2.3] [-Account DOMAIN\user] [-InstallDir <folder>] [-OpenFirewall] [-NoClient]
    .\install.ps1 -ClientOnly [-Release v1.2.3]      only the claude-rc client and the PATH (no node, no service)
    .\install.ps1 -Uninstall

  What it does, in order:
    * Gets claude-rc-launcher-win-x64.exe: -Binary, else .\..\..\dist\, else the GitHub release (the latest, or
      -Release). A download is checked against the SHA256SUMS of the same release.
    * Gets the command-line client the same way (-ClientBinary, else .\..\..\dist\claude-rc.exe, else the release asset
      claude-rc-windows-x64.exe), installs it as <InstallDir>\bin\claude-rc.exe, adds <InstallDir>\bin to the machine
      PATH and records the path in the registry value HKLM\SOFTWARE\claude-rc, Client (the node reads it to find the
      client). Open a new terminal afterwards. -NoClient skips all three. Only administrators can write under
      HKLM\SOFTWARE, so a user cannot make the node run another program. <InstallDir>\bin gets no extra rights: the
      service account cannot replace a program on the PATH.
    * Gets WinSW (the Windows service wrapper) v2.12.0 and checks it against a pinned SHA-256.
    * Copies both into <InstallDir>\service, with the launcher script, and writes the WinSW definition next to them.
      The service account gets Modify rights on that folder only: the agent updates its own binary there. The binary is
      written as a new file and moved over the old one, after the service is stopped.
      -InstallDir is the one parent folder (default C:\Program Files\claude-rc). An older install keeps its service in
      C:\Program Files\claude-rc-launcher: when -InstallDir is not given, that folder holds the service and <InstallDir>\service
      does not exist yet, the service stays there. The client still goes to <InstallDir>\bin. The old client
      <InstallDir>\claude-rc.exe is deleted and its PATH entry is replaced by <InstallDir>\bin.
    * Creates <DataDir>\config.toml from node.config.example.toml. An existing config.toml is NEVER changed.
    * Limits <DataDir> (it holds the certificate key) to SYSTEM, Administrators and the service account.
    * Registers the service. WinSW asks for the account and its password: enter -Account and its password.
      The service must run as the account that is signed in to `claude`, because the sign-in and the
      workspace-trust data live in that user's profile. SYSTEM and the built-in service accounts do not work.
    * Starts the service only when config.toml has no placeholders left and has at least one
      [[node_auth.hub_key]] or [[node_auth.secret]]. Otherwise it says what to fill in. Run it again afterwards.

  -OpenFirewall adds an inbound rule for the port in config.toml (Private and Domain networks only).
  -NoService only puts the files in place (for tests); it never changes the machine PATH or the registry value Client,
  unless a test key is given with -PathRegistryKey or -ClientRegistryKey. -ClientRegistryKey names another registry key for the client value (tests only).
  -Uninstall removes the service, the firewall rule and both PATH entries (<InstallDir>\bin and the old <InstallDir>),
  and keeps the files, the registry value, the config and the certificate.
#>
[CmdletBinding()]
param(
  [string]$Binary,
  [string]$Release,
  [string]$WinSW,
  [string]$ClientBinary,
  # The one parent folder: bin (the client, on the PATH) and service (the node, WinSW, the launcher script).
  [string]$InstallDir = (Join-Path $env:ProgramFiles 'claude-rc'),
  [string]$DataDir = (Join-Path $env:ProgramData 'claude-rc-launcher'),
  [string]$Account = [Security.Principal.WindowsIdentity]::GetCurrent().Name,
  # The registry key that holds the machine PATH. Only tests give another one.
  [string]$PathRegistryKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment',
  # The registry key whose value Client holds the path of the client. The node reads it. Only tests give another one.
  [string]$ClientRegistryKey = 'HKLM:\SOFTWARE\claude-rc',
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

# `irm <url> | iex` cannot pass parameters, so the main options can also be given as environment variables:
# CLAUDE_RC_RELEASE=v1.2.3, CLAUDE_RC_CLIENT_ONLY=1, CLAUDE_RC_NO_CLIENT=1, CLAUDE_RC_OPEN_FIREWALL=1.
# A parameter that is given on the command line always wins.
function Get-EnvFlag([string]$Var) {
  $v = [Environment]::GetEnvironmentVariable($Var)
  return [bool]($v -and ($v -notin @('0', 'false', 'no')))
}
$envRelease = [Environment]::GetEnvironmentVariable('CLAUDE_RC_RELEASE')
if (-not $PSBoundParameters.ContainsKey('Release') -and $envRelease) { $Release = $envRelease; $PSBoundParameters['Release'] = $envRelease }
if (-not $PSBoundParameters.ContainsKey('ClientOnly') -and (Get-EnvFlag 'CLAUDE_RC_CLIENT_ONLY')) { $ClientOnly = [switch]$true; $PSBoundParameters['ClientOnly'] = $ClientOnly }
if (-not $PSBoundParameters.ContainsKey('NoClient') -and (Get-EnvFlag 'CLAUDE_RC_NO_CLIENT')) { $NoClient = [switch]$true; $PSBoundParameters['NoClient'] = $NoClient }
if (-not $PSBoundParameters.ContainsKey('OpenFirewall') -and (Get-EnvFlag 'CLAUDE_RC_OPEN_FIREWALL')) { $OpenFirewall = [switch]$true; $PSBoundParameters['OpenFirewall'] = $OpenFirewall }

$Name = 'claude-rc-launcher'
$Repo = 'kbirger/claude-rc-launcher'
$AssetName = 'claude-rc-launcher-win-x64.exe'
$ClientAsset = 'claude-rc-windows-x64.exe'
$DefaultPathKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
$DefaultClientKey = 'HKLM:\SOFTWARE\claude-rc'
# WinSW v2.12.0 WinSW-x64.exe, from https://github.com/winsw/winsw/releases/tag/v2.12.0 (hash seen on 2026-11-08).
$WinSWUrl = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'
$WinSWSha256 = '05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA'
$FirewallRule = 'claude-rc-launcher node'

# The folder of this file, or '' when the script did not start from a file (irm <url> | iex).
$Here = [string](Get-Variable -Name PSScriptRoot -ValueOnly -ErrorAction SilentlyContinue)
$InstallerAsset = 'claude-rc-launcher-win-installer.zip'
$ClientDir = Join-Path $InstallDir 'bin'
$ServiceDir = Join-Path $InstallDir 'service'
# An older install keeps its service in Program Files\claude-rc-launcher. Moving a running service needs an uninstall,
# so a reinstall without -InstallDir keeps it there.
# This applies only while the service is registered there: after -Uninstall a new install uses the new layout.
$OldServiceExe = Join-Path $env:ProgramFiles "claude-rc-launcher\$Name-svc.exe"

# The folder of the program that the registered service runs, or '' when there is no service. The PathName may be
# quoted ("C:\Program Files\x\svc.exe" arg) or not.
function Get-RegisteredServiceDir {
  $cim = Get-CimInstance Win32_Service -Filter "Name='$Name'" -ErrorAction SilentlyContinue
  if (-not $cim -or -not $cim.PathName) { return '' }
  $pn = [string]$cim.PathName
  $exe = if ($pn.StartsWith('"')) { ($pn -split '"')[1] } elseif ($pn -match '^(.*?\.exe)(\s|$)') { $Matches[1] } else { $pn }
  return (Split-Path -Parent $exe)
}
$RegisteredDir = Get-RegisteredServiceDir
if (-not $PSBoundParameters.ContainsKey('InstallDir') -and $RegisteredDir -and
    $RegisteredDir.TrimEnd('\') -ieq (Split-Path -Parent $OldServiceExe).TrimEnd('\') -and
    (Test-Path -LiteralPath $OldServiceExe) -and -not (Test-Path -LiteralPath $ServiceDir)) {
  $ServiceDir = Split-Path -Parent $OldServiceExe
}
# The default parent folder. Only this folder (or one that holds the old client) is taken off the machine PATH.
$DefaultInstallDir = (Join-Path $env:ProgramFiles 'claude-rc').TrimEnd('\')
$SvcExe = Join-Path $ServiceDir "$Name-svc.exe"
$SvcXml = Join-Path $ServiceDir "$Name-svc.xml"
$Dest = Join-Path $ServiceDir "$Name.exe"
$ConfigFile = Join-Path $DataDir 'config.toml'

function Test-Admin {
  $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Uses .NET directly, not Get-FileHash: no module has to load for a security check, and the file is streamed.
function Get-Sha256([string]$Path) {
  $sha = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($Path)
  try { return ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '') }
  finally { $stream.Dispose(); $sha.Dispose() }
}

function Assert-Executable([string]$Path, [string]$What) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 2 -or $bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) { throw "$What is not a Windows executable: $Path" }
}

function Get-Download([string]$Url, [string]$OutFile) {
  try { Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutFile } catch { throw "cannot download ${Url}: $($_.Exception.Message)" }
}

$ReleaseTagPattern = '^v?\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$'

function Get-ReleaseAsset([string]$Tag, [string]$TempDir, [string]$Asset) {
  # CLAUDE_RC_RELEASE_BASE points at a mirror (or a test server) that serves the release files. It is not needed normally.
  $base = if ($env:CLAUDE_RC_RELEASE_BASE) { $env:CLAUDE_RC_RELEASE_BASE.TrimEnd('/') }
          elseif ($Tag) { "https://github.com/$Repo/releases/download/$Tag" }
          else { "https://github.com/$Repo/releases/latest/download" }
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
    $localClient = if ($Here) { Join-Path $Here '..\..\dist\claude-rc.exe' } else { '' }
    $path = if ($localClient -and (Test-Path -LiteralPath $localClient)) { (Resolve-Path -LiteralPath $localClient).Path } else { Get-ReleaseAsset $Release $TempDir $ClientAsset }
  }
  if (-not (Test-Path -LiteralPath $path)) { throw "client binary not found: $path" }
  Assert-Executable $path 'the claude-rc client'
  $path
}

# Records the client path in the registry value Client (REG_SZ) that the node reads. Only administrators can write under
# HKLM\SOFTWARE by default, so no user can make the node run another program. A failure here is a warning: the client is
# installed and the node still finds it by scanning.
function Register-Client([string]$ClientPath) {
  try {
    # A 32-bit PowerShell on 64-bit Windows would write to the 32-bit view, which the node does not read.
    if ($ClientRegistryKey -eq $DefaultClientKey -and [Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
      Write-Warning 'the client registry value was not written: this is a 32-bit PowerShell. Run the 64-bit one (the node scans for the client anyway)'
      return
    }
    if (-not (Test-Path -LiteralPath $ClientRegistryKey)) { New-Item -Path $ClientRegistryKey -Force | Out-Null }
    Set-ItemProperty -LiteralPath $ClientRegistryKey -Name Client -Value $ClientPath -Type String
    Write-Host "Registered $ClientPath in $ClientRegistryKey (Client)"
  } catch {
    Write-Warning "cannot write the client registry value $ClientRegistryKey (the client is installed; the node still finds it by scanning): $($_.Exception.Message)"
  }
}

# The client lives in <InstallDir>\bin. Only administrators can write there, so a program on the PATH cannot be
# replaced by the service account (which can write only to <InstallDir>\service).
function Install-ClientAndPath([string]$Source) {
  $clientDest = Join-Path $ClientDir 'claude-rc.exe'
  # The old layout put the client straight in <InstallDir>. It is deleted, and that folder leaves the PATH. This happens on every run for the default folder, and for another
  # -InstallDir only while the old client is there.
  $oldClient = Join-Path $InstallDir 'claude-rc.exe'
  $hadOldClient = Test-Path -LiteralPath $oldClient
  $dropOldPath = $hadOldClient -or ($InstallDir.TrimEnd('\') -ieq $DefaultInstallDir)
  try {
    New-Item -ItemType Directory -Force -Path $ClientDir | Out-Null
    # bin is on the machine PATH, so only SYSTEM and Administrators write there, whatever -InstallDir is (even the old
    # service folder, where the service account has Modify rights that bin would inherit).
    & icacls.exe $ClientDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls failed on $ClientDir" }
    Copy-Item -LiteralPath $Source -Destination "$clientDest.new" -Force
    Move-Item -LiteralPath "$clientDest.new" -Destination $clientDest -Force
    Write-Host "Installed $clientDest"
    if ($NoService -and -not $ClientOnly -and $ClientRegistryKey -eq $DefaultClientKey) {
      Write-Host 'The client registry value was not written (-NoService).'
    } else {
      Register-Client $clientDest
    }
  } catch {
    Remove-Item -LiteralPath "$clientDest.new" -Force -ErrorAction SilentlyContinue
    Write-Warning "cannot install $clientDest (is claude-rc running? close it and run this script again): $($_.Exception.Message)"
  }
  if (Test-Path -LiteralPath $clientDest) {
    try {
      if (Test-Path -LiteralPath $oldClient) {
        Remove-Item -LiteralPath $oldClient -Force
        Write-Host "Removed the old client $oldClient"
      }
    } catch {
      Write-Warning "could not remove the old client ${oldClient}: $($_.Exception.Message)"
    }
  }

  $realKey = ($PathRegistryKey -eq $DefaultPathKey)
  if ($realKey -and $NoService -and -not $ClientOnly) {
    Write-Host 'The machine PATH was not changed (-NoService).'
  } elseif (-not (Test-Path -LiteralPath $clientDest)) {
    Write-Warning "the machine PATH was not changed, because $clientDest is not there"
  } elseif ($realKey -and -not (Test-Admin)) {
    Write-Warning 'the machine PATH was not changed: run this in an elevated PowerShell'
  } else {
    $changed = $false
    if ($dropOldPath -and (Remove-MachinePath $InstallDir $PathRegistryKey)) {
      $changed = $true
      Write-Host "Removed $InstallDir from the machine PATH (the client moved to $ClientDir)"
    }
    if (Add-MachinePath $ClientDir $PathRegistryKey) {
      $changed = $true
      Write-Host "Added $ClientDir to the machine PATH. Open a new terminal to use 'claude-rc'."
    } else {
      Write-Host "$ClientDir is already on the machine PATH"
    }
    if ($changed -and $realKey) { Send-EnvironmentChange }
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
  $oldDirs = @($ClientDir)
  if ((Test-Path -LiteralPath (Join-Path $InstallDir 'claude-rc.exe')) -or ($InstallDir.TrimEnd('\') -ieq $DefaultInstallDir)) { $oldDirs += $InstallDir }
  foreach ($dir in $oldDirs) {
    if (Remove-MachinePath $dir $PathRegistryKey) {
      if ($PathRegistryKey -eq $DefaultPathKey) { Send-EnvironmentChange }
      Write-Host "Removed $dir from the machine PATH"
    }
  }
  Write-Host "Kept: the files in $InstallDir and $ServiceDir, the registry value Client in $ClientRegistryKey, and $DataDir (config, certificate, instance list). Delete them by hand to remove everything."
  return
}

# ---- checks -----------------------------------------------------------------------------------------------
if ($ClientOnly -and $NoClient) { throw '-ClientOnly and -NoClient cannot be used together' }
if ($ClientOnly) {
  # Only the client, the PATH and the registry value. The machine PATH needs administrator rights.
  if ($PathRegistryKey -eq $DefaultPathKey -and -not (Test-Admin)) { throw 'run this in an elevated PowerShell (Run as administrator)' }
  if ($Release -and $Release -notmatch $ReleaseTagPattern) { throw "invalid release tag: $Release (for example v1.2.3)" }
  $tempClient = Join-Path ([IO.Path]::GetTempPath()) ("$Name-client-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tempClient | Out-Null
  try { Install-ClientAndPath (Get-ClientSource $tempClient) } finally { Remove-Item -LiteralPath $tempClient -Recurse -Force -ErrorAction SilentlyContinue }
  return
}

# ---- started without the files next to it: fetch them -------------------------------------------------------
# `irm <url> | iex`, or a lone install.ps1 that was downloaded by itself, has no XML, launcher or example config next to
# it. The release zip has them. It is checked against SHA256SUMS, unpacked, and its own install.ps1 does the work with
# the same options.
$sideFiles = @("$Name.xml", "$Name-run.ps1", 'node.config.example.toml')
$haveSideFiles = $Here -and (@($sideFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $Here $_)) }).Count -eq 0)
if (-not $haveSideFiles) {
  if (-not $NoService -and -not (Test-Admin)) { throw 'run this in an elevated PowerShell (Run as administrator)' }
  if ($Release -and $Release -notmatch $ReleaseTagPattern) { throw "invalid release tag: $Release (for example v1.2.3)" }
  $bootTemp = Join-Path ([IO.Path]::GetTempPath()) ("$Name-installer-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $bootTemp | Out-Null
  try {
    $zipFile = Get-ReleaseAsset $Release $bootTemp $InstallerAsset
    $unpacked = Join-Path $bootTemp 'installer'
    Expand-Archive -LiteralPath $zipFile -DestinationPath $unpacked -Force
    foreach ($f in @('install.ps1') + $sideFiles) {
      if (-not (Test-Path -LiteralPath (Join-Path $unpacked $f))) { throw "$InstallerAsset does not contain $f" }  # also stops a loop
    }
    $forward = @{}
    foreach ($k in $PSBoundParameters.Keys) { $forward[$k] = $PSBoundParameters[$k] }
    & (Join-Path $unpacked 'install.ps1') @forward
  } finally {
    Remove-Item -LiteralPath $bootTemp -Recurse -Force -ErrorAction SilentlyContinue
  }
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
  if ($svc -and -not $NoService) {
    $runsFrom = Get-RegisteredServiceDir
    if ($runsFrom -and $runsFrom.TrimEnd('\') -ine $ServiceDir.TrimEnd('\')) {
      throw "the service runs from $runsFrom, not from $ServiceDir. Run without -InstallDir to keep it there, or run -Uninstall first and delete that folder"
    }
  }
  $wasRunning = $false
  if ($svc -and -not $NoService -and $svc.Status -ne 'Stopped') {
    $wasRunning = $true
    Write-Host "==> Stopping $Name"
    Stop-Service -Name $Name -Force
    $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
  }

  # ---- place the files ------------------------------------------------------------------------------------
  New-Item -ItemType Directory -Force -Path $ServiceDir, $DataDir, (Join-Path $DataDir 'logs') | Out-Null
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
  Copy-Item -LiteralPath $launcher -Destination (Join-Path $ServiceDir "$Name-run.ps1") -Force
  Write-Host "Installed the launcher script $Name-run.ps1"

  # The agent updates itself: it renames its own .exe and puts the new one in place, so the service account needs to
  # change files in the service folder, and only there (not in <InstallDir> or bin). The inherited permissions stay.
  & icacls.exe $ServiceDir /grant "${Account}:(OI)(CI)M" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls failed on $ServiceDir (is '$Account' a valid account name?)" }

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
    Write-Host 'Then run the same install command again.'
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

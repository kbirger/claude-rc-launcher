<#
.SYNOPSIS
  Starts the claude-rc-launcher agent for the Windows service, and rolls back an update that does not stay up.

.DESCRIPTION
  WinSW 2.x has no start hook, so WinSW runs this script and this script runs the agent (see claude-rc-launcher.xml).
  This is the Windows counterpart of the watchdog in server/src/serviceupdate.ts.

  An update works like this:
    1. The agent puts the new binary in place (the old one stays as <exe>.prev) and writes
       <DataDir>\update-pending.json with "starts": 0. Then it exits with a non-zero code.
    2. WinSW restarts the service (restart on failure), and this script starts the new agent.
       Every start that finds the file counts one in "starts".
    3. The new agent deletes the file when it has run for 30 seconds: the update is kept.
    4. If the file is still there after $MaxStarts starts, the new agent does not stay up. This script then moves
       <exe>.prev back over <exe>, deletes the file and starts the old agent.

  The script returns the exit code of the agent, so that WinSW sees a failure as a failure. Messages go to
  <DataDir>\logs\update.log.
#>
param(
  [Parameter(Mandatory)][string]$Exe,
  [Parameter(Mandatory)][string]$Config,
  [Parameter(Mandatory)][string]$DataDir,
  [int]$MaxStarts = 3
)

$ErrorActionPreference = 'Stop'

function Write-UpdateLog([string]$Message) {
  try {
    $dir = Join-Path $DataDir 'logs'
    [IO.Directory]::CreateDirectory($dir) | Out-Null
    Add-Content -LiteralPath (Join-Path $dir 'update.log') -Value ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'), $Message)
  } catch { }  # a log that cannot be written must never keep the service from starting
}

$pending = Join-Path $DataDir 'update-pending.json'
if (Test-Path -LiteralPath $pending) {
  try {
    $p = Get-Content -LiteralPath $pending -Raw | ConvertFrom-Json
    $starts = 1 + [int]$p.starts
    if ($starts -le $MaxStarts) {
      $p | Add-Member -NotePropertyName starts -NotePropertyValue $starts -Force
      $tmp = "$pending.tmp"
      [IO.File]::WriteAllText($tmp, ($p | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
      Move-Item -LiteralPath $tmp -Destination $pending -Force
      Write-UpdateLog "update to $($p.to) is not confirmed yet: start $starts of $MaxStarts"
    } else {
      $prev = "$Exe.prev"
      if (Test-Path -LiteralPath $prev) {
        Move-Item -LiteralPath $prev -Destination $Exe -Force
        Write-UpdateLog "update to $($p.to) did not stay up: restored $prev"
      } else {
        Write-UpdateLog "update to $($p.to) did not stay up, but $prev is missing: nothing was restored"
      }
      Remove-Item -LiteralPath $pending -Force
    }
  } catch {
    Write-UpdateLog "cannot use $pending ($($_.Exception.Message)): removed it"
    Remove-Item -LiteralPath $pending -Force -ErrorAction SilentlyContinue
  }
}

# The agent inherits this process's output handles (UseShellExecute is false and nothing is redirected), so WinSW's log
# capture sees the agent's bytes unchanged. Start-Process -PassThru is not used: when the agent ends within
# milliseconds, its ExitCode can come back empty and this script would exit 0, which WinSW does not restart.
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $Exe
$psi.Arguments = '--config "{0}"' -f $Config
$psi.UseShellExecute = $false
$agent = [System.Diagnostics.Process]::Start($psi)
$agent.WaitForExit()
$code = $agent.ExitCode
if ($null -eq $code) { $code = 1 }
exit $code

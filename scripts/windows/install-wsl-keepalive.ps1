<#
.SYNOPSIS
  Keep WSL running from Windows logon, so notesd (a systemd user service inside the distro)
  is up without a terminal open.

.DESCRIPTION
  Registers a Task Scheduler task, triggered at logon of the current user, that runs
  "wsl.exe -d <Distro> -- sleep infinity" inside a headless console (no window). The attached
  wsl.exe keeps the distro from being shut down by WSL's idle timeout. See docs/INSTALL.md.

  Run from Windows PowerShell:
    powershell -NoProfile -ExecutionPolicy Bypass -File \\wsl.localhost\Ubuntu\home\<you>\mcp-notes\scripts\windows\install-wsl-keepalive.ps1
  If registration fails with "Access is denied", run the same command from an elevated
  PowerShell (Run as administrator). The task still runs as you, not as an administrator.

.PARAMETER Distro
  WSL distribution name, as listed by "wsl -l". Default: Ubuntu.

.PARAMETER TaskName
  Task Scheduler task name. Default: "mcp-notes WSL keepalive".

.PARAMETER Uninstall
  Stop and remove the task instead of registering it.

.PARAMETER NoStart
  Register the task but do not start it now (it starts at the next logon).
#>
[CmdletBinding()]
param(
  [string]$Distro = 'Ubuntu',
  [string]$TaskName = 'mcp-notes WSL keepalive',
  [switch]$Uninstall,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($Uninstall) {
  if ($existing) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed task '$TaskName'. Any running 'sleep infinity' ends with: wsl.exe -d $Distro -- pkill -x sleep"
  } else {
    Write-Host "No task named '$TaskName'."
  }
  return
}

$wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
if (-not (Test-Path $wsl)) { throw "wsl.exe not found at $wsl" }
if (-not (Test-Path $conhost)) { throw "conhost.exe not found at $conhost" }

$env:WSL_UTF8 = '1'
$distros = @(& $wsl --list --quiet | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ })
if ($distros -notcontains $Distro) {
  throw "WSL distro '$Distro' not found. Installed: $($distros -join ', ')"
}

$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$action = New-ScheduledTaskAction -Execute $conhost `
  -Argument "--headless `"$wsl`" -d `"$Distro`" -- sleep infinity"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -Hidden

try {
  Register-ScheduledTask -TaskName $TaskName `
    -Description "Keeps WSL distro '$Distro' running from logon so the mcp-notes daemon (notesd) stays up. Runs: wsl.exe -d $Distro -- sleep infinity (headless)." `
    -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
} catch [System.UnauthorizedAccessException] {
  throw "Access denied registering '$TaskName'. Re-run this script from an elevated PowerShell (Run as administrator)."
} catch {
  if ($_.Exception.HResult -eq -2147024891) {
    throw "Access denied registering '$TaskName'. Re-run this script from an elevated PowerShell (Run as administrator)."
  }
  throw
}

Write-Host "Registered task '$TaskName' for $user (at logon): wsl.exe -d $Distro -- sleep infinity, headless."

if (-not $NoStart) {
  $state = (Get-ScheduledTask -TaskName $TaskName).State
  if ($state -ne 'Running') {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Started it now."
  } else {
    Write-Host "Already running."
  }
}

Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State | Format-Table -AutoSize

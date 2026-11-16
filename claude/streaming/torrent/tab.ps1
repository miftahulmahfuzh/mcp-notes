# Opens a tab on one torrent site in the streaming Chrome, out of sight, for claude/streaming/torrent.
# When Chrome is up and has no tab on the site, the tab is created in the background
# (Target.createTarget background:true): no window is raised, restored or activated, so a film
# playing in this Chrome stays in front. When Chrome is not running it is started minimized on the
# site. cdp.ps1 then finds that tab and evaluates in it; on its own it would open a missing tab in
# front. Prints one line of JSON: {"ok":true,"created":<bool>} or {"cdp_error":<code>,"detail":...}.
# The same profile, port and switches as cdp.ps1. WSL cannot reach Windows loopback, which is why
# this half is PowerShell.
param(
  [Parameter(Mandatory = $true)][string]$Origin,
  [int]$Port = 9333,
  [int]$TimeoutS = 20
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$ProfileName = 'notesd-stream-chrome'

function Fail([string]$code, [string]$detail) {
  Write-Output (@{ cdp_error = $code; detail = $detail } | ConvertTo-Json -Compress)
  exit 3
}

function Test-Chrome {
  try { Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 3 | Out-Null; return $true } catch { return $false }
}

# Windows PowerShell hands the JSON array back as one object; the pipe unrolls it.
function Get-Targets {
  try { Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 3 | ForEach-Object { $_ } } catch { }
}

function Get-HostOf([string]$url) {
  try { return ([Uri]$url).Host } catch { return '' }
}

$originHost = ([Uri]$Origin).Host
$deadline = (Get-Date).AddSeconds($TimeoutS)

if (-not (Test-Chrome)) {
  $chrome = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if (-not $chrome) { Fail 'no_chrome' 'chrome.exe was not found' }
  # Chrome refuses a debugging port on the default profile, so this one has its own folder.
  $profileDir = Join-Path $env:LOCALAPPDATA $ProfileName
  Start-Process -FilePath $chrome -WindowStyle Minimized -ArgumentList @(
    "--remote-debugging-port=$Port", "--user-data-dir=`"$profileDir`"",
    '--no-first-run', '--no-default-browser-check', '--start-minimized',
    '--disable-features=CalculateNativeWinOcclusion', $Origin
  )
  while (-not (Test-Chrome)) {
    if ((Get-Date) -gt $deadline) { Fail 'chrome_not_reachable' "nothing answers on port $Port" }
    Start-Sleep -Milliseconds 500
  }
  Write-Output (@{ ok = $true; created = $true } | ConvertTo-Json -Compress)
  exit 0
}

$onSite = @(Get-Targets | Where-Object { $_.type -eq 'page' -and (Get-HostOf $_.url) -eq $originHost })
if ($onSite.Count -gt 0) {
  Write-Output (@{ ok = $true; created = $false } | ConvertTo-Json -Compress)
  exit 0
}

try {
  $version = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 3
  $cts = New-Object System.Threading.CancellationTokenSource
  $cts.CancelAfter([Math]::Max(5, [int]($deadline - (Get-Date)).TotalSeconds) * 1000)
  $socket = New-Object System.Net.WebSockets.ClientWebSocket
  $socket.ConnectAsync([Uri]$version.webSocketDebuggerUrl, $cts.Token).Wait()
  # background: the tab opens behind the active one; no window is raised or restored.
  $msg = @{ id = 1; method = 'Target.createTarget'; params = @{ url = $Origin; background = $true } } | ConvertTo-Json -Depth 4 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($msg)
  $socket.SendAsync((New-Object System.ArraySegment[byte] -ArgumentList @(, $bytes)), 'Text', $true, $cts.Token).Wait()
  $buf = New-Object byte[] 65536
  while ($true) {
    $ms = New-Object IO.MemoryStream
    do {
      $seg = New-Object System.ArraySegment[byte] -ArgumentList @(, $buf)
      $r = $socket.ReceiveAsync($seg, $cts.Token)
      $r.Wait()
      $ms.Write($buf, 0, $r.Result.Count)
    } while (-not $r.Result.EndOfMessage)
    $text = [Text.Encoding]::UTF8.GetString($ms.ToArray())
    if ($text.StartsWith('{"id":1,')) { break }
  }
  $reply = $text | ConvertFrom-Json
  if (-not $reply.result -or -not $reply.result.targetId) { Fail 'cdp_failed' "Target.createTarget answered: $($text.Substring(0, [Math]::Min(200, $text.Length)))" }
} catch {
  Fail 'cdp_failed' $_.Exception.GetBaseException().Message
}
Write-Output (@{ ok = $true; created = $true } | ConvertTo-Json -Compress)

# Opens a tab on one torrent site in the streaming Chrome for claude/streaming/torrent.
# By default the tab is made out of sight (Target.createTarget background:true): no window is raised,
# restored or activated, so a film playing in this Chrome stays in front. With -Activate the tab is
# instead brought to the front and its window restored to normal, so the owner can solve a Cloudflare
# challenge by hand (the `gate` command uses this); the cf_clearance cookie the profile keeps then
# lets later background searches through. When Chrome is not running it is started on the site,
# minimized by default or in a normal window with -Activate. cdp.ps1 then finds that tab and
# evaluates in it; on its own it would open a missing tab in front. Prints one line of JSON:
# {"ok":true,"created":<bool>,"activated":<bool>} or {"cdp_error":<code>,"detail":...}.
# The same profile, port and switches as cdp.ps1. WSL cannot reach Windows loopback, which is why
# this half is PowerShell.
param(
  [Parameter(Mandatory = $true)][string]$Origin,
  [int]$Port = 9333,
  [int]$TimeoutS = 20,
  [switch]$Activate
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

# One CDP command over a fresh WebSocket, waiting for the reply with this id. Returns the parsed reply.
function Invoke-Cdp([string]$method, $cdpParams, [int]$deadlineMs) {
  $version = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 3
  $cts = New-Object System.Threading.CancellationTokenSource
  $cts.CancelAfter([Math]::Max(3000, $deadlineMs))
  $socket = New-Object System.Net.WebSockets.ClientWebSocket
  try {
    $socket.ConnectAsync([Uri]$version.webSocketDebuggerUrl, $cts.Token).Wait()
    $msg = @{ id = 1; method = $method; params = $cdpParams } | ConvertTo-Json -Depth 6 -Compress
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
      if ($text.StartsWith('{"id":1,')) { return ($text | ConvertFrom-Json) }
    }
  } finally {
    try { $socket.Dispose() } catch { }
  }
}

# Brings a target to the front and restores its window to a normal (not minimized) state.
function Set-Foreground([string]$targetId, [int]$deadlineMs) {
  Invoke-Cdp 'Target.activateTarget' @{ targetId = $targetId } $deadlineMs | Out-Null
  $win = Invoke-Cdp 'Browser.getWindowForTarget' @{ targetId = $targetId } $deadlineMs
  if ($win.result -and $win.result.windowId) {
    Invoke-Cdp 'Browser.setWindowBounds' @{ windowId = $win.result.windowId; bounds = @{ windowState = 'normal' } } $deadlineMs | Out-Null
  }
}

$originHost = ([Uri]$Origin).Host
$deadline = (Get-Date).AddSeconds($TimeoutS)
$windowStyle = if ($Activate) { 'Normal' } else { 'Minimized' }

if (-not (Test-Chrome)) {
  $chrome = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if (-not $chrome) { Fail 'no_chrome' 'chrome.exe was not found' }
  # Chrome refuses a debugging port on the default profile, so this one has its own folder.
  $profileDir = Join-Path $env:LOCALAPPDATA $ProfileName
  $args = @(
    "--remote-debugging-port=$Port", "--user-data-dir=`"$profileDir`"",
    '--no-first-run', '--no-default-browser-check',
    '--disable-features=CalculateNativeWinOcclusion', $Origin
  )
  if (-not $Activate) { $args += '--start-minimized' }
  Start-Process -FilePath $chrome -WindowStyle $windowStyle -ArgumentList $args
  while (-not (Test-Chrome)) {
    if ((Get-Date) -gt $deadline) { Fail 'chrome_not_reachable' "nothing answers on port $Port" }
    Start-Sleep -Milliseconds 500
  }
  Write-Output (@{ ok = $true; created = $true; activated = [bool]$Activate } | ConvertTo-Json -Compress)
  exit 0
}

$onSite = @(Get-Targets | Where-Object { $_.type -eq 'page' -and (Get-HostOf $_.url) -eq $originHost })
if ($onSite.Count -gt 0) {
  if ($Activate) {
    try { Set-Foreground $onSite[0].id ([Math]::Max(3000, [int]($deadline - (Get-Date)).TotalMilliseconds)) } catch { Fail 'cdp_failed' $_.Exception.GetBaseException().Message }
  }
  Write-Output (@{ ok = $true; created = $false; activated = [bool]$Activate } | ConvertTo-Json -Compress)
  exit 0
}

try {
  $remainMs = [Math]::Max(5000, [int]($deadline - (Get-Date)).TotalMilliseconds)
  # background:false with -Activate, so the new tab opens in front for the owner to solve the challenge.
  $reply = Invoke-Cdp 'Target.createTarget' @{ url = $Origin; background = (-not $Activate) } $remainMs
  if (-not $reply.result -or -not $reply.result.targetId) { Fail 'cdp_failed' "Target.createTarget answered: $(($reply | ConvertTo-Json -Compress).Substring(0, 200))" }
  if ($Activate) { Set-Foreground $reply.result.targetId ([Math]::Max(3000, [int]($deadline - (Get-Date)).TotalMilliseconds)) }
} catch {
  Fail 'cdp_failed' $_.Exception.GetBaseException().Message
}
Write-Output (@{ ok = $true; created = $true; activated = [bool]$Activate } | ConvertTo-Json -Compress)

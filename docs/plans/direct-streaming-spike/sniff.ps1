# Spike: open one embed page in the streaming Chrome, watch the network of the page and every
# frame and worker under it, and print what looks like a stream (manifests, media, subtitles)
# with the headers the request carried. One JSON object on stdout.
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [int]$Port = 9333,
  [int]$Seconds = 35,
  # Seconds to keep listening after the first manifest, for subtitles and the variant playlists.
  [int]$Linger = 4,
  [switch]$KeepTab
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ProfileName = 'notesd-stream-chrome'

function Test-Chrome {
  try { Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 3 | Out-Null; return $true } catch { return $false }
}

$t0 = Get-Date
if (-not (Test-Chrome)) {
  $chrome = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if (-not $chrome) { Write-Output '{"error":"no_chrome"}'; exit 3 }
  $profileDir = Join-Path $env:LOCALAPPDATA $ProfileName
  Start-Process -FilePath $chrome -WindowStyle Minimized -ArgumentList @(
    "--remote-debugging-port=$Port", "--user-data-dir=`"$profileDir`"",
    '--no-first-run', '--no-default-browser-check', '--start-minimized',
    '--disable-features=CalculateNativeWinOcclusion', 'about:blank'
  )
  $until = (Get-Date).AddSeconds(20)
  while (-not (Test-Chrome)) {
    if ((Get-Date) -gt $until) { Write-Output '{"error":"chrome_not_reachable"}'; exit 3 }
    Start-Sleep -Milliseconds 500
  }
}

$version = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 3
$cts = New-Object System.Threading.CancellationTokenSource
$cts.CancelAfter(($Seconds + 30) * 1000)
$socket = New-Object System.Net.WebSockets.ClientWebSocket
$socket.Options.KeepAliveInterval = [TimeSpan]::FromSeconds(20)
$socket.ConnectAsync([Uri]$version.webSocketDebuggerUrl, $cts.Token).Wait()
$script:nextId = 0
$buf = New-Object byte[] 262144

function Send-Cdp([string]$method, $params, [string]$session) {
  $script:nextId++
  $msg = @{ id = $script:nextId; method = $method; params = $params }
  if ($session) { $msg.sessionId = $session }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($msg | ConvertTo-Json -Depth 8 -Compress))
  $socket.SendAsync((New-Object System.ArraySegment[byte] -ArgumentList @(, $bytes)), 'Text', $true, $cts.Token).Wait()
  return $script:nextId
}

$script:pending = $null
# One whole message, or $null when nothing arrived within $waitMs.
function Receive-Message([int]$waitMs) {
  $ms = New-Object IO.MemoryStream
  while ($true) {
    if (-not $script:pending) {
      $seg = New-Object System.ArraySegment[byte] -ArgumentList @(, $buf)
      $script:pending = $socket.ReceiveAsync($seg, $cts.Token)
    }
    if (-not $script:pending.Wait($waitMs)) {
      if ($ms.Length -eq 0) { return $null }
      continue
    }
    $r = $script:pending.Result
    $script:pending = $null
    $ms.Write($buf, 0, $r.Count)
    if ($r.EndOfMessage) { return [Text.Encoding]::UTF8.GetString($ms.ToArray()) }
  }
}

function Wait-Reply([int]$id) {
  while ($true) {
    $text = Receive-Message 250
    if ($text -and $text.StartsWith("{`"id`":$id,")) { return ($text | ConvertFrom-Json) }
  }
}

$interesting = '\.m3u8|\.mpd(\?|$)|\.mp4(\?|$)|\.vtt(\?|$)|\.srt(\?|$)|/playlist|/manifest|master\.'
$mediaMime = 'mpegurl|dash\+xml|video/|text/vtt'

$created = Wait-Reply (Send-Cdp 'Target.createTarget' @{ url = 'about:blank' })
$targetId = $created.result.targetId
$attached = Wait-Reply (Send-Cdp 'Target.attachToTarget' @{ targetId = $targetId; flatten = $true })
$root = $attached.result.sessionId

function Watch-Session([string]$session) {
  Send-Cdp 'Network.enable' @{} $session | Out-Null
  Send-Cdp 'Target.setAutoAttach' @{ autoAttach = $true; waitForDebuggerOnStart = $true; flatten = $true } $session | Out-Null
  Send-Cdp 'Runtime.runIfWaitingForDebugger' @{} $session | Out-Null
}
Watch-Session $root
Send-Cdp 'Page.enable' @{} $root | Out-Null
# Tabs the page opens (adverts) are found here and closed.
Send-Cdp 'Target.setDiscoverTargets' @{ discover = $true } | Out-Null
Send-Cdp 'Page.navigate' @{ url = $Url } $root | Out-Null

$hits = New-Object System.Collections.ArrayList
$byRequest = @{}
$hosts = @{}
$frames = New-Object System.Collections.ArrayList
$popups = 0
$requests = 0
$firstManifest = $null
$clicks = 0
$deadline = (Get-Date).AddSeconds($Seconds)

while ((Get-Date) -lt $deadline) {
  if ($firstManifest -and ((Get-Date) - $firstManifest).TotalSeconds -gt $Linger) { break }
  # No stream yet: the player wants a press. A real click in the middle of the page.
  $elapsed = ((Get-Date) - $t0).TotalSeconds
  if (-not $firstManifest -and $clicks -lt 4 -and $elapsed -gt (8 + 5 * $clicks)) {
    $clicks++
    foreach ($type in 'mouseMoved', 'mousePressed', 'mouseReleased') {
      Send-Cdp 'Input.dispatchMouseEvent' @{ type = $type; x = 400; y = 300; button = 'left'; buttons = 1; clickCount = 1 } $root | Out-Null
    }
  }
  try { $text = Receive-Message 250 } catch { break }
  if (-not $text) { continue }
  if ($text -notmatch '"method":"(Network\.requestWillBeSent|Network\.responseReceived|Target\.attachedToTarget|Target\.targetCreated)"') { continue }
  try { $m = $text | ConvertFrom-Json } catch { continue }
  switch ($m.method) {
    'Target.attachedToTarget' {
      $info = $m.params.targetInfo
      [void]$frames.Add("$($info.type) $($info.url)")
      Watch-Session $m.params.sessionId
    }
    'Target.targetCreated' {
      $info = $m.params.targetInfo
      if ($info.type -eq 'page' -and $info.targetId -ne $targetId -and $info.openerId) {
        $popups++
        Send-Cdp 'Target.closeTarget' @{ targetId = $info.targetId } | Out-Null
      }
    }
    'Network.requestWillBeSent' {
      $requests++
      $req = $m.params.request
      try { $h = ([Uri]$req.url).Host } catch { $h = '' }
      if ($h) { $hosts[$h] = 1 + [int]$hosts[$h] }
      if ($req.url -match $interesting -or $m.params.type -eq 'Media') {
        $hit = [ordered]@{
          at_s = [Math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
          type = $m.params.type
          url = $req.url
          referer = $req.headers.Referer
          origin = $req.headers.Origin
          document = $m.params.documentURL
          status = $null
          mime = $null
        }
        $byRequest[$m.params.requestId + '|' + $m.sessionId] = $hit
        [void]$hits.Add($hit)
        if (-not $firstManifest -and $req.url -match '\.m3u8|\.mpd(\?|$)|\.mp4(\?|$)') { $firstManifest = Get-Date }
      }
    }
    'Network.responseReceived' {
      $key = $m.params.requestId + '|' + $m.sessionId
      $res = $m.params.response
      if ($byRequest.ContainsKey($key)) {
        $byRequest[$key].status = $res.status
        $byRequest[$key].mime = $res.mimeType
      } elseif ($res.mimeType -match $mediaMime) {
        # A stream behind an address that does not look like one.
        [void]$hits.Add([ordered]@{
          at_s = [Math]::Round(((Get-Date) - $t0).TotalSeconds, 1); type = $m.params.type; url = $res.url
          referer = $res.requestHeaders.Referer; origin = $null; document = $null; status = $res.status; mime = $res.mimeType
        })
        if (-not $firstManifest -and $res.mimeType -match 'mpegurl|dash\+xml|video/') { $firstManifest = Get-Date }
      }
    }
  }
}

if (-not $KeepTab) { try { Send-Cdp 'Target.closeTarget' @{ targetId = $targetId } | Out-Null; Start-Sleep -Milliseconds 300 } catch { } }

$topHosts = $hosts.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 12 | ForEach-Object { "$($_.Key) $($_.Value)" }
Write-Output ([ordered]@{
  url = $Url
  took_s = [Math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
  requests = $requests
  clicks = $clicks
  popups_closed = $popups
  frames = @($frames | Select-Object -Unique | Select-Object -First 12)
  hosts = @($topHosts)
  hits = @($hits | Select-Object -First 40)
} | ConvertTo-Json -Depth 6 -Compress)

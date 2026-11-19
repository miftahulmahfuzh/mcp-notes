# The Windows half of the direct-streaming sniffer (claude/streaming/direct/sniff.mjs). It opens one
# embed address in a background tab of the streaming Chrome, watches the network of the page and
# of every frame and worker under it, and prints what looks like a stream (manifests, media,
# subtitles) with the headers each request carried, as one line of JSON.
#
# Out of sight: the tab is created in the background, and nothing here raises, restores or
#   activates a window. A Chrome this script has to start is started minimized.
# Silent: before any page script runs, the tab and every frame get a script that keeps media
#   muted and Web Audio suspended (-MuteJsB64). Chrome's mute-audio switch would mute the whole
#   browser, the owner's film in this same Chrome included, so it is not used.
# Never a disguised client: the user agent and headers are Chrome's own and are only read.
# A bot check is reported (bot_check), never clicked through: clicks stop once one is seen.
# WSL cannot reach Windows loopback, which is why this half is PowerShell.
param(
  [Parameter(Mandatory = $true)][string]$UrlB64,
  [Parameter(Mandatory = $true)][string]$MuteJsB64,
  [Parameter(Mandatory = $true)][string]$MediaJsB64,
  [int]$Port = 9333,
  [int]$Seconds = 35,
  # Seconds to keep listening after the first manifest, for subtitles and the variant playlists.
  [int]$Linger = 4,
  # Seconds to wait after a bot check is seen, in case the page goes on to a stream by itself.
  [int]$BotGrace = 5,
  [switch]$KeepTab,
  # A file whose appearing ends the watch at once (the tab is closed and the reply written as usual): the
  # resolver makes it when another provider, asked side by side, already gave the stream.
  [string]$StopFile = '',
  # Before the tab closes, read what the page and each attached frame show (video elements, iframe
  # count, title, visible text). Read-only: nothing is clicked and nothing is played.
  [switch]$Inspect
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ProfileName = 'notesd-stream-chrome'

function ConvertFrom-B64([string]$text) { return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($text)) }

function Fail([string]$code, [string]$detail) {
  Write-Output (@{ error = $code; detail = $detail } | ConvertTo-Json -Compress)
  exit 3
}

$Url = ConvertFrom-B64 $UrlB64
$MuteJs = ConvertFrom-B64 $MuteJsB64
$MediaJs = ConvertFrom-B64 $MediaJsB64

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
  if (-not $chrome) { Fail 'no_chrome' 'chrome.exe was not found' }
  # The same profile, port and switches as claude/streaming/cdp.ps1, so the Chrome a resolve
  # starts is the one a play uses.
  $profileDir = Join-Path $env:LOCALAPPDATA $ProfileName
  Start-Process -FilePath $chrome -WindowStyle Minimized -ArgumentList @(
    "--remote-debugging-port=$Port", "--user-data-dir=`"$profileDir`"",
    '--no-first-run', '--no-default-browser-check', '--start-minimized',
    '--disable-features=CalculateNativeWinOcclusion', 'about:blank'
  )
  $until = (Get-Date).AddSeconds(20)
  while (-not (Test-Chrome)) {
    if ((Get-Date) -gt $until) { Fail 'chrome_not_reachable' "nothing answers on port $Port" }
    Start-Sleep -Milliseconds 500
  }
}

try {
  $version = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 3
  $cts = New-Object System.Threading.CancellationTokenSource
  # The watch, then reading bodies (8 x 3 s) and media state (12 x 1.5 s).
  $cts.CancelAfter(($Seconds + 60) * 1000)
  $socket = New-Object System.Net.WebSockets.ClientWebSocket
  $socket.Options.KeepAliveInterval = [TimeSpan]::FromSeconds(20)
  $socket.ConnectAsync([Uri]$version.webSocketDebuggerUrl, $cts.Token).Wait()
} catch {
  Fail 'chrome_not_reachable' $_.Exception.GetBaseException().Message
}
$script:nextId = 0
$buf = New-Object byte[] 262144

function Send-Cdp([string]$method, $params, [string]$session) {
  $script:nextId++
  $msg = @{ id = $script:nextId; method = $method; params = $params }
  if ($session) { $msg.sessionId = $session }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($msg | ConvertTo-Json -Depth 8 -Compress))
  try {
    $socket.SendAsync((New-Object System.ArraySegment[byte] -ArgumentList @(, $bytes)), 'Text', $true, $cts.Token).Wait()
  } catch { }
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

# The reply to call $id, or $null after $timeoutMs. Events that arrive meanwhile are dropped.
function Wait-Reply([int]$id, [int]$timeoutMs = 5000) {
  $until = (Get-Date).AddMilliseconds($timeoutMs)
  while ((Get-Date) -lt $until) {
    try { $text = Receive-Message 250 } catch { return $null }
    if (-not $text -or $text -notmatch ('"id":' + $id + '[,}]')) { continue }
    try { $reply = $text | ConvertFrom-Json } catch { continue }
    if ($reply.id -eq $id) { return $reply }
  }
  return $null
}

# A header by name, any case, from a DevTools headers object; $null when absent.
function Get-Header($headers, [string]$name) {
  if (-not $headers) { return $null }
  foreach ($p in $headers.PSObject.Properties) { if ($p.Name -eq $name) { return [string]$p.Value } }
  return $null
}

function Select-First($a, $b) { if ($a) { return $a }; return $b }

$userAgent = $null
$ver = Wait-Reply (Send-Cdp 'Browser.getVersion' @{})
if ($ver) { $userAgent = $ver.result.userAgent }

# background: the tab opens behind the active one; no window is raised or restored.
$created = Wait-Reply (Send-Cdp 'Target.createTarget' @{ url = 'about:blank'; background = $true })
if (-not $created -or -not $created.result) { Fail 'cdp_failed' 'Target.createTarget did not answer' }
$targetId = $created.result.targetId

function Close-Tab {
  if ($KeepTab) { return }
  Send-Cdp 'Target.closeTarget' @{ targetId = $targetId } | Out-Null
  Start-Sleep -Milliseconds 300
}

$attached = Wait-Reply (Send-Cdp 'Target.attachToTarget' @{ targetId = $targetId; flatten = $true })
if (-not $attached -or -not $attached.result) { Close-Tab; Fail 'cdp_failed' 'Target.attachToTarget did not answer' }
$root = $attached.result.sessionId

# Sessions that hold a document (the tab and its frames): muted, and asked for media state at the end.
$pageSessions = New-Object System.Collections.ArrayList
# Targets that belong to this tab: only tabs these open are closed as adverts.
$ourTargets = @{ $targetId = 1 }

function Watch-Session([string]$session, [bool]$hasDocument) {
  Send-Cdp 'Network.enable' @{} $session | Out-Null
  if ($hasDocument) {
    [void]$pageSessions.Add($session)
    Send-Cdp 'Page.addScriptToEvaluateOnNewDocument' @{ source = $MuteJs; runImmediately = $true } $session | Out-Null
  }
  Send-Cdp 'Target.setAutoAttach' @{ autoAttach = $true; waitForDebuggerOnStart = $true; flatten = $true } $session | Out-Null
  Send-Cdp 'Runtime.runIfWaitingForDebugger' @{} $session | Out-Null
}
Watch-Session $root $true
Send-Cdp 'Page.enable' @{} $root | Out-Null
# A background tab is hidden, and Chrome drops mouse events sent to a hidden tab: the press below
# would never reach the player. Focus emulation keeps the tab live where it is, behind the
# active one; no window is raised and nothing about the client changes.
Send-Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true } $root | Out-Null
# Tabs that exist before this one navigates (the owner's included) are never closed or counted.
$known = @{}
$existing = Wait-Reply (Send-Cdp 'Target.getTargets' @{})
if ($existing) { foreach ($t in @($existing.result.targetInfos)) { $known[$t.targetId] = 1 } }
# Tabs the page opens (adverts) are found here and closed; title changes show a bot check.
Send-Cdp 'Target.setDiscoverTargets' @{ discover = $true } | Out-Null
Send-Cdp 'Page.navigate' @{ url = $Url } $root | Out-Null

# A subtitle file may sit behind a relay that carries its address as a parameter
# (fetch?url=https%3A%2F%2F...%2Fsubtitles%2Fx.vtt&ref=...), so .vtt and .srt count wherever they stand.
$interesting = '\.m3u8|\.mpd(\?|$)|\.mp4(\?|$)|\.vtt([?&%]|$)|\.srt([?&%]|$)|/playlist|/manifest|master\.'
$manifestUrl = '\.m3u8|\.mpd(\?|$)'
$manifestLike = '\.m3u8|\.mpd(\?|$)|master\.|/playlist|/manifest'
$mediaMime = 'mpegurl|dash\+xml|video/|text/vtt'
$segmentMime = 'video/mp2t|video/iso\.segment'
# A subtitle index: the JSON list of subtitle files a player page asks a subtitle service for
# (sub.wyzie.io/search, sub.vdrk.site/v2/...). The page loads a file only when the viewer picks
# its language, so the list is the only place the English track shows.
$subtitleIndex = '^https?://(sub|subs|subtitles?)[.-][^/]+/|[/.](subtitles?|captions?)[/?.]'
$botTitle = '^(Just a moment|Attention Required|Checking your browser|One more step|DDoS-Guard)'
# Not a bare challenges.cloudflare.com request: that also fires for Turnstile's own loader, which
# plenty of sites embed passively (an invisible widget, bot scoring) on a page that never blocks
# anything. /cdn-cgi/challenge-platform/ is Cloudflare's own path for serving the challenge itself.
# /vs_captcha/ is vidsrc.sh's own gate (a slide or rotate puzzle its player shows before it makes
# the stream, 2026-11-19): the player asks for its files only when it puts the puzzle up.
# A host named cap.<site> is a Cap widget's own server (hexa.su's "Verification Required", 2026-11-19).
$botUrl = '/cdn-cgi/challenge-platform/|hcaptcha\.com/captcha|google\.com/recaptcha/(api2|enterprise)/(anchor|bframe)|/vs_captcha/|^https?://cap\.[^/]+/'
$events = '"method":"(Network\.requestWillBeSent|Network\.requestWillBeSentExtraInfo|Network\.responseReceived|Network\.loadingFailed|Page\.domContentEventFired|Page\.loadEventFired|Target\.attachedToTarget|Target\.targetCreated|Target\.targetInfoChanged)"'

$hits = New-Object System.Collections.ArrayList
$byRequest = @{}
$extra = @{}
$hosts = @{}
$frames = New-Object System.Collections.ArrayList
# A frame target's url at Target.attachedToTarget is often still about:blank (the attach fires at
# creation, before its first navigation commits); this maps targetId -> its index in $frames so a
# later Target.targetInfoChanged can fill in the address it navigated to.
$frameIndexByTarget = @{}
$popups = 0
$strays = 0
$requests = 0
$firstManifest = $null
$firstMp4 = $null
$clicks = 0
$script:botAt = $null
$script:botReason = $null
# The page's own document: the tab's first Document request, and every later one of the same frame (a
# forward by script). A provider whose page does not load at all (its name no longer resolves, the
# connection fails, its origin answers 5xx: Cloudflare's 521/522/523) has no stream to wait 35 s for:
# the watch ends $DownGrace seconds after that, and the reply says so (`page`).
$pageFrame = $null
$pageRid = $null
$pageStatus = $null
$pageError = $null
$downAt = $null
$DownGrace = 3
# A background tab's title never arrives as a target event, so the page is asked for it.
$titleCall = $null
# Where the press goes: the middle of the page as it is laid out, asked of the page once it has
# loaded. A player that starts only from its own centred button (vidsrc.sh's, 2026-11-19) is
# missed by a fixed point: the tab is as large as the Chrome window, not 800 by 600.
$sizeCall = $null
$clickX = 400
$clickY = 300
$deadline = (Get-Date).AddSeconds($Seconds)

function Set-BotCheck([string]$reason) {
  if (-not $script:botAt) { $script:botAt = Get-Date; $script:botReason = $reason }
}

# Untyped parameters on purpose: a [string] parameter turns $null into '' and the JSON would say "".
function New-Hit($m, $url, $headers, $type, $document, $status, $mime) {
  return [ordered]@{
    at_s = [Math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
    type = $type
    url = $url
    referer = Get-Header $headers 'Referer'
    origin = Get-Header $headers 'Origin'
    user_agent = Get-Header $headers 'User-Agent'
    document = $document
    status = $status
    mime = $mime
    body = $null
    _key = $m.params.requestId + '|' + $m.sessionId
    _rid = $m.params.requestId
    _sid = $m.sessionId
  }
}

# Whether an mp4 answer says it is under 20 MB in all (Content-Range's total, else Content-Length).
function Test-Clip($res) {
  $total = 0L
  $range = [string](Get-Header $res.headers 'Content-Range')
  if ($range -match '/(\d+)\s*$') { $total = [long]$Matches[1] }
  elseif ($res.status -eq 200) { [void][long]::TryParse([string](Get-Header $res.headers 'Content-Length'), [ref]$total) }
  return ($total -gt 0 -and $total -lt 20MB)
}

# The inspection adds up to 12 x 1.5 s after the media state.
if ($Inspect) { $cts.CancelAfter(($Seconds + 90) * 1000) }
$InspectJs = @'
(() => {
  const videosIn = (doc) => Array.from(doc.querySelectorAll('video')).map((v) => ({
    src: String(v.currentSrc || v.src || '').slice(0, 120),
    ready_state: v.readyState,
    paused: v.paused,
    current_time: Math.round(v.currentTime || 0),
    muted: v.muted,
  }));
  const videos = videosIn(document);
  for (const frame of Array.from(document.querySelectorAll('iframe'))) {
    try { if (frame.contentDocument) videos.push(...videosIn(frame.contentDocument)); } catch (e) {}
  }
  const text = document.body ? document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  return JSON.stringify({ url: location.href.slice(0, 200), title: document.title.slice(0, 120), text,
    videos, iframes: document.querySelectorAll('iframe').length });
})()
'@

# What one page or frame shows, or $null when it cannot be read (gone, or never answered).
function Get-FrameReport([string]$session) {
  try {
    $reply = Wait-Reply (Send-Cdp 'Runtime.evaluate' @{ expression = $InspectJs; returnByValue = $true } $session) 1500
    $value = $reply.result.result.value
    if ($value) { return ($value | ConvertFrom-Json) }
  } catch { }
  return $null
}

$stopLooked = Get-Date
while ((Get-Date) -lt $deadline) {
  $now = Get-Date
  if ($StopFile -and ($now - $stopLooked).TotalMilliseconds -gt 700) {
    $stopLooked = $now
    if (Test-Path -LiteralPath $StopFile) { break }
  }
  if ($firstManifest -and ($now - $firstManifest).TotalSeconds -gt $Linger) { break }
  if (-not $firstManifest -and $firstMp4 -and ($now - $firstMp4).TotalSeconds -gt 12) { break }
  if ($script:botAt -and -not $firstManifest -and ($now - $script:botAt).TotalSeconds -gt $BotGrace) { break }
  if ($downAt -and -not $firstManifest -and -not $firstMp4 -and ($now - $downAt).TotalSeconds -gt $DownGrace) { break }
  # No stream yet and no check: the player wants a press. A real click in the middle of the page.
  $elapsed = ($now - $t0).TotalSeconds
  if (-not $firstManifest -and -not $script:botAt -and $clicks -lt 4 -and $elapsed -gt (8 + 5 * $clicks)) {
    $clicks++
    foreach ($type in 'mouseMoved', 'mousePressed', 'mouseReleased') {
      Send-Cdp 'Input.dispatchMouseEvent' @{ type = $type; x = $clickX; y = $clickY; button = 'left'; buttons = 1; clickCount = 1 } $root | Out-Null
    }
  }
  try { $text = Receive-Message 250 } catch { break }
  if (-not $text) { continue }
  if ($titleCall -and $text -match ('"id":' + $titleCall + '[,}]')) {
    try { $reply = $text | ConvertFrom-Json } catch { continue }
    if ($reply.id -eq $titleCall) {
      $titleCall = $null
      $title = [string]$reply.result.result.value
      if ($title -match $botTitle) { Set-BotCheck "title $title" }
      continue
    }
  }
  if ($sizeCall -and $text -match ('"id":' + $sizeCall + '[,}]')) {
    try { $reply = $text | ConvertFrom-Json } catch { continue }
    if ($reply.id -eq $sizeCall) {
      $sizeCall = $null
      if ([string]$reply.result.result.value -match '^(\d+)x(\d+)$' -and [int]$Matches[1] -ge 200 -and [int]$Matches[2] -ge 150) {
        $clickX = [int]([int]$Matches[1] / 2)
        $clickY = [int]([int]$Matches[2] / 2)
      }
      continue
    }
  }
  if ($text -notmatch $events) { continue }
  try { $m = $text | ConvertFrom-Json } catch { continue }
  switch ($m.method) {
    'Target.attachedToTarget' {
      $info = $m.params.targetInfo
      $ourTargets[$info.targetId] = 1
      $frameIndexByTarget[$info.targetId] = $frames.Count
      [void]$frames.Add("$($info.type) $($info.url)")
      if ($info.url -match $botUrl) { Set-BotCheck "frame $($info.url)" }
      Watch-Session $m.params.sessionId ($info.type -eq 'iframe' -or $info.type -eq 'page')
    }
    'Target.targetCreated' {
      $info = $m.params.targetInfo
      if ($info.type -eq 'page' -and $info.targetId -ne $targetId -and -not $known.ContainsKey($info.targetId)) {
        if ($info.openerId -and $ourTargets.ContainsKey($info.openerId)) {
          $popups++
          Send-Cdp 'Target.closeTarget' @{ targetId = $info.targetId } | Out-Null
        } elseif (-not $info.openerId) {
          $strays++
        }
      }
    }
    'Target.targetInfoChanged' {
      $info = $m.params.targetInfo
      if ($info.targetId -eq $targetId -and ($info.title -match $botTitle -or $info.url -match $botUrl)) {
        Set-BotCheck "title $($info.title)"
      }
      if ($frameIndexByTarget.ContainsKey($info.targetId)) {
        $frames[$frameIndexByTarget[$info.targetId]] = "$($info.type) $($info.url)"
        if ($info.url -match $botUrl) { Set-BotCheck "frame $($info.url)" }
      }
    }
    { $_ -eq 'Page.domContentEventFired' -or $_ -eq 'Page.loadEventFired' } {
      if ($m.sessionId -eq $root) {
        $titleCall = Send-Cdp 'Runtime.evaluate' @{ expression = 'document.title'; returnByValue = $true } $root
        $sizeCall = Send-Cdp 'Runtime.evaluate' @{ expression = 'innerWidth + "x" + innerHeight'; returnByValue = $true } $root
      }
    }
    'Network.requestWillBeSentExtraInfo' {
      $extra[$m.params.requestId + '|' + $m.sessionId] = $m.params.headers
    }
    'Network.loadingFailed' {
      # An aborted load is the page going elsewhere by itself, not a page that is down.
      if ($m.sessionId -eq $root -and $pageRid -and $m.params.requestId -eq $pageRid -and -not $m.params.canceled -and $m.params.errorText -ne 'net::ERR_ABORTED') {
        $pageError = [string]$m.params.errorText
        $downAt = Get-Date
      }
    }
    'Network.requestWillBeSent' {
      $requests++
      $req = $m.params.request
      if ($m.sessionId -eq $root -and $m.params.type -eq 'Document') {
        if (-not $pageFrame) { $pageFrame = $m.params.frameId }
        if ($m.params.frameId -eq $pageFrame) { $pageRid = $m.params.requestId; $pageStatus = $null; $pageError = $null; $downAt = $null }
      }
      try { $h = ([Uri]$req.url).Host } catch { $h = '' }
      if ($h) { $hosts[$h] = 1 + [int]$hosts[$h] }
      if ($req.url -match $botUrl) { Set-BotCheck "request $h" }
      if ($req.url -match $interesting -or $m.params.type -eq 'Media' -or ($m.params.type -eq 'TextTrack' -and $req.url -match '^https?:')) {
        $hit = New-Hit $m $req.url $req.headers $m.params.type $m.params.documentURL $null $null
        $byRequest[$hit._key] = $hit
        [void]$hits.Add($hit)
        if (-not $firstManifest -and $req.url -match $manifestUrl) { $firstManifest = Get-Date }
        if (-not $firstMp4 -and $req.url -match '\.mp4(\?|$)') { $firstMp4 = Get-Date }
      }
    }
    'Network.responseReceived' {
      $key = $m.params.requestId + '|' + $m.sessionId
      $res = $m.params.response
      if ($m.sessionId -eq $root -and $pageRid -and $m.params.requestId -eq $pageRid) {
        $pageStatus = [int]$res.status
        if ($pageStatus -ge 500) { $downAt = Get-Date }
      }
      if ($m.params.type -eq 'Document' -and (Get-Header $res.headers 'cf-mitigated') -eq 'challenge') {
        Set-BotCheck "cf-mitigated on $($res.url)"
      }
      # A short mp4 (an advert clip, a button animation) is not the film: it is no hit, and it
      # does not end the watch early.
      if ($res.mimeType -match '^video/mp4' -and (Test-Clip $res)) {
        if ($byRequest.ContainsKey($key)) { $hits.Remove($byRequest[$key]); $byRequest.Remove($key) }
        if (-not @($hits | Where-Object { $_.url -match '\.mp4(\?|$)' })) { $firstMp4 = $null }
        continue
      }
      if ($byRequest.ContainsKey($key)) {
        $byRequest[$key].status = $res.status
        $byRequest[$key].mime = $res.mimeType
      } elseif ($res.mimeType -match 'json' -and $res.url -match $subtitleIndex -and $res.status -ge 200 -and $res.status -lt 300) {
        $hit = New-Hit $m $res.url $res.requestHeaders 'SubtitleIndex' $null $res.status $res.mimeType
        $byRequest[$key] = $hit
        [void]$hits.Add($hit)
      } elseif ($res.mimeType -match $mediaMime -and $res.mimeType -notmatch $segmentMime) {
        # A stream behind an address that does not look like one (VidNest's master.txt).
        $hit = New-Hit $m $res.url $res.requestHeaders $m.params.type $null $res.status $res.mimeType
        $byRequest[$key] = $hit
        [void]$hits.Add($hit)
      }
      if (-not $firstManifest -and $res.mimeType -match 'mpegurl|dash\+xml') { $firstManifest = Get-Date }
      if (-not $firstMp4 -and $res.mimeType -match '^video/mp4') { $firstMp4 = Get-Date }
    }
  }
}

# What Chrome already received for the manifests: quality and in-manifest subtitle tracks.
$bodies = 0
foreach ($hit in $hits) {
  if ($bodies -ge 8) { break }
  if (-not ($hit.status -ge 200 -and $hit.status -lt 300)) { continue }
  if (-not ($hit.url -match $manifestLike -or "$($hit.mime)" -match 'mpegurl|dash\+xml' -or $hit.type -eq 'SubtitleIndex')) { continue }
  $bodies++
  $reply = Wait-Reply (Send-Cdp 'Network.getResponseBody' @{ requestId = $hit._rid } $hit._sid) 3000
  if ($reply -and $reply.result) {
    $body = if ($reply.result.base64Encoded) { ConvertFrom-B64 $reply.result.body } else { [string]$reply.result.body }
    if ($body.Length -gt 262144) { $body = $body.Substring(0, 262144) }
    $hit.body = $body
  }
}

# Whether anything in the tab could be heard: media elements playing unmuted.
$media = [ordered]@{ elements = 0; audible = 0 }
foreach ($session in @($pageSessions | Select-Object -First 12)) {
  $reply = Wait-Reply (Send-Cdp 'Runtime.evaluate' @{ expression = $MediaJs; returnByValue = $true } $session) 1500
  $value = $reply.result.result.value
  if ($value) {
    $media.elements += [int]$value.elements
    $media.audible += [int]$value.audible
  }
}

$inspectReports = $null
if ($Inspect) {
  $inspectReports = New-Object System.Collections.ArrayList
  foreach ($session in @($pageSessions | Select-Object -First 12)) {
    $report = Get-FrameReport $session
    if ($report) { [void]$inspectReports.Add($report) }
  }
}

Close-Tab

$outHits = @(foreach ($hit in @($hits | Select-Object -First 60)) {
  $sent = $extra[$hit._key]
  [ordered]@{
    at_s = $hit.at_s
    type = $hit.type
    url = $hit.url
    referer = Select-First (Get-Header $sent 'Referer') $hit.referer
    origin = Select-First (Get-Header $sent 'Origin') $hit.origin
    user_agent = Select-First (Get-Header $sent 'User-Agent') $hit.user_agent
    document = $hit.document
    status = $hit.status
    mime = $hit.mime
    body = $hit.body
  }
})
$topHosts = $hosts.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 12 | ForEach-Object { "$($_.Key) $($_.Value)" }
Write-Output ([ordered]@{
  url = $Url
  took_s = [Math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
  user_agent = $userAgent
  bot_check = [bool]$script:botAt
  bot_check_reason = $script:botReason
  page = [ordered]@{ status = $pageStatus; error = $pageError; down = [bool]$downAt }
  requests = $requests
  clicks = $clicks
  popups_closed = $popups
  tabs_left_open = $strays
  frames = @($frames | Select-Object -Unique | Select-Object -First 12)
  hosts = @($topHosts)
  media = $media
  hits = $outHits
  inspect = $(if ($Inspect) { @($inspectReports) } else { $null })
} | ConvertTo-Json -Depth 6 -Compress)

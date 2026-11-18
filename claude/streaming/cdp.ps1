# The Windows half of the streaming skills (/idlix, /lk21, ...). It evaluates one JavaScript
# expression in a tab of a real Chrome over the DevTools protocol and prints the protocol's reply
# as one line of JSON. Chrome runs with its own profile folder, apart from the user's everyday
# Chrome, and is started minimized when it is not already up. WSL cannot reach Windows loopback,
# which is why this half is PowerShell.
param(
  # The site: where a new tab opens, and which tabs count as the site's own.
  [Parameter(Mandatory = $true)][string]$Origin,
  [Parameter(Mandatory = $true)][string]$JsB64,
  [int]$Port = 9333,
  [int]$TimeoutS = 45,
  # Evaluate inside the embedded frame whose address matches this pattern (a player on another
  # host) and not in the site's own page. The answer is { cdp_error: no_frame } when there is none.
  [string]$FrameMatch = '',
  # Take the window out of the taskbar and put the tab in front before evaluating.
  [switch]$Show,
  # With -Show: 'normal', or 'fullscreen' for the whole window, as F11 does.
  [string]$WindowState = 'normal',
  # Close every tab that is not on the site: the advertising tabs a click on a player opens.
  # They take the front, and a site's countdown stops while its own tab is behind one.
  [switch]$CloseOtherTabs,
  # Close every tab on these hosts (comma-separated): the streaming sites' tabs, whose film would
  # go on playing behind the daemon's own player page. Other tabs are left alone.
  [string]$CloseHosts = ''
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
    # Without this a window covered by another one counts as hidden, and a site's countdown
    # before a film stops until the window is uncovered.
    '--disable-features=CalculateNativeWinOcclusion', $Origin
  )
  while (-not (Test-Chrome)) {
    if ((Get-Date) -gt $deadline) { Fail 'chrome_not_reachable' "nothing answers on port $Port" }
    Start-Sleep -Milliseconds 500
  }
}

if ($CloseOtherTabs) {
  Get-Targets | Where-Object { $_.type -eq 'page' -and $_.url -notmatch '^(chrome|about|devtools):' -and (Get-HostOf $_.url) -ne $originHost } | ForEach-Object {
    try { Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/close/$($_.id)" -TimeoutSec 3 | Out-Null } catch { }
  }
}

if ($CloseHosts) {
  $closing = @($CloseHosts.Split(',') | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ -and $_ -ne $originHost })
  Get-Targets | Where-Object { $_.type -eq 'page' -and ($closing -contains (Get-HostOf $_.url).ToLower()) } | ForEach-Object {
    try { Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/close/$($_.id)" -TimeoutSec 3 | Out-Null } catch { }
  }
}

# A tab on the site, loaded far enough to have a title; open one when there is none.
$tab = $null
$opened = $false
while (-not $tab) {
  $onSite = @(Get-Targets | Where-Object { $_.type -eq 'page' -and (Get-HostOf $_.url) -eq $originHost })
  $tab = $onSite | Where-Object { $_.title -and $_.title -ne $_.url -and $_.title -notmatch '^Just a moment' -and $_.title -ne $originHost } | Select-Object -First 1
  if ($tab) { break }
  if ($onSite.Count -eq 0 -and -not $opened) {
    Invoke-RestMethod -Method Put -Uri "http://127.0.0.1:$Port/json/new?$Origin" -TimeoutSec 5 | Out-Null
    $opened = $true
  }
  if ((Get-Date) -gt $deadline) { Fail 'no_tab' "no loaded tab on $originHost" }
  Start-Sleep -Milliseconds 500
}

$js = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($JsB64))
$cts = New-Object System.Threading.CancellationTokenSource
$cts.CancelAfter([Math]::Max(5, [int]($deadline - (Get-Date)).TotalSeconds) * 1000)
$script:nextId = 0

function Open-Socket([string]$url) {
  $socket = New-Object System.Net.WebSockets.ClientWebSocket
  $socket.ConnectAsync([Uri]$url, $cts.Token).Wait()
  return $socket
}

# Sends one DevTools call and returns its reply as text; events (no id) are skipped.
function Invoke-Cdp($socket, [string]$method, $params) {
  $script:nextId++
  $id = $script:nextId
  $msg = @{ id = $id; method = $method; params = $params } | ConvertTo-Json -Depth 6 -Compress
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
    if ($text.StartsWith("{`"id`":$id,")) { return $text }
  }
}

# userGesture: a click made by the expression counts as the user's, so a video may start with sound.
function Invoke-Expression-In($socket, [string]$expression) {
  return Invoke-Cdp $socket 'Runtime.evaluate' @{ expression = $expression; awaitPromise = $true; returnByValue = $true; userGesture = $true }
}

try {
  $page = Open-Socket $tab.webSocketDebuggerUrl
  if ($Show) {
    $window = (Invoke-Cdp $page 'Browser.getWindowForTarget' @{}) | ConvertFrom-Json
    Invoke-Cdp $page 'Browser.setWindowBounds' @{ windowId = $window.result.windowId; bounds = @{ windowState = 'normal' } } | Out-Null
    Invoke-Cdp $page 'Page.bringToFront' @{} | Out-Null
    # The page keeps behaving as focused when the user clicks into another window.
    Invoke-Cdp $page 'Emulation.setFocusEmulationEnabled' @{ enabled = $true } | Out-Null
    # A window behind another one may count as hidden, so it has to be the foreground window.
    # The browser process is the one without a --type argument.
    $browser = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
      Where-Object { $_.CommandLine -match $ProfileName -and $_.CommandLine -notmatch '--type=' } | Select-Object -First 1
    if ($browser) {
      $shell = New-Object -ComObject WScript.Shell
      # Windows lets a background program take the foreground only right after a key press; a
      # bare Alt is the usual one.
      $shell.SendKeys('%')
      $shell.AppActivate($browser.ProcessId) | Out-Null
      Start-Sleep -Milliseconds 300
    }
    # Full screen comes last, on the window that is already in front. Windows hides its taskbar
    # only while the foreground window covers the screen; going full screen first left Chrome's
    # "To exit full screen" bubble as the window AppActivate picked, and the taskbar stayed.
    if ($WindowState -ne 'normal') {
      Invoke-Cdp $page 'Browser.setWindowBounds' @{ windowId = $window.result.windowId; bounds = @{ windowState = $WindowState } } | Out-Null
    }
  }
  if ($FrameMatch) {
    $frame = Get-Targets | Where-Object { $_.type -eq 'iframe' -and $_.url -match $FrameMatch } | Select-Object -First 1
    if (-not $frame) { Fail 'no_frame' "no embedded frame matches $FrameMatch" }
    $text = Invoke-Expression-In (Open-Socket $frame.webSocketDebuggerUrl) $js
  } else {
    $text = Invoke-Expression-In $page $js
    # An expression that answers { click: { x, y } } asks for a real mouse click at that point of
    # the page. It reaches a player inside a frame from another host, which script cannot.
    $click = ($text | ConvertFrom-Json).result.result.value.click
    if ($click) {
      foreach ($type in 'mouseMoved', 'mousePressed', 'mouseReleased') {
        Invoke-Cdp $page 'Input.dispatchMouseEvent' @{ type = $type; x = [int]$click.x; y = [int]$click.y; button = 'left'; buttons = 1; clickCount = 1 } | Out-Null
      }
    }
  }
} catch {
  Fail 'cdp_failed' $_.Exception.GetBaseException().Message
}
Write-Output $text

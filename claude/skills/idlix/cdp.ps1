# The Windows half of the /idlix skill. idlix answers only a real browser, so this evaluates one
# JavaScript expression in a tab of a real Chrome over the DevTools protocol and prints the
# protocol's reply as one line of JSON. Chrome runs with its own profile folder, apart from the
# user's everyday Chrome, and is started minimized when it is not already up.
param(
  [Parameter(Mandatory = $true)][string]$Origin,
  [Parameter(Mandatory = $true)][string]$JsB64,
  [int]$Port = 9333,
  [int]$TimeoutS = 45,
  # Take the window out of the taskbar and put the tab in front before evaluating.
  [switch]$Show,
  # With -Show: 'normal', or 'fullscreen' for the whole window, as F11 does.
  [string]$WindowState = 'normal',
  # Close every tab that is not on the site: the advertising tabs a click on the player opens.
  # They take the front, and the site's countdown stops while its own tab is behind one.
  [switch]$CloseOtherTabs
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Fail([string]$code, [string]$detail) {
  Write-Output (@{ cdp_error = $code; detail = $detail } | ConvertTo-Json -Compress)
  exit 3
}

function Test-Chrome {
  try { Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 3 | Out-Null; return $true } catch { return $false }
}

# Windows PowerShell hands the JSON array back as one object; the pipe unrolls it.
function Get-Tabs {
  try { Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 3 | ForEach-Object { $_ } } catch { }
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
  $profileDir = Join-Path $env:LOCALAPPDATA 'notesd-idlix-chrome'
  Start-Process -FilePath $chrome -WindowStyle Minimized -ArgumentList @(
    "--remote-debugging-port=$Port", "--user-data-dir=`"$profileDir`"",
    '--no-first-run', '--no-default-browser-check', '--start-minimized',
    # Without this a window covered by another one counts as hidden, and the site's countdown
    # before a film stops until the window is uncovered.
    '--disable-features=CalculateNativeWinOcclusion', $Origin
  )
  while (-not (Test-Chrome)) {
    if ((Get-Date) -gt $deadline) { Fail 'chrome_not_reachable' "nothing answers on port $Port" }
    Start-Sleep -Milliseconds 500
  }
}

if ($CloseOtherTabs) {
  Get-Tabs | Where-Object { $_.type -eq 'page' -and $_.url -notmatch '^(chrome|about|devtools):' -and ([Uri]$_.url).Host -ne $originHost } | ForEach-Object {
    try { Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/close/$($_.id)" -TimeoutSec 3 | Out-Null } catch { }
  }
}

# A tab on the site, loaded far enough to have a title; open one when there is none.
$tab = $null
$opened = $false
while (-not $tab) {
  $onSite = @(Get-Tabs | Where-Object { $_.type -eq 'page' -and ([Uri]$_.url).Host -eq $originHost })
  $tab = $onSite | Where-Object { $_.title -and $_.title -ne $_.url -and $_.title -notmatch '^(Just a moment|z\d*\.)' } | Select-Object -First 1
  if ($tab) { break }
  if ($onSite.Count -eq 0 -and -not $opened) {
    Invoke-RestMethod -Method Put -Uri "http://127.0.0.1:$Port/json/new?$Origin" -TimeoutSec 5 | Out-Null
    $opened = $true
  }
  if ((Get-Date) -gt $deadline) { Fail 'no_tab' "no loaded tab on $originHost" }
  Start-Sleep -Milliseconds 500
}

$js = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($JsB64))
$ws = New-Object System.Net.WebSockets.ClientWebSocket
$cts = New-Object System.Threading.CancellationTokenSource
$cts.CancelAfter([Math]::Max(5, [int]($deadline - (Get-Date)).TotalSeconds) * 1000)
$script:nextId = 0

# Sends one DevTools call and returns its reply as text; events (no id) are skipped.
function Invoke-Cdp([string]$method, $params) {
  $script:nextId++
  $id = $script:nextId
  $msg = @{ id = $id; method = $method; params = $params } | ConvertTo-Json -Depth 6 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($msg)
  $ws.SendAsync((New-Object System.ArraySegment[byte] -ArgumentList @(, $bytes)), 'Text', $true, $cts.Token).Wait()
  $buf = New-Object byte[] 65536
  while ($true) {
    $ms = New-Object IO.MemoryStream
    do {
      $seg = New-Object System.ArraySegment[byte] -ArgumentList @(, $buf)
      $r = $ws.ReceiveAsync($seg, $cts.Token)
      $r.Wait()
      $ms.Write($buf, 0, $r.Result.Count)
    } while (-not $r.Result.EndOfMessage)
    $text = [Text.Encoding]::UTF8.GetString($ms.ToArray())
    if ($text.StartsWith("{`"id`":$id,")) { return $text }
  }
}

try {
  $ws.ConnectAsync([Uri]$tab.webSocketDebuggerUrl, $cts.Token).Wait()
  if ($Show) {
    $window = (Invoke-Cdp 'Browser.getWindowForTarget' @{}) | ConvertFrom-Json
    Invoke-Cdp 'Browser.setWindowBounds' @{ windowId = $window.result.windowId; bounds = @{ windowState = 'normal' } } | Out-Null
    if ($WindowState -ne 'normal') {
      Invoke-Cdp 'Browser.setWindowBounds' @{ windowId = $window.result.windowId; bounds = @{ windowState = $WindowState } } | Out-Null
    }
    Invoke-Cdp 'Page.bringToFront' @{} | Out-Null
    # The page keeps behaving as focused when the user clicks into another window.
    Invoke-Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true } | Out-Null
    # A window behind another one counts as hidden and the site's countdown stops, so it has to
    # be the foreground window. The browser process is the one without a --type argument.
    $browser = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
      Where-Object { $_.CommandLine -match 'notesd-idlix-chrome' -and $_.CommandLine -notmatch '--type=' } | Select-Object -First 1
    if ($browser) {
      $shell = New-Object -ComObject WScript.Shell
      # Windows lets a background program take the foreground only right after a key press; a
      # bare Alt is the usual one.
      $shell.SendKeys('%')
      $shell.AppActivate($browser.ProcessId) | Out-Null
      Start-Sleep -Milliseconds 300
    }
  }
  # userGesture: a click made by the expression counts as the user's, so a video may start with sound.
  $text = Invoke-Cdp 'Runtime.evaluate' @{ expression = $js; awaitPromise = $true; returnByValue = $true; userGesture = $true }
} catch {
  Fail 'cdp_failed' $_.Exception.GetBaseException().Message
}
Write-Output $text

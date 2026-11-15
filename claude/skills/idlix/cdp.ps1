# The Windows half of the /idlix skill. idlix answers only a real browser, so this evaluates one
# JavaScript expression in a tab of a real Chrome over the DevTools protocol and prints the
# protocol's reply as one line of JSON. Chrome runs with its own profile folder, apart from the
# user's everyday Chrome, and is started minimized when it is not already up.
param(
  [Parameter(Mandatory = $true)][string]$Origin,
  [Parameter(Mandatory = $true)][string]$JsB64,
  [int]$Port = 9333,
  [int]$TimeoutS = 45
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
    '--no-first-run', '--no-default-browser-check', '--start-minimized', $Origin
  )
  while (-not (Test-Chrome)) {
    if ((Get-Date) -gt $deadline) { Fail 'chrome_not_reachable' "nothing answers on port $Port" }
    Start-Sleep -Milliseconds 500
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
try {
  $ws.ConnectAsync([Uri]$tab.webSocketDebuggerUrl, $cts.Token).Wait()
  $msg = @{ id = 1; method = 'Runtime.evaluate'; params = @{ expression = $js; awaitPromise = $true; returnByValue = $true } } |
    ConvertTo-Json -Depth 5 -Compress
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
    # Events have no id; the reply to our one call starts with it.
    if ($text -match '^\{"id":1,') { break }
  }
} catch {
  Fail 'cdp_failed' $_.Exception.Message
}
Write-Output $text

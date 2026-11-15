> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/direct-streaming/PLAN.md` phase 1. Source: `.workflows/plan/direct-streaming/phase-1.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 1: Provider seed, sniffer and resolver CLI

**Plan set:** `DIRECT_STREAMING_PLAN.md`
**Analysis:** `.workflows/analyze/20261115-182932-Z85Y_code_analyzer.md`
**Satisfies:** R1, the resolver: given a TMDB id, find a playable stream, English subtitle first, with no adverts and nothing shown or heard
**Criteria:** R1.1, R1.2, R1.3
**Depends on:** none
**Difficulty:** HARD
**Package:** `claude/streaming/direct`

---

## Goal

After this phase, `node claude/streaming/direct/cli.mjs resolve movie 550` opens provider embeds
one at a time in a background tab of the streaming Chrome, silent and out of sight, and prints one
JSON object naming the provider that resolved, the manifest, the headers its request really
carried and the subtitle tracks seen. Providers are data (a 24-entry seed), tried in one place's
order (English subtitle, then health, then quality), and a provider that answers with a bot check
is recorded as `bot_check` and passed over. Everything is unit tested with a fake sniffer; nothing
in `src/` or `web/` changes.

## Interface Contract

The reconciler reads this section to detect cross-phase conflicts. Be exact and exhaustive.

**Deletes:** nothing.

**Renames:** nothing.

**Creates:**

- `claude/streaming/direct/providers.seed.json`: an array of 24 objects
  `{ "name", "id_kind": "tmdb", "movie": "<url with {id}>", "tv": null, "browser_only": false, "en_subtitle": null, "notes": "" }`,
  in the fmovies chunk's order (VidNest first, MovieVault last). Phase 2 fills `tv`,
  `en_subtitle`, `browser_only`, `notes`.
- `claude/streaming/direct/sniff.ps1` (params `-UrlB64 -MuteJsB64 -MediaJsB64 [-Port 9333] [-Seconds 35] [-Linger 4] [-BotGrace 5] [-KeepTab]`;
  one line of JSON; on failure `{"error":"no_chrome"|"chrome_not_reachable"|"cdp_failed","detail":"..."}` and exit 3).
- `claude/streaming/direct/sniff.mjs`:
  - `SNIFF_DEFAULTS = { seconds: 35, linger: 4, botGraceS: 5, port: 9333 }` (frozen)
  - `MUTE_SCRIPT: string`, `MEDIA_EXPRESSION: string`
  - `parseSniffReply(stdout: string) -> SniffResult` (throws `ChromeError(code)` from `../chrome.mjs` on an `error` line)
  - `sniffEmbed(url: string, options?: { seconds?, linger?, botGraceS?, port? }) -> Promise<SniffResult>`
  - `SniffResult = { url, took_s, user_agent, bot_check: boolean, bot_check_reason: string|null, requests, clicks, popups_closed, tabs_left_open, frames: string[], hosts: string[], media: { elements, audible }, hits: Hit[] }`,
    `Hit = { at_s, type, url, referer, origin, user_agent, document, status, mime, body }` (header values are `string|null`; `body` is the response text for manifest-like 2xx hits, else `null`)
  - runnable: `node sniff.mjs <embed url> [--seconds n]` prints one `SniffResult` (diagnosis; phase 2 may use it)
- `claude/streaming/direct/order.mjs`: `orderProviders(providers, health) -> providers[]`, `englishTier(provider, health|null) -> 0|1|2`, `healthRank(health|null) -> number`.
- `claude/streaming/direct/resolve.mjs`:
  - `OUTCOMES = ['resolved','no_stream','bot_check','error','skipped_browser_only','skipped_no_template']`
  - `embedUrl(provider, ref) -> string|null`, `manifestKind(hit) -> 'hls'|'dash'|'mp4'|null`, `pickSource(sniff) -> Found|null`, `isEnglish(track) -> boolean`
  - `resolveTitle(ref, { providers, health = {}, sniff, only = null, sniffOptions = {}, clock, deadlineS = null }) -> Promise<Result>`
    (**added (reconciler):** `deadlineS`: once that many seconds have passed since the resolve began, no
    further provider is tried and the answer is `ok: false`, `error: "deadline"`, with the attempts made so far)
- `claude/streaming/direct/cli.mjs`: `main(argv, { sniff, open, readText, print }) -> Promise<exitCode>`,
  `parseArgs(argv)`, `readProviders(text)`, `readHealth(text)`,
  `openInChrome(url, { fullscreen }, { evaluate, wait } = {})`, `wantsStart(url, fullscreen)`,
  `START_EXPRESSION`, `START_TRIES`, `START_WAIT_MS`, `InputError(code, detail)`, `SEED_PATH`, `USAGE`.
- `tests/unit/scripts/directResolve.test.ts`, `tests/fixtures/direct-stream/{providers.json,check.html,stream.html,master.m3u8}`.

**The CLI, exactly (extends the index's Shared contracts; changes are marked "added"):**

```text
cli.mjs resolve <movie|tv> <tmdbId> [season episode] [--only <name>] [--providers <file>] [--health <file>] [--deadline-s <n>]
cli.mjs providers [--providers <file>] [--health <file>]
cli.mjs open <http://localhost|127.0.0.1 url> [--fullscreen]
```

- **Added (reconciler, for phase 10's per-pass budget):** `--deadline-s <n>` (a whole number of
  seconds, 1 or more). Once it has passed, no further provider is tried; the answer is `ok: false`
  with `error: "deadline"` and the attempts made so far. A provider already being sniffed is let
  finish. Phase 3 passes it as `resolve(input, { deadlineS })`.
- **Added (reconciler, D2 "one click to a full-screen film"):** `open <url> --fullscreen`, after the
  page has loaded, evaluates `START_EXPRESSION` in it (`window.notesdStream.start()`, which phase 4's
  player page defines: unmute and play) through `cdp.ps1`, whose `Runtime.evaluate` passes
  `userGesture: true`, so the film starts with sound as the spike's `v.play()` did. It retries every
  `START_WAIT_MS` (500 ms) up to `START_TRIES` (30) times while the page has not exposed `start` yet.
  Never when the address carries `muted=1` (phase 6's muted checks), and never without
  `--fullscreen`.

- stdout carries exactly one JSON object (pretty printed), nothing else. Exit `0` when `ok`,
  `1` when not (`no_source`, a Chrome failure, `unknown_provider`, `open_failed`), `2` for
  `usage` / `bad_providers` / `bad_health` (the answer is still printed on stdout). A runner
  must read stdout on a non-zero exit, as `scriptRunner` already does.
- `resolve` result, `ok: true`:
  `{ ok, kind, tmdb_id, season, episode, source: { provider, embed_url, manifest_url, manifest_kind, headers: { referer, origin, user_agent }, subtitles: [{ url, lang, label, format, source }], best_height, en_subtitle, took_s }, attempts: [{ provider, outcome, took_s, detail }] }`.
  - `manifest_kind`: `hls | dash | mp4` (added: `mp4` for a progressive file).
  - `headers.*`: `string | null`; null means the request did not carry that header (added: null in place of `""`).
  - `subtitles[].format`: `vtt | srt | hls | ttml | dash`; `subtitles[].source`: `request | manifest` (added); `lang` is `string | null`.
  - `source.en_subtitle: boolean` (added): some track is English.
  - `best_height: number | null`.
- `ok: false`: `{ ok: false, kind, tmdb_id, season, episode, source: null, error, attempts }`,
  `error` one of `no_source`, `no_chrome`, `chrome_not_reachable`, `unknown_provider` (with `detail`),
  `deadline` (with `detail`; added by the reconciler). Only `no_source` says the title has no source.
- `outcome` adds `skipped_no_template` (added: an episode asked of a provider whose `tv` is null).
- `providers` result: `{ ok: true, providers: [{ name, id_kind, movie, tv, browser_only, en_subtitle, notes, health: Health|null }] }`, in the order `resolve` would try them.
- `open` result: `{ ok: true, url, fullscreen, started }` or `{ ok: false, url, error: <ChromeError code>|'open_failed', detail }`.
  `started` (added by the reconciler): `true` when the page's `start()` ran, `false` when it was
  asked for and the page never exposed it (the page then shows its muted-start icon), `null` when
  it was not asked for (no `--fullscreen`, or `muted=1`). A start that does not happen never fails
  the `open`.
- `--providers <file>`: the same shape as the seed; extra fields (`origin_site`, `added_at`, ...) are
  accepted and ignored; `tv` must be present (`null` allowed).
- `--health <file>`: `{ "<name>": { en_subtitle?: boolean|null, best_height?: number|null, median_s?: number|null, last_success_at?: string|null, last_failure_at?: string|null, consecutive_failures?: number } }`;
  missing fields default to null / 0.

**Signature changes:** none (all new).

**Requires (from earlier phases):** nothing.

**Leaves alone (owned by others):** `src/**`, `web/**` (phases 3 to 10); `claude/streaming/{cli.mjs,cdp.ps1,chrome.mjs,play.mjs,match.mjs,sites/*}` (imported from, never edited); `docs/plans/direct-streaming-spike/*`; `docs/guide/streaming.md` (phase 3 creates the "Direct streaming" section, see Handoffs); the seed's `tv`/`en_subtitle`/`browser_only`/`notes` values (phase 2); `campaign.mjs` (phase 2); `templates.mjs` and the `templates` command (phase 8); `.claude/skills/verify-notesd/features/direct-streaming.md` and the features README (phase 3).

## Files

| File | Action | What changes |
|---|---|---|
| `claude/streaming/direct/providers.seed.json` | create | the 24 fmovies film templates as data |
| `claude/streaming/direct/sniff.ps1` | create | the spike's sniffer made a tool: background tab, muted pages, user agent, bot check, response bodies, bounded waits |
| `claude/streaming/direct/sniff.mjs` | create | WSL half: runs `sniff.ps1`, parses its line; the mute script; a diagnosis CLI |
| `claude/streaming/direct/order.mjs` | create | the D1 order, the one place it lives |
| `claude/streaming/direct/resolve.mjs` | create | embed address, picking the manifest from a capture, the try-in-order loop |
| `claude/streaming/direct/cli.mjs` | create | `resolve` (with `--deadline-s`), `providers`, `open` (a full-screen open starts the film with sound through the page's `start()`); input validation at the boundary |
| `tests/unit/scripts/directResolve.test.ts` | create | unit tests with a fake sniffer |
| `tests/fixtures/direct-stream/providers.json` | create | two local fixture providers for the live journey |
| `tests/fixtures/direct-stream/check.html` | create | a page that answers like a Cloudflare check |
| `tests/fixtures/direct-stream/stream.html` | create | a page that wants a click, then plays a tone and loads a manifest |
| `tests/fixtures/direct-stream/master.m3u8` | create | an HLS master with 480p, 1080p and an English subtitle group |
| `.claude/skills/verify-notesd/features/streaming.md` | modify (whole file, lines 1-30) | a resolver sub-feature, how to drive it, gotchas |

## Implementation Steps

### Step 1: The provider seed
**File:** `claude/streaming/direct/providers.seed.json` (new)
**Change:** the 24 templates from `docs/plans/direct-streaming-spike/fmovies-movie-details-chunk.js`
(object `$`), `${e}` written as `{id}`, in the chunk's order. Nothing learned yet: `tv` null,
`en_subtitle` null (unknown, which sorts between "has one" and "has none"), `browser_only` false,
`notes` empty. Phase 2 fills those from measurements.
**Code:**
```json
[
  { "name": "VidNest", "id_kind": "tmdb", "movie": "https://vidnest.fun/movie/{id}", "tv": null, "browser_only": false, "en_subtitle": null, "notes": "" },
  { "name": "Videasy", "id_kind": "tmdb", "movie": "https://player.videasy.net/movie/{id}", "tv": null, "browser_only": false, "en_subtitle": null, "notes": "" },
  { "name": "VidKing", "id_kind": "tmdb", "movie": "https://www.vidking.net/embed/movie/{id}", "tv": null, "browser_only": false, "en_subtitle": null, "notes": "" },
  { "name": "Peachify", "id_kind": "tmdb", "movie": "https://peachify.top/embed/movie/{id}", "tv": null, "browser_only": false, "en_subtitle": null, "notes": "" },
  { "name": "Smashy", "id_kind": "tmdb", "movie": "https://player.smashystream.com/movie/{id}", "tv": null, "browser_only": false, "en_subtitle": null, "notes": "" },
  { "name": "VidUp", "id_kind": "tmdb", "movie": "https://vidup.to/movie/{id}?autoPlay=true", "tv": null, "browser_only": false, "en_subtitle": null, "notes": "" },
  { "name": "VidFast", "id_kind": "tmdb", "movie": "https://vidfast.pro/movie/{id}?autoPlay=true", "tv": null, "browser_only": false, "en_subtitle": null, "notes": "" },
  { "name": "VidLink", "id_kind": "tmdb", "movie": "https://vidlink.pro/movie/{id}?autoplay=true&title=true", "tv": null, "browser_only": false, "en_subtitle": null, "notes": "" },
  { "name": "VidMov", "id_kind": "tmdb", "movie": "https://vidsrc.mov/embed/movie/{id}", "tv": null, "browser_only": false, "en_subtitle": null, "notes": "" },
  { "name": "VidFyi", "id_kind": "tmdb", "movie": "https://vidsrc.fyi/embed/movie/{id}", "tv": null, "browser_only": false, "en_subtitle": null, "notes": "" },
  { "name": "VidRock", "id_kind": "tmdb", "movie": "https://vidrock.net/movie/{id}", "tv": null, "browser_only": false, "en_subtitle": null, "notes": "" },
  { "name": "Movies111", "id_kind": "tmdb", "movie": "https://111movies.com/movie/{id}", "tv": null, "browser_only": false, "en_subtitle": null, "notes": "" },
  { "name": "NonTongo", "id_kind": "tmdb", "movie": "https://www.nontongo.win/embed/movie/{id}", "tv": null, "browser_only": false, "en_subtitle": null, "notes": "" },
  { "name": "VidSrc", "id_kind": "tmdb", "movie": "https://vidsrc.me/embed/movie?tmdb={id}", "tv": null, "browser_only": false, "en_subtitle": null, "notes": "" },
  { "name": "HyperLink", "id_kind": "tmdb", "movie": "https://vidsrc.wtf/api/1/movie/?id={id}&color=215fb3", "tv": null, "browser_only": false, "en_subtitle": null, "notes": "" },
  { "name": "NexaStream", "id_kind": "tmdb", "movie": "https://vidsrc.wtf/api/2/movie/?id={id}&color=215fb3", "tv": null, "browser_only": false, "en_subtitle": null, "notes": "" },
  { "name": "UltraBox", "id_kind": "tmdb", "movie": "https://player.vidplus.to/embed/movie/{id}", "tv": null, "browser_only": false, "en_subtitle": null, "notes": "" },
  { "name": "CloudBox", "id_kind": "tmdb", "movie": "https://vidify.top/embed/movie/{id}", "tv": null, "browser_only": false, "en_subtitle": null, "notes": "" },
  { "name": "UpCloud", "id_kind": "tmdb", "movie": "https://player.vidsrc.co/embed/movie/{id}", "tv": null, "browser_only": false, "en_subtitle": null, "notes": "" },
  { "name": "StreamVault", "id_kind": "tmdb", "movie": "https://hexa.watch/watch/movie/{id}", "tv": null, "browser_only": false, "en_subtitle": null, "notes": "" },
  { "name": "MediaHub", "id_kind": "tmdb", "movie": "https://spencerdevs.xyz/movie/{id}?theme=215fb3", "tv": null, "browser_only": false, "en_subtitle": null, "notes": "" },
  { "name": "CloudPlay", "id_kind": "tmdb", "movie": "https://vidsrc.cc/v2/embed/movie/{id}", "tv": null, "browser_only": false, "en_subtitle": null, "notes": "" },
  { "name": "StreamBoxHD", "id_kind": "tmdb", "movie": "https://test.autoembed.cc/embed/movie/{id}", "tv": null, "browser_only": false, "en_subtitle": null, "notes": "" },
  { "name": "MovieVault", "id_kind": "tmdb", "movie": "https://rivestream.org/embed?type=movie&id={id}", "tv": null, "browser_only": false, "en_subtitle": null, "notes": "" }
]
```
**Impact:** none on existing code. The unit test pins this list (Step 7).

### Step 2: The sniffer, Windows half
**File:** `claude/streaming/direct/sniff.ps1` (new)
**Change:** the spike's `sniff.ps1` (kept: start the streaming Chrome minimized when it is down,
attach flat to the page and auto-attach to every frame and worker, `Network.enable` everywhere,
close advert tabs the page opens, up to four real clicks at (400, 300) when no stream has shown up,
linger after the first manifest). Added:

- **Out of sight.** `Target.createTarget` with `background = $true`: the tab opens behind the
  active one, so a minimized window stays minimized and a film the owner is watching in this
  Chrome stays in front. Nothing here calls `Page.bringToFront`, `Browser.setWindowBounds`,
  `AppActivate` or `SendKeys` (a unit test greps for them).
- **Silent.** Before navigation, and in every page or frame session before it runs
  (`waitForDebuggerOnStart`), `Page.addScriptToEvaluateOnNewDocument` installs `MUTE_SCRIPT`:
  every media element is forced muted (setter, `play()`, and capture listeners for autoplay) and
  every `AudioContext` is suspended. Chrome's `--mute-audio` switch is browser-wide and fixed at
  launch, so it would also mute the owner's film in the same Chrome; it is not used. At the end
  `MEDIA_EXPRESSION` runs in the tab and its frames and reports `media.audible` (media elements
  playing unmuted), which is the observable proof of silence.
- **The tab's user agent** from `Browser.getVersion`, and per hit the `Referer`, `Origin` and
  `User-Agent` the request really carried: `Network.requestWillBeSentExtraInfo` (the headers on
  the wire) wins over `requestWillBeSent`'s. Nothing is set or overridden.
- **Bot check.** Seen when the tab's title is a challenge title ("Just a moment", "Attention
  Required", "Checking your browser", "One more step", "DDoS-Guard"), a frame or request goes to a
  challenge address (`challenges.cloudflare.com`, `/cdn-cgi/challenge-platform/`, hCaptcha,
  reCAPTCHA anchor/bframe), or a document answers `cf-mitigated: challenge`. From then on nothing
  is clicked, and the sniff ends `-BotGrace` seconds later unless a manifest arrives by itself
  (a real Chrome let through is not a disguise). Reported as `bot_check: true` plus a reason.
- **Response bodies** of up to 8 manifest-like 2xx hits (`Network.getResponseBody`, capped at
  256 KB), read before the tab closes: the resolver needs the master playlist for quality and
  in-manifest subtitle tracks, and reading what Chrome already has costs no second request.
- Only tabs opened by this tab or its frames are closed (the spike closed any tab with an
  opener, which could include the owner's). Pages that appear with no opener are counted in
  `tabs_left_open`, not closed.
- An `.mp4` response no longer ends the sniff as a manifest does (adverts are mp4): a manifest
  ends it after `-Linger`; an mp4 alone ends it 12 s later.
- Every wait is bounded (`Wait-Reply` returns `$null` on time-out) and the URL and scripts arrive
  base64, so no quoting can break the command line.
**Code:**
```powershell
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
  [switch]$KeepTab
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
# Tabs that exist before this one navigates (the owner's included) are never closed or counted.
$known = @{}
$existing = Wait-Reply (Send-Cdp 'Target.getTargets' @{})
if ($existing) { foreach ($t in @($existing.result.targetInfos)) { $known[$t.targetId] = 1 } }
# Tabs the page opens (adverts) are found here and closed; title changes show a bot check.
Send-Cdp 'Target.setDiscoverTargets' @{ discover = $true } | Out-Null
Send-Cdp 'Page.navigate' @{ url = $Url } $root | Out-Null

$interesting = '\.m3u8|\.mpd(\?|$)|\.mp4(\?|$)|\.vtt(\?|$)|\.srt(\?|$)|/playlist|/manifest|master\.'
$manifestUrl = '\.m3u8|\.mpd(\?|$)'
$manifestLike = '\.m3u8|\.mpd(\?|$)|master\.|/playlist|/manifest'
$mediaMime = 'mpegurl|dash\+xml|video/|text/vtt'
$segmentMime = 'video/mp2t|video/iso\.segment'
$botTitle = '^(Just a moment|Attention Required|Checking your browser|One more step|DDoS-Guard)'
$botUrl = 'challenges\.cloudflare\.com|/cdn-cgi/challenge-platform/|hcaptcha\.com/captcha|google\.com/recaptcha/(api2|enterprise)/(anchor|bframe)'
$events = '"method":"(Network\.requestWillBeSent|Network\.requestWillBeSentExtraInfo|Network\.responseReceived|Target\.attachedToTarget|Target\.targetCreated|Target\.targetInfoChanged)"'

$hits = New-Object System.Collections.ArrayList
$byRequest = @{}
$extra = @{}
$hosts = @{}
$frames = New-Object System.Collections.ArrayList
$popups = 0
$strays = 0
$requests = 0
$firstManifest = $null
$firstMp4 = $null
$clicks = 0
$script:botAt = $null
$script:botReason = $null
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

while ((Get-Date) -lt $deadline) {
  $now = Get-Date
  if ($firstManifest -and ($now - $firstManifest).TotalSeconds -gt $Linger) { break }
  if (-not $firstManifest -and $firstMp4 -and ($now - $firstMp4).TotalSeconds -gt 12) { break }
  if ($script:botAt -and -not $firstManifest -and ($now - $script:botAt).TotalSeconds -gt $BotGrace) { break }
  # No stream yet and no check: the player wants a press. A real click in the middle of the page.
  $elapsed = ($now - $t0).TotalSeconds
  if (-not $firstManifest -and -not $script:botAt -and $clicks -lt 4 -and $elapsed -gt (8 + 5 * $clicks)) {
    $clicks++
    foreach ($type in 'mouseMoved', 'mousePressed', 'mouseReleased') {
      Send-Cdp 'Input.dispatchMouseEvent' @{ type = $type; x = 400; y = 300; button = 'left'; buttons = 1; clickCount = 1 } $root | Out-Null
    }
  }
  try { $text = Receive-Message 250 } catch { break }
  if (-not $text) { continue }
  if ($text -notmatch $events) { continue }
  try { $m = $text | ConvertFrom-Json } catch { continue }
  switch ($m.method) {
    'Target.attachedToTarget' {
      $info = $m.params.targetInfo
      $ourTargets[$info.targetId] = 1
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
    }
    'Network.requestWillBeSentExtraInfo' {
      $extra[$m.params.requestId + '|' + $m.sessionId] = $m.params.headers
    }
    'Network.requestWillBeSent' {
      $requests++
      $req = $m.params.request
      try { $h = ([Uri]$req.url).Host } catch { $h = '' }
      if ($h) { $hosts[$h] = 1 + [int]$hosts[$h] }
      if ($req.url -match $botUrl) { Set-BotCheck "request $h" }
      if ($req.url -match $interesting -or $m.params.type -eq 'Media') {
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
      if ($m.params.type -eq 'Document' -and (Get-Header $res.headers 'cf-mitigated') -eq 'challenge') {
        Set-BotCheck "cf-mitigated on $($res.url)"
      }
      if ($byRequest.ContainsKey($key)) {
        $byRequest[$key].status = $res.status
        $byRequest[$key].mime = $res.mimeType
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
  if (-not ($hit.url -match $manifestLike -or "$($hit.mime)" -match 'mpegurl|dash\+xml')) { continue }
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
  requests = $requests
  clicks = $clicks
  popups_closed = $popups
  tabs_left_open = $strays
  frames = @($frames | Select-Object -Unique | Select-Object -First 12)
  hosts = @($topHosts)
  media = $media
  hits = $outHits
} | ConvertTo-Json -Depth 6 -Compress)
```
**Impact:** new file; nothing calls it until Step 3. Notes for the implementer:
`Target.targetCreated` also fires for every existing tab when discovery is switched on; the
`$known` set (from `Target.getTargets` before discovery) plus the `$ourTargets` check keep those,
the owner's tabs included, untouched. The `switch` above uses no `break`, so the loop's own
`break`s are not swallowed.

### Step 3: The sniffer, WSL half
**File:** `claude/streaming/direct/sniff.mjs` (new)
**Change:** runs `sniff.ps1` the way `chrome.mjs` runs `cdp.ps1` (same PowerShell path rule,
`cwd: '/mnt/c'`, exit 3 with the answer on stdout), passes the URL and both page scripts as
base64, and normalizes the reply (PowerShell can drop an empty array or flatten a one-element
one). A failure line becomes `ChromeError` from `../chrome.mjs` (imported, not edited).
Runnable as `node sniff.mjs <url>` for diagnosis.
**Code:**
```js
#!/usr/bin/env node
// The WSL half of the direct-streaming sniffer: runs sniff.ps1 through powershell.exe for one
// embed address and returns what it captured. The tab is opened out of sight and kept silent.
// Usage (diagnosis): sniff.mjs <embed url> [--seconds n]   prints one JSON object.
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { ChromeError } from '../chrome.mjs';

const run = promisify(execFile);
// The daemon runs under systemd without the Windows folders on its PATH, so name the usual place.
const POWERSHELL_PATH = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const POWERSHELL = existsSync(POWERSHELL_PATH) ? POWERSHELL_PATH : 'powershell.exe';
const SNIFF_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sniff.ps1');

export const SNIFF_DEFAULTS = Object.freeze({ seconds: 35, linger: 4, botGraceS: 5, port: 9333 });

/**
 * Installed in the tab and in every frame before any page script runs. Media elements cannot be
 * unmuted and Web Audio stays suspended, so a page that starts a film or an advert on the
 * sniffer's click is never heard. This is the page's own mute button, not a disguise: nothing
 * about the client changes.
 */
export const MUTE_SCRIPT = `(() => {
  if (window.__notesdSilent) return;
  window.__notesdSilent = true;
  const proto = HTMLMediaElement.prototype;
  const muted = Object.getOwnPropertyDescriptor(proto, 'muted');
  if (!muted || !muted.get || !muted.set) return;
  const silence = (el) => { try { muted.set.call(el, true); } catch {} };
  Object.defineProperty(proto, 'muted', {
    configurable: true,
    enumerable: muted.enumerable,
    get() { return muted.get.call(this); },
    set() { silence(this); },
  });
  const play = proto.play;
  proto.play = function () { silence(this); return play.apply(this, arguments); };
  for (const type of ['loadstart', 'play', 'playing', 'volumechange']) {
    addEventListener(type, (event) => {
      const el = event.target;
      if (el instanceof HTMLMediaElement && !muted.get.call(el)) silence(el);
    }, true);
  }
  for (const name of ['AudioContext', 'webkitAudioContext']) {
    const Base = window[name];
    if (typeof Base !== 'function') continue;
    window[name] = class extends Base {
      constructor(...args) { super(...args); Base.prototype.suspend.call(this).catch(() => {}); }
      resume() { return Promise.resolve(); }
    };
  }
})();`;

/** Evaluated in the tab and its frames at the end: what could have been heard. */
export const MEDIA_EXPRESSION = `(() => { const media = [...document.querySelectorAll('video, audio')]; return { elements: media.length, audible: media.filter((m) => !m.muted && !m.paused && m.volume > 0).length }; })()`;

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const list = (value) => (Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]);

/** The capture from sniff.ps1's last line of output; a named failure throws ChromeError. */
export function parseSniffReply(stdout) {
  const line = String(stdout ?? '').trim().split(/\r?\n/).pop() ?? '';
  let reply;
  try {
    reply = JSON.parse(line);
  } catch {
    throw new Error(`unreadable reply from the sniffer: ${line.slice(0, 200)}`);
  }
  if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) throw new Error(`unreadable reply from the sniffer: ${line.slice(0, 200)}`);
  if (typeof reply.error === 'string') throw new ChromeError(reply.error, reply.detail ?? '');
  return {
    url: reply.url ?? null,
    took_s: num(reply.took_s),
    user_agent: typeof reply.user_agent === 'string' ? reply.user_agent : null,
    bot_check: reply.bot_check === true,
    bot_check_reason: typeof reply.bot_check_reason === 'string' ? reply.bot_check_reason : null,
    requests: num(reply.requests),
    clicks: num(reply.clicks),
    popups_closed: num(reply.popups_closed),
    tabs_left_open: num(reply.tabs_left_open),
    frames: list(reply.frames),
    hosts: list(reply.hosts),
    media: { elements: num(reply.media?.elements), audible: num(reply.media?.audible) },
    hits: list(reply.hits),
  };
}

/**
 * Opens one embed address in a background tab of the streaming Chrome and returns what it
 * loaded. Throws ChromeError (no_chrome, chrome_not_reachable, cdp_failed) or Error.
 */
export async function sniffEmbed(url, options = {}) {
  const { seconds, linger, botGraceS, port } = { ...SNIFF_DEFAULTS, ...options };
  const { stdout: winScript } = await run('wslpath', ['-w', SNIFF_SCRIPT]);
  const args = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', winScript.trim(),
    '-UrlB64', b64(url), '-MuteJsB64', b64(MUTE_SCRIPT), '-MediaJsB64', b64(MEDIA_EXPRESSION),
    '-Port', String(port), '-Seconds', String(seconds), '-Linger', String(linger), '-BotGrace', String(botGraceS),
  ];
  let stdout;
  try {
    // powershell.exe cannot start in a Linux-only folder.
    ({ stdout } = await run(POWERSHELL, args, { cwd: '/mnt/c', timeout: (seconds + 90) * 1000, maxBuffer: 16 * 1024 * 1024 }));
  } catch (err) {
    // sniff.ps1 exits 3 with its reason on stdout.
    stdout = err?.stdout;
    if (!stdout) throw new Error(`powershell: ${String(err?.message ?? err).split('\n')[0]}`);
  }
  return parseSniffReply(stdout);
}

function isMain() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const [url, flag, value] = process.argv.slice(2);
  if (!url || (flag !== undefined && (flag !== '--seconds' || !/^\d+$/.test(value ?? '')))) {
    console.log(JSON.stringify({ error: 'usage', detail: 'sniff.mjs <embed url> [--seconds n]' }));
    process.exitCode = 2;
  } else {
    try {
      const options = flag === '--seconds' ? { seconds: Number(value) } : {};
      console.log(JSON.stringify(await sniffEmbed(url, options), null, 2));
    } catch (err) {
      console.log(JSON.stringify({ error: err instanceof ChromeError ? err.code : 'sniff_failed', detail: String(err?.message ?? err) }));
      process.exitCode = 1;
    }
  }
}
```
**Impact:** new file. No `process.env` read anywhere in `claude/streaming/direct/`, so
`docs:check`'s environment scan finds nothing new.

### Step 4: The order providers are tried in
**File:** `claude/streaming/direct/order.mjs` (new)
**Change:** D1 lives here and nowhere else. `en_subtitle` is three-valued on purpose: known yes
(0), unknown (1), known no (2), so an untested provider is not ranked as one without subtitles.
A measured value in `health` wins over the seed's. Then health (a recent success with no failure
since; no record or no verdict; then worse with each consecutive failure), then best height, then
median seconds, then seed order.
**Code:**
```js
// The order providers are tried in, the one place it lives (decision D1): a provider known to
// offer an English subtitle first, unknown next, known without one last; then health; then the
// best quality; then the quickest; then the order of the list.

/** 0: has an English subtitle, 1: not known, 2: has none. A measured value beats the seed's. */
export function englishTier(provider, health) {
  const measured = health?.en_subtitle;
  const known = measured === true || measured === false ? measured : provider.en_subtitle;
  if (known === true) return 0;
  if (known === false) return 2;
  return 1;
}

/** 0: worked last time; 1: no verdict yet; 2 and up: failed that many times in a row (capped). */
export function healthRank(health) {
  if (!health) return 1;
  const failures = health.consecutive_failures ?? 0;
  if (failures > 0) return 1 + Math.min(failures, 10);
  return health.last_success_at ? 0 : 1;
}

/** The providers in the order a resolve tries them. Does not drop any; the resolver skips. */
export function orderProviders(providers, health = {}) {
  const keyed = providers.map((provider, index) => {
    const h = Object.hasOwn(health, provider.name) ? health[provider.name] : null;
    return {
      provider,
      key: [englishTier(provider, h), healthRank(h), -(h?.best_height ?? 0), h?.median_s ?? Number.POSITIVE_INFINITY, index],
    };
  });
  keyed.sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) {
      if (a.key[i] !== b.key[i]) return a.key[i] < b.key[i] ? -1 : 1;
    }
    return 0;
  });
  return keyed.map((entry) => entry.provider);
}
```
**Impact:** new file.

### Step 5: The resolver
**File:** `claude/streaming/direct/resolve.mjs` (new)
**Change:** fill a template; pick the stream from a capture; try providers in order. The rules:

- A capture's stream is the best 2xx hit by rank: an HLS master (`#EXT-X-STREAM-INF`) or a DASH
  MPD first, then an HLS media playlist, then a progressive mp4; earliest wins inside a rank. The
  body decides the kind before the address or the mime type do (VidNest's `master.txt`).
- Headers are the chosen request's own; the user agent falls back to the tab's.
- Subtitles: HLS `#EXT-X-MEDIA:TYPE=SUBTITLES` and DASH text adaptation sets from the body
  (addresses made absolute against the manifest's), plus `.vtt` / `.srt` requests. A `.vtt`
  request in the folder of an HLS subtitle playlist is a segment of it and is not listed.
- The loop: `browser_only` is skipped (`skipped_browser_only`); an episode asked of a provider
  without a `tv` template is skipped (`skipped_no_template`); otherwise sniff. A stream means
  `resolved` and stop (also when a check was seen and the real Chrome got through by itself). No
  stream with a check seen means `bot_check`; no stream otherwise means `no_stream`; a thrown
  error means `error`, except `no_chrome` / `chrome_not_reachable`, which end the resolve at once
  (every other provider would fail the same way).
- R1.3's "without changing the client": the loop passes the same frozen `sniffOptions` object to
  every call and has no other knob. There is nothing to vary.
- A deadline (`deadlineS`, the CLI's `--deadline-s`): before a provider is sniffed, a resolve that
  has run that long stops and answers `error: "deadline"` with the attempts so far. Skips cost
  nothing and are still listed. The sniff in flight is never cut short.
**Code:**
```js
// Resolving a film or an episode: try providers in order, open each embed with the sniffer, and
// keep the first one that loaded a stream. Pure apart from the injected sniffer.
import { ChromeError } from '../chrome.mjs';
import { orderProviders } from './order.mjs';

export const OUTCOMES = Object.freeze(['resolved', 'no_stream', 'bot_check', 'error', 'skipped_browser_only', 'skipped_no_template']);

/** Failures that would hit every provider the same way: stop instead of trying the rest. */
const ABORTS = new Set(['no_chrome', 'chrome_not_reachable']);
const NO_OPTIONS = Object.freeze({});
const SUBTITLE_EXT = /\.(vtt|srt)$/i;

/** The embed address for a title, or null when the provider has no template for its kind. */
export function embedUrl(provider, ref) {
  const template = ref.kind === 'movie' ? provider.movie : provider.tv;
  if (!template) return null;
  return template
    .replaceAll('{id}', String(ref.tmdbId))
    .replaceAll('{season}', String(ref.season ?? ''))
    .replaceAll('{episode}', String(ref.episode ?? ''));
}

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

function dirOf(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/[^/]*$/, '');
  } catch {
    return null;
  }
}

function absolute(address, base) {
  try {
    return new URL(address, base).href;
  } catch {
    return null;
  }
}

const okStatus = (hit) => typeof hit.status === 'number' && hit.status >= 200 && hit.status < 300;

/** hls, dash or mp4 for a hit that is a stream, else null. The body decides first. */
export function manifestKind(hit) {
  const body = typeof hit.body === 'string' ? hit.body.trimStart() : '';
  if (body.startsWith('#EXTM3U')) return 'hls';
  if (/<MPD[\s>]/.test(body.slice(0, 4000))) return 'dash';
  const mime = String(hit.mime ?? '').toLowerCase();
  const file = pathOf(hit.url);
  if (mime.includes('mpegurl') || /\.m3u8$/i.test(file)) return 'hls';
  if (mime.includes('dash+xml') || /\.mpd$/i.test(file)) return 'dash';
  if (mime.startsWith('video/mp4') || /\.mp4$/i.test(file)) return 'mp4';
  return null;
}

function rank(hit, kind) {
  if (kind === 'dash') return 0;
  if (kind === 'hls') return typeof hit.body === 'string' && hit.body.includes('#EXT-X-STREAM-INF') ? 0 : 1;
  return 2;
}

/** HLS attribute list: KEY=value or KEY="value", comma separated. */
function attributes(text) {
  const out = {};
  for (const m of text.matchAll(/([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g)) out[m[1]] = m[3] ?? m[2];
  return out;
}

function xmlAttr(text, name) {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(text)?.[1] ?? null;
}

function hlsSubtitles(body, base) {
  const tracks = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('#EXT-X-MEDIA:')) continue;
    const a = attributes(line.slice('#EXT-X-MEDIA:'.length));
    if (a.TYPE !== 'SUBTITLES' || !a.URI) continue;
    const url = absolute(a.URI, base);
    if (url) tracks.push({ url, lang: a.LANGUAGE ?? null, label: a.NAME ?? null, format: 'hls', source: 'manifest' });
  }
  return tracks;
}

function dashSubtitles(body, base) {
  const tracks = [];
  for (const m of body.matchAll(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/g)) {
    const attrs = m[1] ?? '';
    const inner = m[2] ?? '';
    const mime = xmlAttr(attrs, 'mimeType') ?? xmlAttr(inner, 'mimeType') ?? '';
    const isText = xmlAttr(attrs, 'contentType') === 'text' || /^(text\/vtt|application\/ttml\+xml)/.test(mime);
    if (!isText) continue;
    const baseUrl = /<BaseURL>([^<]+)<\/BaseURL>/.exec(inner)?.[1];
    const url = baseUrl ? absolute(baseUrl.trim().replace(/&amp;/g, '&'), base) : null;
    if (!url) continue;
    const format = mime.startsWith('application/ttml') ? 'ttml' : mime.startsWith('text/vtt') ? 'vtt' : 'dash';
    tracks.push({ url, lang: xmlAttr(attrs, 'lang'), label: /<Label>([^<]*)<\/Label>/.exec(inner)?.[1] ?? null, format, source: 'manifest' });
  }
  return tracks;
}

function guessLang(url) {
  let text;
  try {
    text = decodeURIComponent(url).toLowerCase();
  } catch {
    text = url.toLowerCase();
  }
  return /(?:^|[^a-z])(en|eng|english)(?:[^a-z]|$)/.test(text) ? 'en' : null;
}

function requestSubtitles(hits, skipDirs) {
  const tracks = [];
  for (const hit of hits) {
    if (typeof hit.status === 'number' && !okStatus(hit)) continue;
    const ext = SUBTITLE_EXT.exec(pathOf(hit.url))?.[1]?.toLowerCase() ?? (/^text\/vtt/i.test(String(hit.mime ?? '')) ? 'vtt' : null);
    if (!ext) continue;
    if (ext === 'vtt' && skipDirs.has(dirOf(hit.url))) continue;
    tracks.push({ url: hit.url, lang: guessLang(hit.url), label: null, format: ext, source: 'request' });
  }
  return tracks;
}

/** An English track: lang en / eng / english (any region), or a label that says English. */
export function isEnglish(track) {
  const lang = String(track.lang ?? '').toLowerCase();
  return /^(en|eng|english)([-_].*)?$/.test(lang) || /english/i.test(String(track.label ?? ''));
}

function bestHeight(hit, kind) {
  const body = typeof hit.body === 'string' ? hit.body : '';
  const pattern = kind === 'hls' ? /RESOLUTION=\d+x(\d+)/g : kind === 'dash' ? /\bheight="(\d+)"/g : null;
  if (pattern === null) return null;
  let best = null;
  for (const m of body.matchAll(pattern)) {
    const height = Number(m[1]);
    if (best === null || height > best) best = height;
  }
  return best;
}

/**
 * The stream in one capture: the manifest, the headers its request carried, the subtitle tracks
 * seen, the best height. Null when the capture holds no stream.
 */
export function pickSource(sniff) {
  const hits = Array.isArray(sniff?.hits) ? sniff.hits : [];
  let best = null;
  for (const hit of hits) {
    if (!okStatus(hit)) continue;
    const kind = manifestKind(hit);
    if (kind === null) continue;
    const r = rank(hit, kind);
    if (best === null || r < best.rank) best = { hit, kind, rank: r };
  }
  if (best === null) return null;
  const { hit, kind } = best;
  const body = typeof hit.body === 'string' ? hit.body : '';
  const inManifest = kind === 'hls' ? hlsSubtitles(body, hit.url) : kind === 'dash' ? dashSubtitles(body, hit.url) : [];
  const skipDirs = new Set(inManifest.filter((t) => t.format === 'hls').map((t) => dirOf(t.url)));
  const seen = new Set();
  const subtitles = [...inManifest, ...requestSubtitles(hits, skipDirs)].filter((t) => (seen.has(t.url) ? false : (seen.add(t.url), true)));
  return {
    manifest_url: hit.url,
    manifest_kind: kind,
    headers: { referer: hit.referer ?? null, origin: hit.origin ?? null, user_agent: hit.user_agent ?? sniff.user_agent ?? null },
    subtitles,
    best_height: bestHeight(hit, kind),
    en_subtitle: subtitles.some(isEnglish),
  };
}

const seconds = (ms) => Math.round(ms / 100) / 10;
const attempt = (provider, outcome, tookS, detail) => ({ provider: provider.name, outcome, took_s: tookS, detail });

function describe(found) {
  const height = found.best_height ? ` ${found.best_height}p` : '';
  const english = found.en_subtitle ? ', English' : '';
  return `${found.manifest_kind}${height}, ${found.subtitles.length} subtitle track(s)${english}`;
}

/**
 * Resolves a title: providers in the D1 order, the first stream wins. `ref` is
 * { kind: 'movie' | 'tv', tmdbId, season, episode }, already validated. `sniff(url, options)` is
 * the sniffer (sniffEmbed in use, a fake in tests); every call gets the same options object.
 * `deadlineS` (null: none): once that many seconds have passed, no further provider is sniffed and
 * the answer is `error: "deadline"` (it says nothing about the title).
 */
export async function resolveTitle(ref, { providers, health = {}, sniff, only = null, sniffOptions = NO_OPTIONS, clock = () => performance.now(), deadlineS = null }) {
  const base = { kind: ref.kind, tmdb_id: ref.tmdbId, season: ref.season ?? null, episode: ref.episode ?? null };
  let candidates = orderProviders(providers, health);
  if (only !== null) {
    candidates = candidates.filter((p) => p.name.toLowerCase() === only.toLowerCase());
    if (candidates.length === 0) return { ok: false, ...base, source: null, error: 'unknown_provider', detail: `no provider named ${only}`, attempts: [] };
  }
  const attempts = [];
  const begun = clock();
  for (const [index, provider] of candidates.entries()) {
    if (provider.browser_only) {
      attempts.push(attempt(provider, 'skipped_browser_only', 0, 'plays only inside its own page'));
      continue;
    }
    const url = embedUrl(provider, ref);
    if (url === null) {
      attempts.push(attempt(provider, 'skipped_no_template', 0, `no ${ref.kind} template`));
      continue;
    }
    if (deadlineS !== null && clock() - begun >= deadlineS * 1000) {
      const left = candidates.length - index;
      return { ok: false, ...base, source: null, error: 'deadline', detail: `stopped after ${seconds(clock() - begun)} s; ${left} provider(s) not tried`, attempts };
    }
    const started = clock();
    let sniffed;
    try {
      sniffed = await sniff(url, sniffOptions);
    } catch (err) {
      attempts.push(attempt(provider, 'error', seconds(clock() - started), String(err?.message ?? err)));
      if (err instanceof ChromeError && ABORTS.has(err.code)) return { ok: false, ...base, source: null, error: err.code, attempts };
      continue;
    }
    const tookS = seconds(clock() - started);
    const found = pickSource(sniffed);
    if (found) {
      attempts.push(attempt(provider, 'resolved', tookS, describe(found)));
      return { ok: true, ...base, source: { provider: provider.name, embed_url: url, ...found, took_s: tookS }, attempts };
    }
    if (sniffed.bot_check) {
      attempts.push(attempt(provider, 'bot_check', tookS, sniffed.bot_check_reason ?? 'bot check'));
      continue;
    }
    const detail = `${sniffed.requests ?? 0} requests, ${sniffed.hits?.length ?? 0} media hits, ${sniffed.clicks ?? 0} clicks, ${sniffed.popups_closed ?? 0} advert tabs closed`;
    attempts.push(attempt(provider, 'no_stream', tookS, detail));
  }
  return { ok: false, ...base, source: null, error: 'no_source', attempts };
}
```
**Impact:** new file.

### Step 6: The command
**File:** `claude/streaming/direct/cli.mjs` (new)
**Change:** the boundary. `parseArgs` validates argv once (kind, a positive TMDB id, season and
episode only and always for `tv`, known flags per command, `open` only to a loopback http
address); `readProviders` / `readHealth` validate the files once and return normalized objects;
`order.mjs` and `resolve.mjs` trust them. `open` is the spike's `play.mjs` step through
`evaluateInChrome` (imported), with `play.mjs`'s one retry for a Chrome that is just closing. It
does not close other tabs (a resolve may have one open). With `--fullscreen` and no `muted=1` in
the address, it then starts the film with sound: it evaluates `START_EXPRESSION` in the page (the
player's `window.notesdStream.start()`, phase 4) through `cdp.ps1`, whose `Runtime.evaluate`
carries `userGesture: true`, retrying while the page loads. `--deadline-s` is read here and passed
to `resolveTitle`. Phase 8 adds a `templates` case to `parseArgs` and `main`.
**Code:**
```js
#!/usr/bin/env node
// The direct-streaming resolver: finds a playable stream for a film or an episode by opening
// provider embeds in the streaming Chrome, out of sight and silent, and opens daemon pages there.
// Usage:
//   cli.mjs resolve <movie|tv> <tmdbId> [season episode] [--only <name>] [--providers <file>] [--health <file>] [--deadline-s <n>]
//   cli.mjs providers [--providers <file>] [--health <file>]
//   cli.mjs open <http://localhost:<port>/...> [--fullscreen]
// Prints one JSON object. Exit 0 when ok, 1 when not, 2 for a usage or input error.
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ChromeError, evaluateInChrome, sleep } from '../chrome.mjs';
import { orderProviders } from './order.mjs';
import { resolveTitle } from './resolve.mjs';
import { sniffEmbed } from './sniff.mjs';

export const SEED_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'providers.seed.json');
export const USAGE =
  'resolve <movie|tv> <tmdbId> [season episode] [--only <name>] [--providers <file>] [--health <file>] [--deadline-s <n>] | providers [--providers <file>] [--health <file>] | open <http://localhost:<port>/...> [--fullscreen]';

/**
 * Evaluated in the player page after `open --fullscreen`: phase 4's page exposes
 * window.notesdStream.start() (unmute and play). cdp.ps1 evaluates with userGesture: true, so
 * Chrome lets the film start with sound. 'waiting' while the page has not exposed it yet.
 */
export const START_EXPRESSION =
  "(async () => { const s = window.notesdStream; if (!s || typeof s.start !== 'function') return 'waiting'; await s.start(); return 'started'; })()";
/** Tries of START_EXPRESSION, START_WAIT_MS apart: 15 s for the page to load and read its session. */
export const START_TRIES = 30;
export const START_WAIT_MS = 500;

/** Bad input, named: usage, bad_providers or bad_health. */
export class InputError extends Error {
  constructor(code, detail) {
    super(detail);
    this.code = code;
  }
}

const VALUE_FLAGS = new Set(['--only', '--providers', '--health', '--deadline-s']);
const SWITCH_FLAGS = new Set(['--fullscreen']);
const WHOLE = /^\d+$/;
const DAEMON_HOSTS = new Set(['localhost', '127.0.0.1']);

function wholeNumber(text, min) {
  if (!WHOLE.test(text ?? '')) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= min ? n : null;
}

function parseRef(args) {
  const [kind, id, season, episode, ...extra] = args;
  if (kind !== 'movie' && kind !== 'tv') throw new InputError('usage', 'the kind is movie or tv');
  const tmdbId = wholeNumber(id, 1);
  if (tmdbId === null) throw new InputError('usage', 'the TMDB id is a positive whole number');
  if (extra.length > 0) throw new InputError('usage', 'too many arguments');
  if (kind === 'movie') {
    if (season !== undefined) throw new InputError('usage', 'a film takes no season or episode');
    return { kind, tmdbId, season: null, episode: null };
  }
  const s = wholeNumber(season, 0);
  const e = wholeNumber(episode, 1);
  if (s === null || e === null) throw new InputError('usage', 'an episode needs a season (0 or more) and an episode (1 or more)');
  return { kind, tmdbId, season: s, episode: e };
}

function parseDaemonUrl(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new InputError('usage', `not an address: ${text}`);
  }
  if (url.protocol !== 'http:' || !DAEMON_HOSTS.has(url.hostname)) throw new InputError('usage', 'open takes a daemon page: http://localhost:<port>/...');
  return url.href;
}

/** The command line, validated. Throws InputError('usage'). */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new InputError('usage', `${arg} needs a value`);
      flags[arg.slice(2)] = value;
      i++;
    } else if (SWITCH_FLAGS.has(arg)) {
      flags[arg.slice(2)] = true;
    } else if (arg.startsWith('--')) {
      throw new InputError('usage', `unknown flag ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  const [command, ...rest] = positional;
  const allow = (names) => {
    for (const name of Object.keys(flags)) {
      if (!names.includes(name)) throw new InputError('usage', `--${name} does not apply to ${command}`);
    }
  };
  switch (command) {
    case 'resolve': {
      allow(['only', 'providers', 'health', 'deadline-s']);
      const deadlineS = flags['deadline-s'] === undefined ? null : wholeNumber(flags['deadline-s'], 1);
      if (flags['deadline-s'] !== undefined && deadlineS === null) throw new InputError('usage', '--deadline-s is a whole number of seconds, 1 or more');
      return { command, ref: parseRef(rest), only: flags.only ?? null, providersFile: flags.providers ?? null, healthFile: flags.health ?? null, deadlineS };
    }
    case 'providers':
      allow(['providers', 'health']);
      if (rest.length > 0) throw new InputError('usage', 'providers takes no arguments');
      return { command, providersFile: flags.providers ?? null, healthFile: flags.health ?? null };
    case 'open':
      allow(['fullscreen']);
      if (rest.length !== 1) throw new InputError('usage', 'open takes one address');
      return { command, url: parseDaemonUrl(rest[0]), fullscreen: flags.fullscreen === true };
    default:
      throw new InputError('usage', command === undefined ? 'no command' : `unknown command "${command}"`);
  }
}

function parseJson(text, code) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new InputError(code, `not JSON: ${err.message}`);
  }
}

function isTemplate(value, placeholders) {
  if (typeof value !== 'string' || !/^https?:\/\//.test(value)) return false;
  if (!placeholders.every((p) => value.includes(p))) return false;
  try {
    new URL(value.replace(/\{(id|season|episode)\}/g, '1'));
    return true;
  } catch {
    return false;
  }
}

/** A providers file (the seed, or the registry's rows), validated. Extra fields are dropped. */
export function readProviders(text) {
  const data = parseJson(text, 'bad_providers');
  if (!Array.isArray(data) || data.length === 0) throw new InputError('bad_providers', 'expected a non-empty array of providers');
  const seen = new Set();
  return data.map((entry, index) => {
    const label = entry !== null && typeof entry === 'object' && typeof entry.name === 'string' ? ` (${entry.name})` : '';
    const bad = (why) => new InputError('bad_providers', `provider ${index}${label}: ${why}`);
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw bad('not an object');
    const { name, id_kind, movie, tv, browser_only, en_subtitle, notes } = entry;
    if (typeof name !== 'string' || name.trim() === '') throw bad('name is empty');
    if (seen.has(name.toLowerCase())) throw bad('name is used twice');
    seen.add(name.toLowerCase());
    if (id_kind !== 'tmdb') throw bad('id_kind must be "tmdb"');
    if (!isTemplate(movie, ['{id}'])) throw bad('movie must be an http(s) address with {id}');
    if (tv !== null && !isTemplate(tv, ['{id}', '{season}', '{episode}'])) throw bad('tv must be null or an http(s) address with {id}, {season} and {episode}');
    if (typeof browser_only !== 'boolean') throw bad('browser_only must be true or false');
    if (en_subtitle !== true && en_subtitle !== false && en_subtitle !== null) throw bad('en_subtitle must be true, false or null');
    if (typeof notes !== 'string') throw bad('notes must be a string');
    return { name, id_kind, movie, tv, browser_only, en_subtitle, notes };
  });
}

/** A health file: provider name -> what this host measured. Missing fields become null / 0. */
export function readHealth(text) {
  const data = parseJson(text, 'bad_health');
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new InputError('bad_health', 'expected an object keyed by provider name');
  const health = {};
  for (const [name, h] of Object.entries(data)) {
    const bad = (why) => new InputError('bad_health', `${name}: ${why}`);
    if (h === null || typeof h !== 'object' || Array.isArray(h)) throw bad('not an object');
    const number = (key) => {
      const v = h[key];
      if (v === undefined || v === null) return null;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw bad(`${key} must be a number`);
      return v;
    };
    const string = (key) => {
      const v = h[key];
      if (v === undefined || v === null) return null;
      if (typeof v !== 'string') throw bad(`${key} must be a string`);
      return v;
    };
    const en = h.en_subtitle ?? null;
    if (en !== true && en !== false && en !== null) throw bad('en_subtitle must be true, false or null');
    health[name] = {
      en_subtitle: en,
      best_height: number('best_height'),
      median_s: number('median_s'),
      last_success_at: string('last_success_at'),
      last_failure_at: string('last_failure_at'),
      consecutive_failures: Math.floor(number('consecutive_failures') ?? 0),
    };
  }
  return health;
}

/** A full-screen open starts the film with sound, except for a muted check (`?muted=1`, phase 6). */
export function wantsStart(url, fullscreen) {
  return fullscreen === true && new URL(url).searchParams.get('muted') !== '1';
}

/**
 * Opens a daemon page in the streaming Chrome, in front, full screen when asked. Never throws.
 * Other tabs are left alone: a resolve may have one open. With `fullscreen` (and no `muted=1`),
 * it then calls the player's start() as a user gesture so the film plays with sound (D2); a page
 * that never exposes start() leaves `started: false` and the page's own muted start stands.
 * `evaluate` and `wait` are test seams (evaluateInChrome and sleep in use).
 */
export async function openInChrome(url, { fullscreen }, { evaluate = evaluateInChrome, wait = sleep } = {}) {
  const target = new URL(url);
  const where = `${target.pathname}${target.search}${target.hash}`;
  const go = () => evaluate(target.origin, `location.assign(${JSON.stringify(where)}); 'ok'`, { show: true, windowState: fullscreen ? 'fullscreen' : 'normal' });
  try {
    // A Chrome that is just closing still answers its port and then drops the call. Once more
    // starts a fresh one (as claude/streaming/play.mjs does).
    await go().catch(async (err) => {
      if (!(err instanceof ChromeError)) throw err;
      await wait(2500);
      return go();
    });
  } catch (err) {
    return { ok: false, url, error: err instanceof ChromeError ? err.code : 'open_failed', detail: String(err?.message ?? err) };
  }
  let started = null;
  if (wantsStart(url, fullscreen)) {
    started = false;
    for (let i = 0; i < START_TRIES && !started; i++) {
      await wait(START_WAIT_MS);
      try {
        // The tab is the one just navigated (cdp.ps1 picks the loaded tab on the daemon's host).
        started = (await evaluate(target.origin, START_EXPRESSION, {})) === 'started';
      } catch {
        // The page is still loading (no title yet, so cdp.ps1 finds no tab): try again.
      }
    }
  }
  return { ok: true, url, fullscreen, started };
}

const printJson = (value) => console.log(JSON.stringify(value, null, 2));

function readInput(readText, file, code) {
  try {
    return readText(file);
  } catch (err) {
    throw new InputError(code, `cannot read ${file}: ${err?.message ?? err}`);
  }
}

/** Runs one command and prints one JSON object. Returns the exit code. Everything is injectable. */
export async function main(argv, io = {}) {
  const { sniff = sniffEmbed, open = openInChrome, readText = (file) => readFileSync(file, 'utf8'), print = printJson } = io;
  let args;
  let providers = [];
  let health = {};
  try {
    args = parseArgs(argv);
    if (args.command !== 'open') {
      providers = readProviders(readInput(readText, args.providersFile ?? SEED_PATH, 'bad_providers'));
      health = args.healthFile === null ? {} : readHealth(readInput(readText, args.healthFile, 'bad_health'));
    }
  } catch (err) {
    if (!(err instanceof InputError)) throw err;
    print(err.code === 'usage' ? { ok: false, error: err.code, detail: err.message, usage: USAGE } : { ok: false, error: err.code, detail: err.message });
    return 2;
  }
  if (args.command === 'providers') {
    print({ ok: true, providers: orderProviders(providers, health).map((p) => ({ ...p, health: Object.hasOwn(health, p.name) ? health[p.name] : null })) });
    return 0;
  }
  if (args.command === 'open') {
    const result = await open(args.url, { fullscreen: args.fullscreen });
    print(result);
    return result.ok ? 0 : 1;
  }
  const result = await resolveTitle(args.ref, { providers, health, sniff, only: args.only, deadlineS: args.deadlineS });
  print(result);
  return result.ok ? 0 : 1;
}

// Reached through a symlink from ~/.claude/skills one day, so compare real paths.
function isMain() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = await main(process.argv.slice(2));
}
```
**Impact:** new file. `chrome.mjs` is imported, not changed.

### Step 7: Unit tests with a fake sniffer
**File:** `tests/unit/scripts/directResolve.test.ts` (new)
**Change:** behaviour through the public functions and the printed JSON. The sniffer is faked at
its boundary (`sniff(url, options)`); the mute script is run in a `vm` context against fake media
and audio classes; `sniff.ps1` is checked for the calls that would raise a window or change the
client (invariants 2 and 7 as a test, not a sentence).
**Code:**
```ts
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { ChromeError } from '../../../claude/streaming/chrome.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { main, openInChrome, parseArgs, readHealth, readProviders, SEED_PATH, START_EXPRESSION, wantsStart } from '../../../claude/streaming/direct/cli.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { orderProviders } from '../../../claude/streaming/direct/order.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { embedUrl, pickSource, resolveTitle } from '../../../claude/streaming/direct/resolve.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { MEDIA_EXPRESSION, MUTE_SCRIPT, parseSniffReply } from '../../../claude/streaming/direct/sniff.mjs';

type Json = Record<string, any>;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const MASTER = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="subs/en.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480,SUBTITLES="subs"',
  '480/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=3840x2160,SUBTITLES="subs"',
  '2160/index.m3u8',
].join('\n');
const MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">
 <Period>
  <AdaptationSet contentType="video" mimeType="video/mp4" maxHeight="1080">
   <Representation id="v480" bandwidth="900000" width="854" height="480"/>
   <Representation id="v1080" bandwidth="5000000" width="1920" height="1080"/>
  </AdaptationSet>
  <AdaptationSet contentType="text" mimeType="text/vtt" lang="en">
   <Label>English</Label>
   <Representation id="sub-en" bandwidth="256"><BaseURL>subs/en.vtt</BaseURL></Representation>
  </AdaptationSet>
 </Period>
</MPD>`;

const hit = (over: Json): Json => ({ at_s: 2, type: 'XHR', url: '', referer: 'https://vidfast.vc/', origin: 'https://vidfast.vc', user_agent: UA, document: null, status: 200, mime: null, body: null, ...over });
const capture = (over: Json = {}): Json => ({
  url: '', took_s: 2.3, user_agent: UA, bot_check: false, bot_check_reason: null, requests: 40, clicks: 0, popups_closed: 0, tabs_left_open: 0,
  frames: [], hosts: [], media: { elements: 1, audible: 0 }, hits: [], ...over,
});
const streamCapture = (over: Json = {}): Json =>
  capture({
    hits: [
      hit({ url: 'https://cdn.example/hls/master.m3u8?token=abc', mime: 'application/vnd.apple.mpegurl', body: MASTER }),
      hit({ at_s: 2.4, url: 'https://cdn.example/hls/2160/index.m3u8?token=abc', mime: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n#EXTINF:6,\nseg0.ts' }),
      hit({ at_s: 2.6, url: 'https://cdn.example/hls/subs/seg-0.vtt', mime: 'text/vtt' }),
    ],
    ...over,
  });
const botCapture = (): Json => capture({ requests: 6, bot_check: true, bot_check_reason: 'title Just a moment...' });

const provider = (name: string, over: Json = {}): Json => ({
  name, id_kind: 'tmdb', movie: `https://${name.toLowerCase()}.example/movie/{id}`, tv: null, browser_only: false, en_subtitle: null, notes: '', ...over,
});
const names = (list: Json[]): string[] => list.map((p) => p.name);

/** A sniffer that answers by the embed's host name; anything unknown loaded no stream. */
function fakeSniffer(byHost: Record<string, Json | Error>) {
  const calls: Array<{ url: string; options: unknown }> = [];
  const sniff = async (url: string, options: unknown): Promise<Json> => {
    calls.push({ url, options });
    const answer = byHost[new URL(url).hostname];
    if (answer instanceof Error) throw answer;
    return answer ?? capture();
  };
  return { sniff, calls };
}

const MOVIE = { kind: 'movie', tmdbId: 550, season: null, episode: null };

describe('the provider seed', () => {
  const seed: Json[] = readProviders(readFileSync(SEED_PATH, 'utf8'));

  it('holds the 24 fmovies providers, films only, nothing learned yet', () => {
    expect(names(seed)).toEqual([
      'VidNest', 'Videasy', 'VidKing', 'Peachify', 'Smashy', 'VidUp', 'VidFast', 'VidLink', 'VidMov', 'VidFyi', 'VidRock', 'Movies111',
      'NonTongo', 'VidSrc', 'HyperLink', 'NexaStream', 'UltraBox', 'CloudBox', 'UpCloud', 'StreamVault', 'MediaHub', 'CloudPlay', 'StreamBoxHD', 'MovieVault',
    ]);
    for (const p of seed) {
      expect(p.movie).toMatch(/^https:\/\/[^/]+\/.*\{id\}/);
      expect(p).toMatchObject({ id_kind: 'tmdb', tv: null, browser_only: false, en_subtitle: null, notes: '' });
    }
  });

  it('fills a template with the TMDB id, and has no address for an episode without a tv template', () => {
    const byName = Object.fromEntries(seed.map((p) => [p.name, p]));
    expect(embedUrl(byName.VidFast, MOVIE)).toBe('https://vidfast.pro/movie/550?autoPlay=true');
    expect(embedUrl(byName.VidSrc, MOVIE)).toBe('https://vidsrc.me/embed/movie?tmdb=550');
    expect(embedUrl(byName.VidFast, { kind: 'tv', tmdbId: 1399, season: 1, episode: 2 })).toBeNull();
    const withTv = provider('Beta', { tv: 'https://beta.example/tv/{id}/{season}/{episode}' });
    expect(embedUrl(withTv, { kind: 'tv', tmdbId: 1399, season: 1, episode: 2 })).toBe('https://beta.example/tv/1399/1/2');
  });
});

describe('reading providers and health', () => {
  const bad = (entries: Json[]): (() => unknown) => () => readProviders(JSON.stringify(entries));

  it('refuses a providers file it cannot trust', () => {
    expect(bad([provider('A'), provider('a')])).toThrow(/used twice/);
    expect(bad([provider('A', { movie: 'https://a.example/movie' })])).toThrow(/\{id\}/);
    expect(bad([provider('A', { tv: 'https://a.example/tv/{id}/{season}' })])).toThrow(/tv must be/);
    expect(bad([provider('A', { id_kind: 'imdb' })])).toThrow(/id_kind/);
    expect(bad([provider('A', { en_subtitle: 'yes' })])).toThrow(/en_subtitle/);
    expect(() => readProviders('[]')).toThrow(/non-empty/);
  });

  it('accepts registry rows with extra fields and drops them', () => {
    const [row] = readProviders(JSON.stringify([provider('A', { origin_site: 'https://ww6-fmovies.com', added_at: '2026-11-15' })]));
    expect(Object.keys(row)).toEqual(['name', 'id_kind', 'movie', 'tv', 'browser_only', 'en_subtitle', 'notes']);
  });

  it('fills what a health entry leaves out, and refuses a list', () => {
    expect(readHealth('{"VidFast":{"en_subtitle":true}}')).toEqual({
      VidFast: { en_subtitle: true, best_height: null, median_s: null, last_success_at: null, last_failure_at: null, consecutive_failures: 0 },
    });
    expect(() => readHealth('[]')).toThrow(/keyed by provider name/);
    expect(() => readHealth('{"A":{"best_height":"tall"}}')).toThrow(/best_height/);
  });
});

describe('the order providers are tried in (R1.2)', () => {
  it('puts a known English subtitle first, unknown next, known none last', () => {
    const list = [provider('A'), provider('B', { en_subtitle: false }), provider('C', { en_subtitle: true }), provider('D')];
    expect(names(orderProviders(list, {}))).toEqual(['C', 'A', 'D', 'B']);
  });

  it('ranks by English subtitle before health', () => {
    const health = readHealth(JSON.stringify({ E1: { consecutive_failures: 3 }, E2: { last_success_at: '2026-11-15T10:00:00Z', best_height: 2160 } }));
    expect(names(orderProviders([provider('E2', { en_subtitle: false }), provider('E1', { en_subtitle: true })], health))).toEqual(['E1', 'E2']);
  });

  it('ranks by health before quality, then quality, then list order', () => {
    const list = [provider('P1', { en_subtitle: true }), provider('P2', { en_subtitle: true }), provider('P3', { en_subtitle: true }), provider('P4', { en_subtitle: true })];
    const health = readHealth(
      JSON.stringify({
        P1: { consecutive_failures: 2, best_height: 4320 },
        P2: { last_success_at: '2026-11-15T10:00:00Z', best_height: 720 },
        P3: { last_success_at: '2026-11-15T10:00:00Z', best_height: 2160 },
      }),
    );
    expect(names(orderProviders(list, health))).toEqual(['P3', 'P2', 'P4', 'P1']);
    expect(names(orderProviders([provider('X'), provider('Y')], {}))).toEqual(['X', 'Y']);
  });

  it('lets what this host measured override the seed', () => {
    const health = readHealth('{"Late":{"en_subtitle":true}}');
    expect(names(orderProviders([provider('Early'), provider('Late', { en_subtitle: false })], health))).toEqual(['Late', 'Early']);
  });
});

describe('picking the stream out of a capture', () => {
  it('takes the HLS master with its headers, best height and in-manifest English track', () => {
    const found = pickSource(streamCapture());
    expect(found).toEqual({
      manifest_url: 'https://cdn.example/hls/master.m3u8?token=abc',
      manifest_kind: 'hls',
      headers: { referer: 'https://vidfast.vc/', origin: 'https://vidfast.vc', user_agent: UA },
      subtitles: [{ url: 'https://cdn.example/hls/subs/en.m3u8', lang: 'en', label: 'English', format: 'hls', source: 'manifest' }],
      best_height: 2160,
      en_subtitle: true,
    });
  });

  it("falls back to the tab's user agent and keeps a missing header null", () => {
    const found = pickSource(capture({ hits: [hit({ url: 'https://cdn.example/a.m3u8', origin: null, user_agent: null, body: MASTER })] }));
    expect(found.headers).toEqual({ referer: 'https://vidfast.vc/', origin: null, user_agent: UA });
  });

  it('reads a playlist behind an address that does not look like one', () => {
    const found = pickSource(capture({ hits: [hit({ url: 'https://vidnest.example/v/master.txt', mime: 'text/plain', body: MASTER })] }));
    expect(found.manifest_kind).toBe('hls');
    expect(found.best_height).toBe(2160);
  });

  it('takes a DASH manifest with its text track and a separate .srt request', () => {
    const found = pickSource(
      capture({
        hits: [
          hit({ url: 'https://dash.example/v/manifest.mpd', mime: 'application/dash+xml', body: MPD }),
          hit({ at_s: 3, url: 'https://subs.example/fight-club/English.srt', mime: 'application/x-subrip' }),
        ],
      }),
    );
    expect(found.manifest_kind).toBe('dash');
    expect(found.best_height).toBe(1080);
    expect(found.subtitles).toEqual([
      { url: 'https://dash.example/v/subs/en.vtt', lang: 'en', label: 'English', format: 'vtt', source: 'manifest' },
      { url: 'https://subs.example/fight-club/English.srt', lang: 'en', label: null, format: 'srt', source: 'request' },
    ]);
    expect(found.en_subtitle).toBe(true);
  });

  it('finds no stream in refused requests or an empty capture', () => {
    expect(pickSource(capture({ hits: [hit({ url: 'https://cdn.example/master.m3u8', status: 403, body: MASTER })] }))).toBeNull();
    expect(pickSource(capture())).toBeNull();
  });
});

describe('resolving a title (R1.1, R1.3)', () => {
  it('skips a provider that answers with a bot check, records it, and tries the next with the same client', async () => {
    const { sniff, calls } = fakeSniffer({ 'alpha.example': botCapture(), 'beta.example': streamCapture() });
    const result = await resolveTitle(MOVIE, { providers: [provider('Alpha'), provider('Beta')], sniff });
    expect(result.ok).toBe(true);
    expect(result.source.provider).toBe('Beta');
    expect(result.attempts.map((a: Json) => [a.provider, a.outcome])).toEqual([
      ['Alpha', 'bot_check'],
      ['Beta', 'resolved'],
    ]);
    expect(result.attempts[0].detail).toBe('title Just a moment...');
    expect(calls.map((c) => c.url)).toEqual(['https://alpha.example/movie/550', 'https://beta.example/movie/550']);
    expect(calls[1]?.options).toBe(calls[0]?.options);
  });

  it('keeps a stream the real Chrome reached even when a check was seen on the way', async () => {
    const { sniff } = fakeSniffer({ 'alpha.example': streamCapture({ bot_check: true, bot_check_reason: 'frame challenges.cloudflare.com' }) });
    const result = await resolveTitle(MOVIE, { providers: [provider('Alpha')], sniff });
    expect(result.attempts.map((a: Json) => a.outcome)).toEqual(['resolved']);
  });

  it('answers no_source with every provider and its outcome when nothing resolves', async () => {
    const { sniff, calls } = fakeSniffer({ 'beta.example': botCapture(), 'delta.example': new Error('boom') });
    const providers = [provider('Alpha'), provider('Beta'), provider('Gamma', { browser_only: true }), provider('Delta')];
    const result = await resolveTitle(MOVIE, { providers, sniff });
    expect(result).toMatchObject({ ok: false, kind: 'movie', tmdb_id: 550, source: null, error: 'no_source' });
    expect(result.attempts.map((a: Json) => [a.provider, a.outcome])).toEqual([
      ['Alpha', 'no_stream'],
      ['Beta', 'bot_check'],
      ['Gamma', 'skipped_browser_only'],
      ['Delta', 'error'],
    ]);
    expect(calls.map((c) => new URL(c.url).hostname)).not.toContain('gamma.example');
  });

  it('stops at once when Chrome cannot be started', async () => {
    const { sniff, calls } = fakeSniffer({ 'alpha.example': new ChromeError('no_chrome', 'chrome.exe was not found'), 'beta.example': streamCapture() });
    const result = await resolveTitle(MOVIE, { providers: [provider('Alpha'), provider('Beta')], sniff });
    expect(result).toMatchObject({ ok: false, error: 'no_chrome', source: null });
    expect(calls).toHaveLength(1);
  });

  it('asks only providers with an episode template for an episode', async () => {
    const { sniff, calls } = fakeSniffer({ 'beta.example': streamCapture() });
    const providers = [provider('Alpha'), provider('Beta', { tv: 'https://beta.example/tv/{id}/{season}/{episode}' })];
    const result = await resolveTitle({ kind: 'tv', tmdbId: 1399, season: 1, episode: 2 }, { providers, sniff });
    expect(result).toMatchObject({ ok: true, kind: 'tv', tmdb_id: 1399, season: 1, episode: 2 });
    expect(result.attempts.map((a: Json) => a.outcome)).toEqual(['skipped_no_template', 'resolved']);
    expect(calls.map((c) => c.url)).toEqual(['https://beta.example/tv/1399/1/2']);
  });

  it('tries only the named provider with --only, and says so when there is none', async () => {
    const { sniff, calls } = fakeSniffer({ 'beta.example': streamCapture() });
    const one = await resolveTitle(MOVIE, { providers: [provider('Alpha'), provider('Beta')], sniff, only: 'beta' });
    expect(calls.map((c) => c.url)).toEqual(['https://beta.example/movie/550']);
    expect(one.source.provider).toBe('Beta');
    const none = await resolveTitle(MOVIE, { providers: [provider('Alpha')], sniff, only: 'Zeta' });
    expect(none).toMatchObject({ ok: false, error: 'unknown_provider', attempts: [] });
  });

  it('tries no further provider once its deadline has passed, and says deadline, not no_source', async () => {
    const { sniff, calls } = fakeSniffer({ 'gamma.example': streamCapture() });
    let now = 0;
    const slowSniff = async (url: string, options: Json) => {
      now += 20_000;
      return sniff(url, options);
    };
    const providers = [provider('Alpha'), provider('Beta'), provider('Gamma')];
    const result = await resolveTitle(MOVIE, { providers, sniff: slowSniff, clock: () => now, deadlineS: 30 });
    expect(result).toMatchObject({ ok: false, error: 'deadline', source: null });
    expect(result.attempts.map((a: Json) => [a.provider, a.outcome])).toEqual([
      ['Alpha', 'no_stream'],
      ['Beta', 'no_stream'],
    ]);
    expect(calls.map((c) => new URL(c.url).hostname)).toEqual(['alpha.example', 'beta.example']);
    expect(parseArgs(['resolve', 'movie', '550', '--deadline-s', '30'])).toMatchObject({ deadlineS: 30 });
    expect(parseArgs(['resolve', 'movie', '550'])).toMatchObject({ deadlineS: null });
    expect(() => parseArgs(['resolve', 'movie', '550', '--deadline-s', '0'])).toThrow(/whole number of seconds/);
  });
});

describe('the command', () => {
  const run = async (argv: string[], io: Json = {}): Promise<{ code: number; printed: Json[] }> => {
    const printed: Json[] = [];
    const code = await main(argv, { print: (value: Json) => printed.push(value), ...io });
    return { code, printed };
  };

  it('resolve prints one JSON object naming the provider, the manifest, its headers and the subtitles (R1.1)', async () => {
    const { sniff } = fakeSniffer({ 'vidfast.pro': streamCapture() });
    const { code, printed } = await run(['resolve', 'movie', '550'], { sniff });
    expect(code).toBe(0);
    expect(printed).toHaveLength(1);
    const out = printed[0] as Json;
    expect(Object.keys(out)).toEqual(['ok', 'kind', 'tmdb_id', 'season', 'episode', 'source', 'attempts']);
    expect(Object.keys(out.source)).toEqual(['provider', 'embed_url', 'manifest_url', 'manifest_kind', 'headers', 'subtitles', 'best_height', 'en_subtitle', 'took_s']);
    expect(out).toMatchObject({
      ok: true,
      kind: 'movie',
      tmdb_id: 550,
      season: null,
      episode: null,
      source: {
        provider: 'VidFast',
        embed_url: 'https://vidfast.pro/movie/550?autoPlay=true',
        manifest_url: 'https://cdn.example/hls/master.m3u8?token=abc',
        manifest_kind: 'hls',
        headers: { referer: 'https://vidfast.vc/', origin: 'https://vidfast.vc', user_agent: UA },
        subtitles: [{ lang: 'en', format: 'hls', source: 'manifest' }],
        best_height: 2160,
        en_subtitle: true,
      },
    });
    expect(out.attempts).toHaveLength(7);
    expect(out.attempts.slice(0, 6).every((a: Json) => a.outcome === 'no_stream')).toBe(true);
    expect(typeof out.source.took_s).toBe('number');
  });

  it('resolve exits 1 with no_source and every attempt when nothing resolves', async () => {
    const { sniff } = fakeSniffer({});
    const { code, printed } = await run(['resolve', 'movie', '550'], { sniff });
    expect(code).toBe(1);
    expect(printed[0]).toMatchObject({ ok: false, error: 'no_source', source: null });
    expect(printed[0]?.attempts).toHaveLength(24);
  });

  it('providers prints the order resolve would try, with what this host measured (R1.2)', async () => {
    const HEALTH = JSON.stringify({
      VidNest: { en_subtitle: false },
      VidLink: { en_subtitle: true, best_height: 1080, consecutive_failures: 0, last_success_at: '2026-11-15T10:00:00Z' },
      VidFast: { en_subtitle: true, best_height: 2160, consecutive_failures: 0, last_success_at: '2026-11-15T10:00:00Z' },
      Videasy: { en_subtitle: true, consecutive_failures: 3 },
    });
    const readText = (file: string): string => (file === 'health.json' ? HEALTH : readFileSync(file, 'utf8'));
    const { code, printed } = await run(['providers', '--health', 'health.json'], { readText });
    expect(code).toBe(0);
    const order = names(printed[0]?.providers);
    expect(order.slice(0, 4)).toEqual(['VidFast', 'VidLink', 'Videasy', 'VidKing']);
    expect(order.at(-1)).toBe('VidNest');
    expect(printed[0]?.providers[0].health).toMatchObject({ best_height: 2160 });
  });

  it('refuses bad input with exit 2 and says why', async () => {
    for (const argv of [['resolve', 'film', '550'], ['resolve', 'tv', '1399'], ['resolve', 'movie', '550', '1', '1'], ['resolve', 'movie', '550', '--fast'], ['open', 'https://example.com/'], ['providers', '--only', 'x'], []]) {
      const { code, printed } = await run(argv);
      expect(code, argv.join(' ')).toBe(2);
      expect(printed[0]).toMatchObject({ ok: false, error: 'usage' });
    }
    const { code, printed } = await run(['providers', '--providers', 'p.json'], { readText: () => '[{"name":"A"}]' });
    expect(code).toBe(2);
    expect(printed[0]).toMatchObject({ ok: false, error: 'bad_providers' });
  });

  it('open hands a daemon page to Chrome, full screen when asked', async () => {
    const opened: unknown[] = [];
    const open = async (url: string, options: Json): Promise<Json> => {
      opened.push([url, options]);
      return { ok: true, url, fullscreen: options.fullscreen };
    };
    const { code } = await run(['open', 'http://localhost:7317/stream/abc', '--fullscreen'], { open });
    expect(code).toBe(0);
    expect(opened).toEqual([['http://localhost:7317/stream/abc', { fullscreen: true }]]);
    expect(parseArgs(['open', 'http://127.0.0.1:7317/x'])).toEqual({ command: 'open', url: 'http://127.0.0.1:7317/x', fullscreen: false });
  });

  it('a full-screen open starts the film with sound through the page, and never for a muted check (D2)', async () => {
    const asked: Array<[string, string, Json]> = [];
    let tries = 0;
    const evaluate = async (origin: string, expression: string, options: Json): Promise<unknown> => {
      asked.push([origin, expression, options]);
      if (expression !== START_EXPRESSION) return 'ok';
      tries += 1;
      return tries < 3 ? 'waiting' : 'started';
    };
    const wait = async (): Promise<void> => {};
    const played = await openInChrome('http://localhost:7317/stream/abc', { fullscreen: true }, { evaluate, wait });
    expect(played).toEqual({ ok: true, url: 'http://localhost:7317/stream/abc', fullscreen: true, started: true });
    expect(asked[0]).toEqual(['http://localhost:7317', "location.assign(\"/stream/abc\"); 'ok'", { show: true, windowState: 'fullscreen' }]);
    expect(asked.slice(1).map((a) => a[1])).toEqual([START_EXPRESSION, START_EXPRESSION, START_EXPRESSION]);

    asked.length = 0;
    const muted = await openInChrome('http://127.0.0.1:7317/stream/abc?muted=1', { fullscreen: true }, { evaluate, wait });
    expect(muted).toMatchObject({ ok: true, started: null });
    expect(asked.map((a) => a[1])).not.toContain(START_EXPRESSION);
    expect(wantsStart('http://localhost:7317/stream/abc', false)).toBe(false);
    expect(wantsStart('http://localhost:7317/stream/abc?muted=1', true)).toBe(false);

    const never = await openInChrome('http://localhost:7317/stream/abc', { fullscreen: true }, { evaluate: async (_o: string, e: string) => (e === START_EXPRESSION ? 'waiting' : 'ok'), wait });
    expect(never).toMatchObject({ ok: true, started: false });
  });
});

describe('the sniffer', () => {
  const parses = (expression: string): void => {
    expect(() => new Function(`return ${expression}`)).not.toThrow();
  };

  it('reads its one line of JSON, and turns a named failure into a ChromeError', () => {
    expect(() => parseSniffReply('starting\n{"error":"no_chrome","detail":"chrome.exe was not found"}\n')).toThrow(ChromeError);
    try {
      parseSniffReply('{"error":"chrome_not_reachable","detail":"x"}');
    } catch (err) {
      expect((err as { code: string }).code).toBe('chrome_not_reachable');
    }
    expect(() => parseSniffReply('garbage')).toThrow(/unreadable/);
    const reply = parseSniffReply('{"url":"u","hits":null,"frames":"page https://a.example/","bot_check":true,"bot_check_reason":"title Just a moment..."}');
    expect(reply).toMatchObject({ hits: [], frames: ['page https://a.example/'], hosts: [], bot_check: true, media: { elements: 0, audible: 0 } });
  });

  it('keeps a page silent: media cannot be unmuted and Web Audio stays suspended', async () => {
    parses(MUTE_SCRIPT);
    parses(MEDIA_EXPRESSION);
    class FakeMedia {
      #muted = false;
      paused = true;
      get muted(): boolean {
        return this.#muted;
      }
      set muted(value: boolean) {
        this.#muted = value;
      }
      play(): Promise<void> {
        this.paused = false;
        return Promise.resolve();
      }
    }
    class FakeAudioContext {
      state = 'running';
      suspend(): Promise<void> {
        this.state = 'suspended';
        return Promise.resolve();
      }
      resume(): Promise<void> {
        this.state = 'running';
        return Promise.resolve();
      }
    }
    const page: Json = { HTMLMediaElement: FakeMedia, AudioContext: FakeAudioContext, addEventListener: () => undefined };
    page.window = page;
    createContext(page);
    runInContext(MUTE_SCRIPT, page);
    const media = new FakeMedia();
    media.muted = false;
    await media.play();
    expect(media.paused).toBe(false);
    expect(media.muted).toBe(true);
    const Audio = page.AudioContext as new () => FakeAudioContext;
    const audio = new Audio();
    await audio.resume();
    expect(audio.state).toBe('suspended');
  });

  it('never raises a window and never disguises the client', () => {
    const script = readFileSync(new URL('../../../claude/streaming/direct/sniff.ps1', import.meta.url), 'utf8');
    for (const forbidden of ['bringToFront', 'setWindowBounds', 'AppActivate', 'SendKeys', 'setUserAgentOverride', '--user-agent', '--mute-audio']) {
      expect(script, forbidden).not.toContain(forbidden);
    }
    expect(script).toContain('background = $true');
    expect(script).toContain('Page.addScriptToEvaluateOnNewDocument');
  });
});
```
**Impact:** `npm test` gains one file. It reaches no network and starts no process. The last
test fails if `sniff.ps1` ever contains the literal `--mute-audio`, even in a comment, which is
why Step 2's comment says "mute-audio switch".

### Step 8: Fixtures for the live journey
**Files:** `tests/fixtures/direct-stream/` (new): `providers.json`, `check.html`, `stream.html`, `master.m3u8`
**Change:** two local providers served from WSL on `127.0.0.1:7398` (the Windows Chrome reaches WSL
loopback through localhost forwarding, as it reaches the daemon on 7317). The first answers like a
Cloudflare check; the second wants a click (as many embeds do), then starts a quiet tone and asks
for an HLS master. They prove R1.3 and R1.1 end to end with no outside site, and the tone proves the
mute. Phase 2 may reuse them.
**Code:** `tests/fixtures/direct-stream/providers.json`
```json
[
  { "name": "FixtureCheck", "id_kind": "tmdb", "movie": "http://localhost:7398/check.html?id={id}", "tv": null, "browser_only": false, "en_subtitle": null, "notes": "answers like a Cloudflare check" },
  { "name": "FixtureStream", "id_kind": "tmdb", "movie": "http://localhost:7398/stream.html?id={id}", "tv": null, "browser_only": false, "en_subtitle": null, "notes": "wants a click, then plays a tone and loads master.m3u8" }
]
```
`tests/fixtures/direct-stream/check.html`
```html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Just a moment...</title></head>
<body><p>Checking your browser before accessing the player.</p></body>
</html>
```
`tests/fixtures/direct-stream/stream.html`
```html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture player</title></head>
<body>
<p>Press to play.</p>
<script>
// A player that wants a press, like many embeds: the press starts a tone with sound and asks for
// the manifest. If the sniffer's mute ever fails, this is heard (quietly) for about 4 seconds.
function toneUrl() {
  const rate = 8000;
  const n = rate;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 1500), true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
const audio = document.createElement('audio');
audio.src = toneUrl();
audio.loop = true;
document.body.append(audio);
let started = false;
document.addEventListener('click', () => {
  if (started) return;
  started = true;
  audio.muted = false;
  audio.play().catch(() => {});
  fetch('master.m3u8').catch(() => {});
});
</script>
</body>
</html>
```
`tests/fixtures/direct-stream/master.m3u8`
```text
#EXTM3U
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="subs/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480,SUBTITLES="subs"
480/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,SUBTITLES="subs"
1080/index.m3u8
```
**Impact:** test data only; nothing in `npm test` reads them.

### Step 9: The feature map
**File:** `.claude/skills/verify-notesd/features/streaming.md:1-30` (whole file)
**Change:** add the resolver as a sub-feature, how to drive it offline, against the fixture and
live, and its gotchas. The daemon side gets its own `direct-streaming.md` in phase 3.
**Code:**
```markdown
# Streaming and download sites (pahe, idlix, lk21) and the direct-streaming resolver

## Sub-features
- `/pahe <title>`: links to a title's releases on pahe.ink. Parser proven by
  `npx vitest run tests/unit/scripts/paheSearch.test.ts`; live by
  `node claude/skills/pahe/search.mjs no other choice` (free, reads pahe.ink). The chat bar's side
  is prompt text (`tests/unit/chat-prompt.test.ts`).
- `/idlix`, `/lk21`: find a title, and start a single matching film full screen. Matching and
  result building proven by `npx vitest run tests/unit/scripts/streamingSites.test.ts`.
- `streaming_find`, `streaming_play` (MCP, chat bar): proven with a fake runner by
  `npx vitest run tests/unit/mcp.streamingTools.test.ts tests/unit/streaming.test.ts`; the chat
  allow list and captions by `tests/unit/chat-status.test.ts`.
- Direct streaming, the resolver (`claude/streaming/direct/cli.mjs`): for a TMDB id, opens
  provider embeds (`providers.seed.json`) one at a time in a background tab of the streaming
  Chrome and prints the first stream found: provider, manifest, the headers its request carried,
  subtitle tracks. Providers with an English subtitle are tried first, then by health, then by
  quality; a provider that answers with a bot check is recorded as `bot_check` and passed over.
  Proven with a fake sniffer by `npx vitest run tests/unit/scripts/directResolve.test.ts`. The
  daemon side (player, pass-through, tools) is `direct-streaming.md`.

## How to get to it (user POV)
`/idlix no other choice` in Claude Code, or the same words in the wall's chat bar. The resolver
has no surface of its own: `/direct-stream` and the Stream side of `/movies` run it.

## Driving it
- A throwaway daemon has no streaming runner: both tools answer `streaming_off`. That is the
  expected proof there; do not wire the real script into a throwaway instance.
- Live lookup, free: `node claude/streaming/cli.mjs lk21 ready or not 2019`. The idlix lookup
  opens the streaming Chrome on Windows, minimized.
- Live play: `node claude/streaming/cli.mjs <site> --play <film>`. It brings Chrome to the front,
  goes full screen and plays with sound. Run it only when the owner expects it, and say so in
  the report.
- Resolver order, offline: `node claude/streaming/direct/cli.mjs providers [--health <file>]`
  prints the providers in the order a resolve tries them.
- Resolver against local fixtures, no outside site: serve `tests/fixtures/direct-stream/` with
  `python3 -m http.server 7398 --bind 127.0.0.1 --directory tests/fixtures/direct-stream`, then
  `node claude/streaming/direct/cli.mjs resolve movie 550 --providers tests/fixtures/direct-stream/providers.json`:
  `FixtureCheck` ends `bot_check`, `FixtureStream` resolves (hls, 1080, English) after the
  sniffer's click. `node claude/streaming/direct/sniff.mjs 'http://localhost:7398/stream.html?id=550'`
  then shows `media.audible: 0`.
- Resolver live, free: `node claude/streaming/direct/cli.mjs resolve movie 550` (about 3 to 40 s
  per provider tried). It opens a background tab; no window comes forward and nothing is heard.
  `node claude/streaming/direct/sniff.mjs <embed url>` prints the raw capture of one embed.
- `node claude/streaming/direct/cli.mjs open <daemon url> --fullscreen` brings the streaming
  Chrome to the front: run it only when the owner expects it.

## Gotchas
- The sites change. A failing live run with passing unit tests means the site moved host
  (`IDLIX_ORIGIN`, `LK21_ORIGIN`) or changed its page: follow
  `claude/skills/create-streaming-skill` to look again.
- Never test against the owner's everyday Chrome. The scripts use their own profile folder.
- A resolve that fails with passing unit tests usually means a provider moved or added a check:
  `sniff.mjs <embed url>` shows what the page loaded. Providers are data; never add a user agent,
  header or click to get past a check.
- The sniffer mutes the pages it opens with a script installed before the page runs, not with
  Chrome's mute switch, which would also mute a film the owner is watching in the same Chrome.
- Starting an `/idlix` or `/lk21` film closes every other tab in the streaming Chrome, a
  resolver's tab included: that resolve answers `no_stream` for the provider it was on.
```
**Impact:** documentation for verifiers; `docs:check` does not read this folder.

## Principles applied

- Boundary discipline: argv, the providers file and the health file are validated once in `cli.mjs` (`parseArgs`, `readProviders`, `readHealth`) and normalized; `order.mjs` and `resolve.mjs` take them as trusted and do no re-checking.
- Make illegal states unrepresentable: `en_subtitle` is three-valued (true / false / null) so an untested provider is never ranked as one with no subtitle; a failed resolve always has `source: null` and an `error`, and `outcome` is a closed list; header values are `null` rather than `""` when the request did not carry them.
- Laziness protocol: `open` is one `evaluateInChrome` call (imported) instead of a new Chrome-driving script; `ChromeError` and `sleep` are reused; the Chrome start block and the PowerShell path are copied rather than editing the forbidden `cdp.ps1` / `chrome.mjs` (a shared module is a Handoff, not this phase).
- Test behavior, not implementation: the sniffer is faked only at its boundary (`sniff(url, options)`), tests assert the printed JSON and the order a caller sees, and the mute script is executed against fake media rather than grepped.
- Encode lessons in structure: invariants 2 and 7 (no disguised client, no window raised) are a unit test over `sniff.ps1` that fails on `bringToFront`, `setWindowBounds`, `AppActivate`, `SendKeys`, `setUserAgentOverride`, `--user-agent`, `--mute-audio`.
- Prove it works: local fixture providers (a check page and a click-gated stream page with a tone) let a verifier drive the real sniffer and real Chrome end to end, including silence, with no outside site.
- Build the lever: `sniff.mjs` is runnable on its own and the fixtures are checked in, so phase 2's campaign and later diagnosis rerun them instead of re-deriving the spike.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` (and `npm run docs:check`, which must stay clean: no route, tool or env var is added)
**Proof:**
- Harness: `.claude/skills/verify-notesd`, but no daemon is involved in this phase: the proof is the real CLI against the real streaming Chrome on the owner's Windows host (no `verify.sh up`). Journeys J2 and J3 need WSL interop and Windows Chrome; on a host without them they are `inconclusive`, not passed.
- Feature-map entries: `features/streaming.md`
- Journeys:
  - **J1** · traces R1.1, R1.2, R1.3 — `cd /home/miftah/.worktrees/mcp-notes/direct-streaming && npx vitest run tests/unit/scripts/directResolve.test.ts` → passes when vitest reports every test in the file passed, including "resolve prints one JSON object naming the provider, the manifest, its headers and the subtitles (R1.1)", "the order providers are tried in (R1.2)" (4 tests) and "skips a provider that answers with a bot check, records it, and tries the next with the same client"
  - **J2** · traces R1.2 — `cd /home/miftah/.worktrees/mcp-notes/direct-streaming && printf '%s' '{"VidNest":{"en_subtitle":false},"VidLink":{"en_subtitle":true,"best_height":1080,"consecutive_failures":0,"last_success_at":"2026-11-15T10:00:00Z"},"VidFast":{"en_subtitle":true,"best_height":2160,"consecutive_failures":0,"last_success_at":"2026-11-15T10:00:00Z"},"Videasy":{"en_subtitle":true,"consecutive_failures":3}}' > "$TMPDIR/health.json" && node claude/streaming/direct/cli.mjs providers --health "$TMPDIR/health.json" | jq -c '[[.providers[].name][0:4], [.providers[].name][-1]]'` (use any scratch directory for `$TMPDIR`) → passes when it prints exactly `[["VidFast","VidLink","Videasy","VidKing"],"VidNest"]` and the command exits 0 (English first, then health, then quality; known-none last)
  - **J3** · traces R1.3, R1.1 — local fixtures through the real sniffer and Chrome, no outside site: `cd /home/miftah/.worktrees/mcp-notes/direct-streaming && (python3 -m http.server 7398 --bind 127.0.0.1 --directory tests/fixtures/direct-stream >/dev/null 2>&1 & echo $! > "$TMPDIR/srv.pid") && timeout 10 bash -c 'until curl -sf http://127.0.0.1:7398/check.html >/dev/null; do sleep 0.2; done' && node claude/streaming/direct/cli.mjs resolve movie 550 --providers tests/fixtures/direct-stream/providers.json > "$TMPDIR/fixture.json"; echo "exit=$?"; jq -e '.ok == true and .source.provider == "FixtureStream" and (.attempts | map([.provider, .outcome])) == [["FixtureCheck","bot_check"],["FixtureStream","resolved"]] and (.attempts[0].detail | test("Just a moment")) and .source.manifest_url == "http://localhost:7398/master.m3u8" and .source.manifest_kind == "hls" and .source.best_height == 1080 and .source.en_subtitle == true and .source.subtitles[0].url == "http://localhost:7398/subs/en.m3u8" and (.source.headers.referer | startswith("http://localhost:7398/stream.html")) and (.source.headers.user_agent | test("Chrome/"))' "$TMPDIR/fixture.json"; node claude/streaming/direct/sniff.mjs 'http://localhost:7398/stream.html?id=550' | jq -e '.clicks >= 1 and .media.elements >= 1 and .media.audible == 0 and .bot_check == false'; kill "$(cat "$TMPDIR/srv.pid")"` → passes when it prints `exit=0` and both `jq -e` print `true` (the check page is recorded `bot_check` and passed over to the next provider with the same client; the result names the provider, manifest, kind, carried headers and the English track; after the sniffer's click the page's tone element is muted). If the first `jq` shows both attempts as `no_stream` with 0 requests, Windows Chrome cannot reach WSL loopback on this host: report `inconclusive`, not pass
  - **J4** · traces R1.1 — live, against the real providers, free: `cd /home/miftah/.worktrees/mcp-notes/direct-streaming && node claude/streaming/direct/cli.mjs resolve movie 550 > "$TMPDIR/r550.json"; echo "exit=$?"; jq -s 'length' "$TMPDIR/r550.json"; jq -e '.ok == true and (.source.provider | type == "string") and (.source.manifest_url | test("^https?://")) and (.source.manifest_kind | IN("hls","dash","mp4")) and (.source.headers | has("referer") and has("origin") and has("user_agent")) and (.source.subtitles | type == "array") and .attempts[-1].outcome == "resolved"' "$TMPDIR/r550.json"` → passes when it prints `exit=0`, then `1` (one JSON object on stdout), then `true`. Run once by the phase session; it opens background tabs in the streaming Chrome, shows no window and plays no sound
- Neighbor check: the existing streaming sites must be untouched and still pass: `cd /home/miftah/.worktrees/mcp-notes/direct-streaming && git diff --quiet "$(git merge-base HEAD origin/main)" -- claude/streaming/cli.mjs claude/streaming/cdp.ps1 claude/streaming/chrome.mjs claude/streaming/play.mjs claude/streaming/match.mjs claude/streaming/sites docs/plans/direct-streaming-spike src web && npx vitest run tests/unit/scripts/streamingSites.test.ts tests/unit/streaming.test.ts tests/unit/mcp.streamingTools.test.ts && node claude/streaming/cli.mjs --sites | jq -c '[.[].name]'` → passes when `git diff --quiet` exits 0, the three test files pass and the last line is `["idlix","lk21"]`
- Cost: nothing billed. J3 and J4 drive the owner's streaming Chrome out of sight (background tabs, muted); J4 reaches the real provider sites. No LLM turns.

**Exit criteria:** `npm run typecheck`, `npm test` and `npm run docs:check` pass; J1 to J3 pass; J4 prints a `resolved` source for Fight Club on the owner's machine with no window brought forward and nothing heard.

## Handoffs

- **Phase 3 (guide):** the index has phase 1 adding a subsection under a "Direct streaming" heading that phase 3 creates, but phase 3 lands after phase 1. Phase 1 therefore does not touch `docs/guide/streaming.md`; phase 3 writes the heading and, as its first subsection, "The resolver", from this draft: "`claude/streaming/direct/cli.mjs resolve <movie|tv> <tmdb id> [season episode]` opens each provider's embed in a background tab of the streaming Chrome, muted, and keeps the first one that loads a stream: the manifest, the `Referer`, `Origin` and `User-Agent` its request carried, and the subtitle tracks seen (separate `.vtt`/`.srt` requests and tracks inside the manifest). Providers are tried with an English subtitle first, then by health on this host, then by quality (`order.mjs`). A provider whose page shows a bot check is recorded as `bot_check` and the next one is tried; nothing is clicked or disguised to get past it. Providers are data, `providers.seed.json`, 24 templates read from fmovies."
- **Phase 3 (runner):** read stdout on exit 1 and 2 (as `scriptRunner` does); a full resolve can take up to about 24 x 45 s in the worst case, so the runner's time-out and any per-call `--only` use are phase 3's to choose; pass `--providers` rows with `tv` present (null allowed) and `--health` in the shape in the Interface Contract; expect the contract's additions (`skipped_no_template`, `mp4`, null headers, `source.en_subtitle`, `subtitles[].source`).
- **Phase 3 (deadline, reconciler):** `resolve ... --deadline-s <n>` stops trying providers once `n` seconds have passed and answers `error: "deadline"`; phase 3's `resolve(input, { deadlineS })` passes it, and phase 10's prober sets it to the seconds left in its pass. A `deadline` answer says nothing about the title (only `no_source` does).
- **Phase 4:** `cli.mjs open` drives `cdp.ps1`, which waits for a tab whose title is non-empty and differs from its URL and host. The player page at `/stream/<id>` must set a `<title>`, or `open` ends in `no_tab`. `open` reuses any tab already on the daemon's origin in the streaming Chrome. **Reconciler:** `open --fullscreen` then evaluates `window.notesdStream.start()` as a user gesture (`START_EXPRESSION`), so phase 4's page must expose `start()` on `window.notesdStream` (unmute and play; a no-op under `?muted=1`); it is never called for an address with `muted=1`.
- **Phase 2:** fills `tv`, `en_subtitle`, `browser_only`, `notes` in the seed. Things to measure, not assumed here: whether a player in a hidden background tab still requests its manifest (the spike's tab was in a minimized window, which is also hidden), whether `Input.dispatchMouseEvent` reaches players in such a tab, how often an advert `.mp4` is taken as the stream when a provider loads no manifest, how many advert tabs open with no opener (`tabs_left_open`), and whether `-BotGrace 5` is right. `sniff.mjs` is runnable and the fixtures in `tests/fixtures/direct-stream/` can be reused.
- **Phase 8:** adds `templates <site url>` as a new `case` in `parseArgs` (with its own `allow([...])`) and a branch in `main` before the providers file is read; the existing commands' output must not change. Phase 8's plan quotes this phase's `parseArgs` and `main` as they are written above (with `--deadline-s`).
- **Not in this plan set (drive-by, noted only):** the Chrome start block now exists in `cdp.ps1` and `sniff.ps1`, and the PowerShell path in `chrome.mjs` and `sniff.mjs`. A later change could share them; this phase may not edit `cdp.ps1` or `chrome.mjs`.

## Rollback

Delete `claude/streaming/direct/`, `tests/unit/scripts/directResolve.test.ts` and
`tests/fixtures/direct-stream/`, and restore `.claude/skills/verify-notesd/features/streaming.md`
from the base commit. Nothing else references them until phase 2 and phase 3 land.

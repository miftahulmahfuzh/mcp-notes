> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/torrent-stream-source/PLAN.md` phase 9. Source: `.workflows/plan/torrent-stream-source/phase-9.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 9: 1337x and ext.to through the streaming Chrome

**Plan set:** `TORRENT_STREAM_SOURCE_PLAN.md`
**Analysis:** `.workflows/analyze/20261116-192341-T7QK_code_analyzer.md`
**Satisfies:** R1 — "finding the relevant torrent file … agent will access these sites and search for relevant movies/series"
**Criteria:** R1.7
**Depends on:** Phase 3 (and through it phases 1 and 2)
**Difficulty:** HARD
**Package:** `claude/streaming/torrent`

---

## Goal

When the JSON indexes (phase 2) give no usable candidate, the torrent finder asks two more
indexes, 1337x and ext.to, inside the streaming Chrome in a background tab. Their rows are matched
to the title, the best few release pages are read for magnet links, and the releases become
`TorrentCandidate`s that go through phase 2's filter and ranking like every other candidate. A
site's failure (a bot check, no Chrome on this machine, a timeout) is one `Index: <site>` attempt in
the answer and never fails a play.

## What the sites really are (read live on 2026-11-16)

These observations drive the design. Each was made with an honest request first and then inside the
streaming Chrome out of sight. Nothing was clicked through and no client was disguised. Trimmed
copies of the pages are saved in
`.workflows/plan/torrent-stream-source/phase-9-samples/`, and Step 1 moves them into the tests.

| Site | What was run | What came back |
|---|---|---|
| 1337x.la | `curl -s -m 20 -A 'notesd/1.0 (personal notes daemon)' https://1337x.la/search/sintel/1/` | 200, real page. Rows in `table.table-list tbody tr`: `td.name a[href^="/torrent/"]`, `td.seeds`, `td.leeches`, `td.size` (first text node, e.g. `4.8 GB`). |
| 1337x.la | `…/search/sintel%202010/1/`, `…/search/the%20bear/1/`, `…/search/%22the%20bear%22/1/` | **The search matches any one word**: "sintel 2010" lists Hawaii Five-0 2010 and Iron Man 2 (2010) first, and "the bear" lists The Lion King. "bear" alone lists The Bear S03 first. Quotes change nothing. So the plan searches the **title words without small words** and filters rows by title on our side. |
| 1337x.la | `…/category-search/sintel/Movies/1/`, `…/category-search/the%20bear/TV/1/` | The category narrows to films or series. 20 rows a page. |
| 1337x.la release page | `…/torrent/1010994/…/` | `a[href^="magnet:?"]` carries the magnet (hash in hex, upper case). |
| 1337x.la in the streaming Chrome | `evaluateInChrome('https://1337x.la', …fetch('/category-search/sintel/Movies/1/')… DOMParser…)` | 200. 9 Sintel rows and a magnet from a release page, all in **one** expression, in about 2 s. |
| ext.to | `curl … https://ext.to/` and `…/search/?q=sintel+2010` | **403 "Just a moment..."** (Cloudflare). |
| ext.to in the streaming Chrome | home page | Loads ("EXT Torrents - All torrents to All"). |
| ext.to in the streaming Chrome | `fetch('/browse/?q=sintel')` from the page | **403, an interactive Cloudflare challenge** (`cType: 'interactive'`). A script's request is refused. |
| ext.to in the streaming Chrome | the tab itself goes to `/browse/?q=sintel` (`location.assign`) | Loads: "sintel Torrent (106 results)". Navigating the tab works and fetching does not, so ext.to is read by moving the tab, as a person would. |
| ext.to | `/browse/?imdb_id=tt1727587&sort=seeds&order=desc` | **ext.to filters by IMDb id**: 43 Sintel rows, most seeds first. Rows in `table.search-table tbody tr`: `a.torrent-title-link`, `.add-block-wrapper` cells labelled Size / Seeds / Leechs, `.search-magnet-btn[data-id]`. |
| ext.to | `/browse/?q=S02E03&imdb_id=tt14452776&sort=seeds&order=desc` | 21 rows, all "The Bear S02E03 …". An episode is found by IMDb id plus `SxxEyy`. |
| ext.to release page | `/sintel-2010-720p-bluray-x264-2-0-yts-yify-15037012/` | No magnet in the HTML. The page's own "Copy magnet link" button POSTs `/ajax/getTorrentMagnet.php` `{torrent_id, action: get_magnet, timestamp, hmac: computeHMAC(id, ts, window.pageToken), sessid: getMagnetSessid()}`, using the page's own functions and token. Made from the page, that request answered `{"success":true,"magnet":"magnet:?xt=urn:btih:a779fa75…"}`. `window.pageToken` exists only on release pages, not on search pages. |
| ext.to hidden same-origin frame | an `<iframe>` of a release page | Blocked (`SecurityError … cross-origin frame`). Not usable. |

**Background tab.** `claude/streaming/cdp.ps1` (which this phase must not touch) opens a missing
site tab with `/json/new`, and that brings the tab to the front of the streaming Chrome's window,
over a film that may be playing there. This phase adds a small `tab.ps1` that first makes sure
the site's tab exists **in the background**. It uses `Target.createTarget {background: true}`,
as `direct/sniff.ps1` does, or starts the Chrome minimized on the site when it is not running.
After that, `cdp.ps1` finds the tab and evaluates in it without raising anything.

## Interface Contract

**Deletes:** nothing
**Renames:** nothing
**Creates:**
- `claude/streaming/torrent/cli.mjs`: `main(argv, { sites })`, `readOptions(argv)`, `DEFAULT_DEADLINE_S`, `BY_HAND_RELEASES`, `MAX_PAGES_ASKED`. CLI: `cli.mjs --sites`; `cli.mjs <site> search --title … [--year] [--season --episode] [--imdb] [--origin] [--deadline-s]`; `cli.mjs <site> magnets [--origin] [--deadline-s] <page url>…`; by hand, `cli.mjs <site> <title words> [year] …`.
- `claude/streaming/torrent/match.mjs`: `searchWords`, `releaseNames`, `sameTitle`, `parseSize`, `parseCount`, `parseMagnet`, `toRow`.
- `claude/streaming/torrent/page.mjs`: `isBotCheckPage(doc)`.
- `claude/streaming/torrent/browser.mjs`: `BotCheckError`, `ensureBackgroundTab(origin, opts)`, `askInTab`, `askAfterNavigation`, `secondsLeft`.
- `claude/streaming/torrent/tab.ps1` (the Windows half of `ensureBackgroundTab`).
- `claude/streaming/torrent/sites/1337x.mjs`, `sites/ext.mjs`, `sites/index.mjs` (`TORRENT_SITE_MODULES`).
- `src/directStream/torrent/find-sites.ts`: `TORRENT_SITES`, `TorrentSiteName`, `TORRENT_SITES_DEADLINE_MS` (40 000), `TORRENT_SITES_SEARCH_MS`, `MAX_RELEASE_PAGES` (5), `TorrentSiteRunner`, `torrentSitesScriptRunner`, `pickRows`, `torrentSiteIndex`, `torrentSiteIndexes`.
- `src/config.ts`: `DEFAULT_TORRENT_SITES_CLI`, `TORRENT_SITE_ORIGIN_DEFAULTS`, `TorrentSitesConfig`, `DEFAULT_TORRENT_SITES_CONFIG`, `parseTorrentSites`; settings `NOTESD_TORRENT_1337X_ORIGIN`, `NOTESD_TORRENT_EXT_ORIGIN`, `NOTESD_TORRENT_SITES_CLI`.
- `tests/fixtures/direct-stream/fake-torrent-sites.mjs` (the throwaway daemon's stand-in; env `TORRENT_SITES_FAKE_DIR`, `TORRENT_SITES_FIXTURE`).
- `tests/fixtures/torrent-sites/*` (saved pages).

**Signature changes:** `TorrentConfig` (phase 1) gains the optional field `sites?: TorrentSitesConfig`. `parseTorrent` (phase 1) returns `sites: parseTorrentSites(env)`. `DEFAULT_TORRENT_CONFIG` gains `sites: DEFAULT_TORRENT_SITES_CONFIG`.

**Requires (from earlier phases):**
- Phase 2 (reconciled): the barrel `src/directStream/torrent/find/index.ts` exports `findCandidates`, `parseRelease`, `candidateFrom` and the types `TorrentIndex` (`{ name, kinds?, timeoutMs?, find(query, { fetch, signal }) }`), `IndexAnswer` (`{ outcome: 'ok'|'empty'|'error'|'bot_check', detail, candidates }`), `TorrentCandidate` (built only by `candidateFrom(row, index, query)`), `TorrentQuery` (a union: only a `tv` query has `season` and `episode`; both carry `imdbId`, `title`, `originalTitle`, `year`, `originalLanguage`). `findCandidates(query, { fallback })` asks `fallback` side by side only when the JSON indexes leave no usable candidate, ranks their candidates with the same filter (the title check included), lists each among `indexes`, and gives a fallback index its own `timeoutMs` even when longer than the JSON indexes' limit.
- Phase 1: `TorrentConfig`, `DEFAULT_TORRENT_CONFIG` and `parseTorrent` in `src/config.ts`. `verify.sh up --torrent` (flag variable `torrent`) seeds a fixture torrent on loopback and writes `$dir/torrent/fixture.json` `{ info_hash, name, trackers: [], port, piece_length, files }`; the daemon reaches the seeder through `NOTESD_TORRENT_PEERS`, so the fake's magnet needs no tracker.
- Phase 3 (reconciled): `buildTorrentSource(config, torrents, wiring)` takes `wiring.fallback` and hands it to `findCandidates`; the query carries `title`, `originalTitle`, `year` (and `season`/`episode` for an episode) next to `imdbId`. Each `IndexAttempt` becomes an attempt `Index: <name>` (`Index: 1337x`, `Index: ext`). Under `verify.sh up --torrent`: the fake JSON index's answer is set by `$dir/torrent/index-mode` (`ok` | `empty` | `error`); the fake TMDB's films (this phase plays Bad Apples, `movie-990003`) answer `external_ids`.

**Leaves alone (owned by others):** `src/directStream/torrent/find/**` (phase 2), the engine, `store.ts`, `service.ts` and the routes (phase 1), `source.ts`, `service.ts` branches and `sessions.ts` (phase 3), `web/**` (phases 4, 5, 7), `claude/streaming/cdp.ps1`, `claude/streaming/chrome.mjs`, `claude/streaming/cli.mjs`, `claude/streaming/sites/**` (the play sites), `src/streaming/service.ts` (only imported).

## Files

| File | Action | What changes |
|---|---|---|
| `tests/fixtures/torrent-sites/*` | create | 9 saved pages copied from `phase-9-samples/` |
| `claude/streaming/torrent/match.mjs` | create | search words, title match, size, magnet, row shape |
| `claude/streaming/torrent/page.mjs` | create | `isBotCheckPage` (runs in the tab and in tests) |
| `claude/streaming/torrent/browser.mjs` | create | background tab, evaluate, bot check from `no_tab`, retry after navigation |
| `claude/streaming/torrent/tab.ps1` | create | a background tab on the site, or Chrome started minimized on it |
| `claude/streaming/torrent/sites/1337x.mjs` | create | in-page fetch of 1–2 result pages, release pages in parallel |
| `claude/streaming/torrent/sites/ext.mjs` | create | tab navigation, IMDb search, the page's own magnet request |
| `claude/streaming/torrent/sites/index.mjs` | create | `TORRENT_SITE_MODULES` |
| `claude/streaming/torrent/cli.mjs` | create | `search`, `magnets`, by-hand find, `--sites` |
| `tests/unit/scripts/torrentSites.test.ts` | create | page readers on the saved pages, matching, magnets, the CLI with a fake site |
| `src/config.ts` | modify | `TorrentSitesConfig` and its parsing (after phase 1's `parseTorrent`); `TorrentConfig.sites` |
| `src/directStream/torrent/find-sites.ts` | create | the `TorrentIndex` per site |
| `tests/unit/directStream/torrent/findSites.test.ts` | create | fake runner; list equality; through `findCandidates` |
| `tests/unit/config.torrentSites.test.ts` | create | the three settings |
| `src/daemon.ts` | modify | the two site indexes, and `fallback` in the wiring of phase 3's `buildTorrentSource(...)` call |
| `tests/fixtures/direct-stream/fake-torrent-sites.mjs` | create | the throwaway daemon's stand-in for `cli.mjs` |
| `.claude/skills/verify-notesd/scripts/verify.sh` | modify | point the daemon at the fake; keep its calls as evidence (lines 186–195, 255–263, 465–470) |
| `.claude/skills/verify-notesd/SKILL.md` | modify | one gotcha line |
| `.claude/skills/verify-notesd/features/direct-streaming.md` | modify | one sub-feature bullet |
| `docs/guide/reference/configuration.md` | modify | three rows after phase 1's `NOTESD_TORRENT_*` rows |
| `docs/guide/streaming.md` | modify | a subsection under phase 3's "Torrents" section; one row in "Where the code is" (line 1106) |

## Implementation Steps

### Step 1: Move the saved pages into the tests
**File:** `tests/fixtures/torrent-sites/` (new)
**Change:** copy the nine files the planner saved (the pages read live on 2026-11-16, trimmed to the
parts the readers use).
**Code:**
```sh
mkdir -p tests/fixtures/torrent-sites
cp .workflows/plan/torrent-stream-source/phase-9-samples/* tests/fixtures/torrent-sites/
ls tests/fixtures/torrent-sites
# 1337x-release.html  1337x-search-oppenheimer.html  1337x-search-sintel.html  ext-challenge.html
# ext-magnet.json  ext-release-sintel.html  ext-search-bear-s02e03.html  ext-search-sintel.html
```
What each holds:
- `1337x-search-sintel.html`: `/category-search/sintel/Movies/1/`, 9 rows; the first is "Sintel 4K UHD ENG FLAC ITA ENG Sub DMRip 1744p X264 ZMachine", 1 seed, 4.8 GB.
- `1337x-search-oppenheimer.html`: `/search/oppenheimer/1/`, the first 8 rows, among them "… HQ-CAM …" (1903 seeds) and "… HD-TeleSync.DUAL …" (1713 seeds).
- `1337x-release.html`: the magnet anchor of `/torrent/1010994/…`, hash `64877B5490208C3015C0F5121287949D62622E54`.
- `ext-search-sintel.html`: `/browse/?imdb_id=tt1727587&sort=seeds&order=desc`, 6 rows; the first is "Sintel (2010) 720p BluRay x264 2.0 YTS YIFY", 33 seeds, 136.52 MB, data-id 15037012.
- `ext-search-bear-s02e03.html`: `/browse/?q=S02E03&imdb_id=tt14452776&…`, 8 rows, all S02E03.
- `ext-release-sintel.html`: the copy-magnet button (data-id 15037012), the csrf meta and the page token.
- `ext-magnet.json`: the answer of the page's magnet request.
- `ext-challenge.html`: the "Just a moment..." page Cloudflare answered.
**Impact:** none; the files are data only.

### Step 2: Matching and parsing helpers
**File:** `claude/streaming/torrent/match.mjs` (new)
**Change:** the words a search sends, the exact-title rule for release names (built on
`normalizeName` from `claude/streaming/match.mjs`, the same rule the streaming sites use), sizes,
counts, the row shape, and magnet links read into an info hash and trackers. A magnet is parsed
here only, so the daemon receives a checked hex hash.
**Code:**
```js
// What the torrent sites' rows are read with: the words a search asks for, which release names are
// the asked title, a size in bytes, a count, the row shape the CLI prints, and a magnet link's info
// hash and trackers. Shared by sites/*.mjs and cli.mjs.
import { normalizeName } from '../match.mjs';

const STOP_WORDS = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);

/**
 * The words a site's search is asked for. 1337x lists a row when any one word matches (on
 * 2026-11-16 "the bear" put The Lion King first), so small words are left out. A title made only
 * of small words is kept whole.
 */
export function searchWords(title) {
  const words = String(title ?? '').normalize('NFKC').split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  const kept = words.filter((word) => !STOP_WORDS.has(word.toLowerCase()));
  return (kept.length > 0 ? kept : words).join(' ');
}

// Where a release name's title can end: a year, an episode or season mark, or a quality word.
const TITLE_END =
  /\b(?:(?:19|20)\d{2}|S\d{1,2}(?:E\d{1,4})?|Season\s?\d{1,2}|Complete|\d{3,4}p|4K|UHD|HDR\d*|HDRip|BRRip|BDRip|BluRay|Blu-Ray|WEB(?:-?DL|-?Rip)?|HDTV|DVDRip|DVD|HDCAM|CAM|TS|TeleSync|x26[45]|H\.?26[45]|HEVC|XviD|REMUX)\b/gi;

/**
 * The titles a release name can be read as, and the years it names. Every place a title can end
 * gives one reading, so "Blade.Runner.2049.2017.1080p" reads as "Blade Runner" and as
 * "Blade Runner 2049". "Синтел / Sintel (2010)" gives each side of the slash.
 */
export function releaseNames(release) {
  const text = String(release ?? '').replace(/[._]+/g, ' ').replace(/[[\](){}]/g, ' ').replace(/\s+/g, ' ').trim();
  const titles = [];
  for (const m of text.matchAll(TITLE_END)) {
    const head = text.slice(0, m.index).replace(/[\s\-–:,|+]+$/, '').trim();
    if (head === '') continue;
    for (const alt of head.split(/\s+\/\s+/)) {
      const title = alt.trim();
      if (title !== '' && !titles.includes(title)) titles.push(title);
    }
  }
  const years = [...text.matchAll(/\b((?:19|20)\d{2})\b/g)].map((m) => Number(m[1]));
  return { titles, years };
}

/**
 * The exact-title rule for a release name: one of its readings has the asked title's normalized
 * name. For a film with a year, a release that names years must name that one. An episode's year
 * is not compared, since releases name the series' first year, the season's year or none.
 * query: { title, year, episode }.
 */
export function sameTitle(release, query) {
  const wanted = normalizeName(String(query.title ?? ''));
  if (wanted === '') return false;
  const { titles, years } = releaseNames(release);
  if (!titles.some((title) => normalizeName(title) === wanted)) return false;
  if (query.episode === null && query.year !== null && years.length > 0 && !years.includes(query.year)) return false;
  return true;
}

const UNITS = { b: 1, kb: 1024, kib: 1024, mb: 1024 ** 2, mib: 1024 ** 2, gb: 1024 ** 3, gib: 1024 ** 3, tb: 1024 ** 4, tib: 1024 ** 4 };

/** "4.8 GB", "136.52 MB", "1,234.5 MB" -> bytes; null when there is no size. */
export function parseSize(text) {
  const m = /(\d[\d,]*(?:\.\d+)?)\s*([KMGT]i?B|B)\b/i.exec(String(text ?? ''));
  if (!m) return null;
  const value = Number(m[1].replace(/,/g, ''));
  const unit = UNITS[m[2].toLowerCase()];
  return Number.isFinite(value) && unit !== undefined ? Math.round(value * unit) : null;
}

/** "1717", "1 086" -> a whole number; null when the cell holds no digit. */
export function parseCount(text) {
  const digits = String(text ?? '').replace(/[^\d]/g, '');
  return digits === '' ? null : Number(digits);
}

/**
 * One row as the CLI prints it, from what a page reader returned ({ name, href, seeds, leeches,
 * size }). Null for a row without a name, or one whose link leaves the site.
 */
export function toRow(raw, origin) {
  if (!raw || typeof raw.name !== 'string' || raw.name.trim() === '' || typeof raw.href !== 'string') return null;
  let url;
  try {
    url = new URL(raw.href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  return {
    name: raw.name.replace(/\s+/g, ' ').trim(),
    page_url: url.href,
    seeds: parseCount(raw.seeds) ?? 0,
    leeches: parseCount(raw.leeches),
    size_bytes: parseSize(raw.size),
  };
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32ToHex(text) {
  let bits = '';
  for (const ch of text.toUpperCase()) {
    const value = BASE32.indexOf(ch);
    if (value < 0) return null;
    bits += value.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

/**
 * A magnet link -> { info_hash (40 lower-case hex), trackers, name }; null when it names no BitTorrent
 * info hash. A 32-character base32 hash is turned into hex.
 */
export function parseMagnet(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('magnet:?')) return null;
  const params = new URLSearchParams(uri.slice('magnet:?'.length));
  let hash = null;
  for (const xt of params.getAll('xt')) {
    const m = /^urn:btih:([0-9a-f]{40}|[a-z2-7]{32})$/i.exec(xt.trim());
    if (!m) continue;
    hash = m[1].length === 40 ? m[1].toLowerCase() : base32ToHex(m[1]);
    break;
  }
  if (hash === null || !/^[0-9a-f]{40}$/.test(hash)) return null;
  const trackers = [...new Set(params.getAll('tr').map((t) => t.trim()).filter((t) => /^(udp|https?|wss?):\/\//i.test(t)))];
  return { info_hash: hash, trackers, name: params.get('dn') };
}
```
**Impact:** new file; nothing imports it yet.

### Step 3: The bot-check reader
**File:** `claude/streaming/torrent/page.mjs` (new)
**Change:** one function with no outside references, so it can be written into an in-page
expression with `toString()` and also run in jsdom tests.
**Code:**
```js
// Page readers shared by the torrent sites. Each function here uses nothing from outside itself: it
// is written into the expressions evaluated in the streaming Chrome (fn.toString()) and run in tests
// on the saved pages.

/** True for a bot-check page (Cloudflare's "Just a moment..." and its kin), which is never clicked through. */
export function isBotCheckPage(doc) {
  const title = String(doc.title || '').trim();
  if (/^just a moment/i.test(title) || /^attention required/i.test(title)) return true;
  return doc.querySelector('#challenge-form, #challenge-error-text, #cf-challenge-running, script[src*="challenges.cloudflare.com"]') !== null;
}
```
**Impact:** new file.

### Step 4: The background tab and the evaluate wrapper
**Files:** `claude/streaming/torrent/tab.ps1` (new), `claude/streaming/torrent/browser.mjs` (new)
**Change:** `tab.ps1` makes sure a tab on the site exists without bringing anything to the front.
`browser.mjs` runs it from WSL. It wraps `evaluateInChrome` so that `no_tab` (the site's only page
never got past "Just a moment", since `cdp.ps1` skips such tabs) becomes a bot check, and it
retries an evaluate that a navigation cut short. When the machine has no PowerShell or no
`wslpath`, the error is `no_chrome`. The three PowerShell lines are copied the way
`direct/sniff.mjs` copies them, because `chrome.mjs` does not export them and this phase leaves
`chrome.mjs` as it is.
**Code (`tab.ps1`):**
```powershell
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
```
**Code (`browser.mjs`):**
```js
// The tab a torrent site is asked in: a background tab of the streaming Chrome, made out of sight by
// tab.ps1 (cdp.ps1 opens a missing tab in front), then driven through chrome.mjs. Never the owner's
// everyday Chrome, never a Chrome notesd did not start, never a disguised client.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ChromeError, evaluateInChrome, sleep } from '../chrome.mjs';

const run = promisify(execFile);
// The daemon runs under systemd without the Windows folders on its PATH, so name the usual place.
const POWERSHELL_PATH = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const POWERSHELL = existsSync(POWERSHELL_PATH) ? POWERSHELL_PATH : 'powershell.exe';
const TAB_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tab.ps1');

/** The site answered a bot check (or only a "Just a moment" page): reported, never clicked through. */
export class BotCheckError extends Error {
  constructor(detail) {
    super(`bot_check: ${detail}`);
    this.code = 'bot_check';
    this.detail = detail;
  }
}

/** Seconds left before `deadline` (ms since the epoch): at least 5, at most `cap`. */
export function secondsLeft(deadline, cap = 20) {
  return Math.max(5, Math.min(cap, Math.floor((deadline - Date.now()) / 1000)));
}

/**
 * Makes sure the streaming Chrome has a tab on `origin`, created in the background, or starts that
 * Chrome minimized on it. Throws ChromeError: no_chrome (no Windows PowerShell or no chrome.exe on
 * this machine), chrome_not_reachable, cdp_failed.
 */
export async function ensureBackgroundTab(origin, { timeoutS = 20 } = {}) {
  let stdout;
  try {
    const { stdout: winScript } = await run('wslpath', ['-w', TAB_SCRIPT]);
    ({ stdout } = await run(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', winScript.trim(), '-Origin', origin, '-TimeoutS', String(timeoutS)], {
      // powershell.exe cannot start in a Linux-only folder.
      cwd: existsSync('/mnt/c') ? '/mnt/c' : undefined,
      timeout: (timeoutS + 15) * 1000,
    }));
  } catch (err) {
    // tab.ps1 exits 3 with its reason on stdout; anything else means no Windows Chrome to drive.
    stdout = err?.stdout;
    if (!stdout) throw new ChromeError('no_chrome', `cannot run PowerShell: ${String(err?.message ?? err).split('\n')[0]}`);
  }
  const line = String(stdout).trim().split(/\r?\n/).pop() ?? '';
  let reply;
  try {
    reply = JSON.parse(line);
  } catch {
    throw new Error(`unreadable reply from tab.ps1: ${line.slice(0, 200)}`);
  }
  if (reply.cdp_error) throw new ChromeError(reply.cdp_error, reply.detail ?? '');
  return { created: reply.created === true };
}

/**
 * Evaluates one expression in the site's tab. cdp.ps1 answers no_tab when the only page on the site
 * is still "Just a moment...", which is a bot check.
 */
export async function askInTab(origin, expression, { timeoutS = 20 } = {}) {
  try {
    return await evaluateInChrome(origin, expression, { timeoutS });
  } catch (err) {
    if (err instanceof ChromeError && err.code === 'no_tab') {
      throw new BotCheckError(`no page on ${new URL(origin).host} got past its check within ${timeoutS} s`);
    }
    throw err;
  }
}

/**
 * askInTab, tried again (up to `tries` times) when the page was replaced under the expression by a
 * navigation the previous expression started. A named Chrome failure or a bot check is final.
 */
export async function askAfterNavigation(origin, expression, { timeoutS = 20, tries = 3, pauseMs = 1500 } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await askInTab(origin, expression, { timeoutS });
    } catch (err) {
      if (err instanceof ChromeError || err instanceof BotCheckError) throw err;
      last = err;
      await sleep(pauseMs);
    }
  }
  throw last;
}
```
**Impact:** new files. `chrome.mjs` and `cdp.ps1` are unchanged.

### Step 5: 1337x
**File:** `claude/streaming/torrent/sites/1337x.mjs` (new)
**Change:** one expression fetches up to two result pages from inside the 1337x tab (the second
only when the first is full) and reads their rows. A second expression fetches the chosen release
pages in parallel and reads their magnet links.
**Code:**
```js
// 1337x (1337x.la). Its pages answered a plain request too on 2026-11-16, but the torrent sites are
// asked only inside the streaming Chrome, in a background tab. Its search lists a row when any one
// word matches, so the title's small words are left out (match.mjs searchWords) and the rows are
// matched to the title afterwards (cli.mjs). Selectors as the site had them on 2026-11-16.
import { askInTab, BotCheckError, ensureBackgroundTab, secondsLeft } from '../browser.mjs';
import { pathOnSite } from '../../match.mjs';
import { searchWords, toRow } from '../match.mjs';
import { isBotCheckPage } from '../page.mjs';

export const DEFAULT_ORIGIN = 'https://1337x.la';
/** A result page lists 20 rows; the next page is read only when one is full. */
export const PAGE_ROWS = 20;
export const MAX_PAGES = 2;

const RELEASE_PATH = /^\/torrent\/\d+\/[^/]+\/$/;

/** The address of one result page: films under Movies, an episode under TV. */
export function searchPath(words, episode, page) {
  return `/category-search/${encodeURIComponent(words)}/${episode ? 'TV' : 'Movies'}/${page}/`;
}

/** The rows of one result page, in the site's order. Runs in the tab and in tests. */
export function readRows(doc) {
  const rows = [];
  for (const tr of doc.querySelectorAll('table.table-list tbody tr')) {
    const link = tr.querySelector('td.name a[href^="/torrent/"]');
    if (!link) continue;
    const cell = (selector) => {
      const td = tr.querySelector(selector);
      if (!td) return '';
      return (td.childNodes[0] ? td.childNodes[0].textContent : td.textContent).trim();
    };
    rows.push({
      name: link.textContent.replace(/\s+/g, ' ').trim(),
      href: link.getAttribute('href'),
      seeds: cell('td.seeds'),
      leeches: cell('td.leeches'),
      size: cell('td.size'),
    });
  }
  return rows;
}

/** The magnet link on a release page, or null. Runs in the tab and in tests. */
export function readMagnet(doc) {
  const link = doc.querySelector('a[href^="magnet:?"]');
  return link ? link.getAttribute('href') : null;
}

/** The expression evaluated in the tab: the result pages, as the site's own search links them. */
export function searchExpression(paths) {
  return `(async () => {
  const isBotCheckPage = ${isBotCheckPage.toString()};
  const readRows = ${readRows.toString()};
  const rows = [];
  for (const path of ${JSON.stringify(paths)}) {
    const res = await fetch(path, { headers: { accept: 'text/html' } });
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    if (isBotCheckPage(doc)) return { status: res.status, bot_check: true, title: doc.title };
    if (res.status !== 200) return { status: res.status, title: doc.title, rows };
    const found = readRows(doc);
    rows.push(...found);
    if (found.length < ${PAGE_ROWS}) break;
  }
  return { status: 200, rows };
})()`;
}

/** The expression evaluated in the tab: each release page's magnet link, read side by side. */
export function magnetsExpression(paths) {
  return `(async () => {
  const isBotCheckPage = ${isBotCheckPage.toString()};
  const readMagnet = ${readMagnet.toString()};
  return Promise.all(${JSON.stringify(paths)}.map(async (path) => {
    try {
      const res = await fetch(path, { headers: { accept: 'text/html' } });
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      if (isBotCheckPage(doc)) return { path, bot_check: true };
      return { path, status: res.status, magnet: res.status === 200 ? readMagnet(doc) : null };
    } catch (err) {
      return { path, error: String((err && err.message) || err) };
    }
  }));
})()`;
}

export default {
  name: '1337x',
  label: '1337x',
  defaultOrigin: DEFAULT_ORIGIN,
  /** 1337x has no IMDb search: it is asked by the title's words. */
  needsTitle: true,

  /** The path of a release page on the site, or null for any other address. */
  releasePath: (url, origin) => pathOnSite(url, origin, RELEASE_PATH),

  /** { url, rows: [{ name, page_url, seeds, leeches, size_bytes }] }; throws BotCheckError or ChromeError. */
  async search(origin, query, { deadline }) {
    await ensureBackgroundTab(origin, { timeoutS: secondsLeft(deadline) });
    const words = searchWords(query.title);
    const paths = Array.from({ length: MAX_PAGES }, (_, i) => searchPath(words, query.episode !== null, i + 1));
    const value = await askInTab(origin, searchExpression(paths), { timeoutS: secondsLeft(deadline) });
    if (value?.bot_check) throw new BotCheckError(`${paths[0]} answered "${value.title ?? ''}"`);
    if (!value || !Array.isArray(value.rows) || (value.status !== 200 && value.rows.length === 0)) {
      throw new Error(`the site answered HTTP ${value?.status ?? '?'} (page title: ${value?.title ?? '?'})`);
    }
    return { url: new URL(paths[0], origin).href, rows: value.rows.map((row) => toRow(row, origin)).filter(Boolean) };
  },

  /** [{ path, magnet | null, error | null }] in the order asked; throws BotCheckError when every page is one. */
  async magnets(origin, paths, { deadline }) {
    await ensureBackgroundTab(origin, { timeoutS: secondsLeft(deadline) });
    const value = await askInTab(origin, magnetsExpression(paths), { timeoutS: secondsLeft(deadline, 30) });
    if (!Array.isArray(value)) throw new Error('the release pages answered nothing');
    if (value.length > 0 && value.every((entry) => entry.bot_check)) throw new BotCheckError('every release page answered a bot check');
    return value.map((entry) => ({
      path: entry.path,
      magnet: typeof entry.magnet === 'string' ? entry.magnet : null,
      error: typeof entry.magnet === 'string' ? null : (entry.error ?? (entry.bot_check ? 'bot_check' : `HTTP ${entry.status ?? '?'}: no magnet link`)),
    }));
  },
};
```
**Impact:** new file.

### Step 6: ext.to
**File:** `claude/streaming/torrent/sites/ext.mjs` (new)
**Change:** the tab goes to the search page, because Cloudflare refuses the page's own `fetch`.
The search is by IMDb id, with `SxxEyy` for an episode, most seeds first. Then the tab goes from
one release page to the next. On each page, one expression waits for the page, asks the page's own
"Copy magnet link" request with the page's own `computeHMAC`, `getMagnetSessid` and
`window.pageToken`, and sends the tab to the next page. That is one PowerShell round trip per
release page.
**Code:**
```js
// ext.to. Cloudflare answers a plain request with "Just a moment..." and refuses a fetch made from
// the page (an interactive check, 2026-11-16), but the streaming Chrome's tab loads the site's pages
// when it goes to them, as a person does. So the tab is moved: to the search, then to each release
// page. The site filters by IMDb id (/browse/?imdb_id=tt...), most seeds first. A release page gives
// its magnet through its own "Copy magnet link" request, which is asked here with the page's own
// functions and token, as the button does. Nothing is clicked and the client is the owner's own
// streaming Chrome. Selectors and requests as the site had them on 2026-11-16.
import { askAfterNavigation, askInTab, BotCheckError, ensureBackgroundTab, secondsLeft } from '../browser.mjs';
import { pathOnSite } from '../../match.mjs';
import { toRow } from '../match.mjs';
import { isBotCheckPage } from '../page.mjs';

export const DEFAULT_ORIGIN = 'https://ext.to';

const RELEASE_PATH = /^\/[a-z0-9-]+-\d+\/$/;
const pad = (n) => String(n).padStart(2, '0');

/** The search page: by IMDb id when known (with S02E03 for an episode), else by the title's words. */
export function searchPath(query) {
  const episode = query.episode !== null ? `S${pad(query.season)}E${pad(query.episode)}` : null;
  const params = new URLSearchParams();
  if (query.imdb !== null) {
    if (episode !== null) params.set('q', episode);
    params.set('imdb_id', query.imdb);
  } else {
    params.set('q', [query.title, episode ?? query.year].filter((part) => part !== null && part !== undefined).join(' '));
  }
  params.set('sort', 'seeds');
  params.set('order', 'desc');
  return `/browse/?${params.toString()}`;
}

/** The expression evaluated in the tab: go to `path` once this evaluation has answered. */
export function navigateExpression(path) {
  return `(() => { setTimeout(() => location.assign(${JSON.stringify(path)}), 50); return location.href; })()`;
}

/** The rows of a search page, in the site's order. Runs in the tab and in tests. */
export function readRows(doc) {
  const rows = [];
  for (const tr of doc.querySelectorAll('table.search-table tbody tr')) {
    const link = tr.querySelector('a.torrent-title-link');
    if (!link) continue;
    const cells = {};
    for (const wrap of tr.querySelectorAll('.add-block-wrapper')) {
      const label = wrap.querySelector('.add-block');
      const value = wrap.lastElementChild;
      if (label && value && value !== label) cells[label.textContent.trim().toLowerCase()] = value.textContent.trim();
    }
    const button = tr.querySelector('.search-magnet-btn[data-id]');
    rows.push({
      name: link.textContent.replace(/\s+/g, ' ').trim(),
      href: link.getAttribute('href'),
      seeds: cells.seeds || '',
      leeches: cells.leechs || '',
      size: cells.size || '',
      id: button ? button.getAttribute('data-id') : null,
    });
  }
  return rows;
}

/** The expression evaluated in the tab: wait until it shows `path`, then read the rows. */
export function rowsExpression(path) {
  return `(async () => {
  const isBotCheckPage = ${isBotCheckPage.toString()};
  const readRows = ${readRows.toString()};
  const want = ${JSON.stringify(path)};
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (isBotCheckPage(document)) return { bot_check: true, title: document.title };
    if (location.pathname + location.search === want && document.readyState === 'complete') {
      return { url: location.href, title: document.title, rows: readRows(document) };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return { url: location.href, title: document.title, waited: true };
})()`;
}

/**
 * The release page's own magnet request ("Copy magnet link"): the page's computeHMAC, its session
 * token and its page token, posted to /ajax/getTorrentMagnet.php. Runs in the tab (its arguments are
 * the page's own) and in tests (with fakes). { magnet } or { error }.
 */
export async function askExtMagnet({ fetch, computeHMAC, sessid, pageToken, torrentId, now }) {
  if (typeof computeHMAC !== 'function' || !pageToken || !sessid) return { error: 'the page has no magnet button script' };
  if (!Number.isInteger(torrentId) || torrentId <= 0) return { error: 'the page names no torrent id' };
  const timestamp = Math.floor(now() / 1000);
  const body = new URLSearchParams({
    torrent_id: String(torrentId),
    action: 'get_magnet',
    timestamp: String(timestamp),
    hmac: computeHMAC(torrentId, timestamp, pageToken),
    sessid,
  });
  const res = await fetch('/ajax/getTorrentMagnet.php', { method: 'POST', body, headers: { 'x-requested-with': 'XMLHttpRequest' } });
  let answer = null;
  try {
    answer = await res.json();
  } catch {
    answer = null;
  }
  if (answer && answer.success && typeof answer.magnet === 'string') return { magnet: answer.magnet };
  return { error: (answer && answer.error) || `HTTP ${res.status}` };
}

/**
 * The expression evaluated in the tab: wait until it shows the release page `path`, ask its magnet,
 * then (unless a bot check stood in the way) send the tab on to `nextPath`.
 */
export function magnetExpression(path, nextPath) {
  return `(async () => {
  const isBotCheckPage = ${isBotCheckPage.toString()};
  const askExtMagnet = ${askExtMagnet.toString()};
  const want = ${JSON.stringify(path)};
  const next = ${JSON.stringify(nextPath)};
  const t0 = Date.now();
  let out = null;
  while (Date.now() - t0 < 15000) {
    if (isBotCheckPage(document)) { out = { bot_check: true, title: document.title }; break; }
    if (location.pathname === want && document.readyState === 'complete') break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (out === null) {
    if (location.pathname !== want) {
      out = { error: 'the release page did not load' };
    } else {
      const button = document.querySelector('.copy-magnet-btn[data-id], .download-btn-magnet[data-id]');
      const id = Number(button ? button.getAttribute('data-id') : (want.match(/-(\\d+)\\/$/) || [])[1]);
      out = await askExtMagnet({
        fetch: (url, init) => fetch(url, init),
        computeHMAC: typeof computeHMAC === 'function' ? computeHMAC : null,
        sessid: typeof getMagnetSessid === 'function' ? getMagnetSessid() : '',
        pageToken: window.pageToken,
        torrentId: id,
        now: () => Date.now(),
      });
    }
  }
  if (next !== null && !out.bot_check) setTimeout(() => location.assign(next), 50);
  return { path: want, ...out };
})()`;
}

export default {
  name: 'ext',
  label: 'ext.to',
  defaultOrigin: DEFAULT_ORIGIN,
  /** ext.to is searched by IMDb id; words only when no id is known. */
  needsTitle: false,

  /** The path of a release page on the site, or null for any other address. */
  releasePath: (url, origin) => pathOnSite(url, origin, RELEASE_PATH),

  /** { url, rows, by_imdb }; throws BotCheckError or ChromeError. */
  async search(origin, query, { deadline }) {
    await ensureBackgroundTab(origin, { timeoutS: secondsLeft(deadline) });
    const path = searchPath(query);
    await askInTab(origin, navigateExpression(path), { timeoutS: secondsLeft(deadline) });
    const value = await askAfterNavigation(origin, rowsExpression(path), { timeoutS: secondsLeft(deadline) });
    if (value?.bot_check) throw new BotCheckError(`${path} answered "${value.title ?? ''}"`);
    if (!value || !Array.isArray(value.rows)) throw new Error(`the search page did not load (the tab shows ${value?.url ?? '?'}, title: ${value?.title ?? '?'})`);
    return { url: new URL(path, origin).href, rows: value.rows.map((row) => toRow(row, origin)).filter(Boolean), by_imdb: query.imdb !== null };
  },

  /** [{ path, magnet | null, error | null }] in the order asked; one release page after the other. */
  async magnets(origin, paths, { deadline }) {
    await ensureBackgroundTab(origin, { timeoutS: secondsLeft(deadline) });
    await askInTab(origin, navigateExpression(paths[0]), { timeoutS: secondsLeft(deadline) });
    const out = [];
    for (let i = 0; i < paths.length; i++) {
      if (deadline - Date.now() < 6000) {
        out.push(...paths.slice(i).map((path) => ({ path, magnet: null, error: 'deadline' })));
        break;
      }
      const value = await askAfterNavigation(origin, magnetExpression(paths[i], paths[i + 1] ?? null), { timeoutS: secondsLeft(deadline) });
      if (value?.bot_check) {
        if (!out.some((entry) => entry.magnet !== null)) throw new BotCheckError(`${paths[i]} answered "${value.title ?? ''}"`);
        out.push(...paths.slice(i).map((path) => ({ path, magnet: null, error: 'bot_check' })));
        break;
      }
      out.push({ path: paths[i], magnet: typeof value?.magnet === 'string' ? value.magnet : null, error: typeof value?.magnet === 'string' ? null : (value?.error ?? 'no answer') });
    }
    return out;
  },
};
```
**Impact:** new file.

### Step 7: The site list
**File:** `claude/streaming/torrent/sites/index.mjs` (new)
**Code:**
```js
// The torrent sites the finder falls back on, by name. src/directStream/torrent/find-sites.ts keeps
// the same names (TORRENT_SITES) and src/config.ts their default addresses; a test compares them.
// These are not streaming sites: claude/streaming/sites/index.mjs (play sites) stays apart.
import x1337 from './1337x.mjs';
import ext from './ext.mjs';

export const TORRENT_SITE_MODULES = { '1337x': x1337, ext };
```
**Impact:** new file. `claude/streaming/sites/index.mjs` is unchanged, so the play-site contract test
`tests/unit/scripts/streamingSites.test.ts` does not see these modules.

### Step 8: The command
**File:** `claude/streaming/torrent/cli.mjs` (new)
**Change:** `search` matches rows to the title. A row counts only when its page is a release page
on the site, and only when its name is the title, except when the site's search was by IMDb id.
`magnets` refuses any address that is not a release page on the site's origin. By hand, the
command does both for the five best-seeded matches. The command prints one JSON object every time.
**Code:**
```js
#!/usr/bin/env node
// One command for the torrent sites (1337x, ext.to), asked inside the streaming Chrome in a background
// tab. Prints one JSON object. The daemon's torrent finder (src/directStream/torrent/find-sites.ts)
// runs `search`, then `magnets` for the few rows it keeps; by hand, `cli.mjs <site> <title> [year]`
// does both for the five best-seeded matches.
// Usage: cli.mjs --sites
//        cli.mjs <site> search --title <words> [--year <n>] [--season <n> --episode <n>] [--imdb <tt...>] [--origin <url>] [--deadline-s <n>]
//        cli.mjs <site> magnets [--origin <url>] [--deadline-s <n>] <release page url>...
//        cli.mjs <site> <title words> [year] [--season <n> --episode <n>] [--imdb <tt...>] [--origin <url>]
// A failure is { ok: false, site, origin, error, detail }: error is bot_check, no_chrome,
// chrome_not_reachable, cdp_failed, no_title, usage or site_error.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ChromeError } from '../chrome.mjs';
import { parseQuery } from '../match.mjs';
import { BotCheckError } from './browser.mjs';
import { parseMagnet, sameTitle } from './match.mjs';
import { TORRENT_SITE_MODULES } from './sites/index.mjs';

/** Both steps of one site together, when the caller gives no --deadline-s. */
export const DEFAULT_DEADLINE_S = 40;
/** Release pages a by-hand look reads. */
export const BY_HAND_RELEASES = 5;
/** Release pages one `magnets` call accepts. */
export const MAX_PAGES_ASKED = 10;

const print = (value) => console.log(JSON.stringify(value, null, 2));
const VALUE_FLAGS = new Set(['--title', '--year', '--season', '--episode', '--imdb', '--origin', '--deadline-s']);

/** The words and flags of one call; `bad` names the first thing wrong with them. */
export function readOptions(argv) {
  const words = [];
  const flags = {};
  let bad = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!VALUE_FLAGS.has(arg)) {
      if (arg.startsWith('--')) bad ??= `unknown flag ${arg}`;
      else words.push(arg);
      continue;
    }
    const value = argv[++i];
    if (value === undefined) bad ??= `${arg} needs a value`;
    else flags[arg.slice(2)] = value;
  }
  const whole = (name) => {
    const value = flags[name];
    if (value === undefined) return null;
    if (!/^\d{1,5}$/.test(value)) {
      bad ??= `--${name} takes a whole number`;
      return null;
    }
    return Number(value);
  };
  const year = whole('year');
  const season = whole('season');
  const episode = whole('episode');
  const deadlineS = whole('deadline-s');
  if ((season === null) !== (episode === null)) bad ??= '--season and --episode go together';
  const imdb = flags.imdb ?? null;
  if (imdb !== null && !/^tt\d{5,10}$/.test(imdb)) bad ??= '--imdb takes an IMDb id such as tt1727587';
  let origin = null;
  if (flags.origin !== undefined) {
    try {
      const url = new URL(flags.origin);
      if (url.protocol === 'https:' || url.protocol === 'http:') origin = url.origin;
      else bad ??= '--origin takes a site address such as https://1337x.la';
    } catch {
      bad ??= '--origin takes a site address such as https://1337x.la';
    }
  }
  return { words, title: flags.title ?? null, year, season, episode, imdb, origin, deadlineS, bad };
}

/** A search's rows that count: release pages on the site, named as the title unless the site searched by IMDb id. */
async function searchSite(site, origin, query, deadline) {
  const found = await site.search(origin, query, { deadline });
  const onSite = found.rows.filter((row) => site.releasePath(row.page_url, origin) !== null);
  const rows = found.by_imdb === true ? onSite : onSite.filter((row) => sameTitle(row.name, query));
  return { url: found.url, rows, others: found.rows.length - rows.length };
}

/** Each release page's magnet link, read into its info hash and trackers. */
async function readMagnets(site, origin, paths, deadline) {
  const got = await site.magnets(origin, paths, { deadline });
  return got.map((entry) => {
    const parsed = typeof entry.magnet === 'string' ? parseMagnet(entry.magnet) : null;
    return {
      page_url: new URL(entry.path, origin).href,
      info_hash: parsed === null ? null : parsed.info_hash,
      trackers: parsed === null ? [] : parsed.trackers,
      magnet: parsed === null ? null : entry.magnet,
      error: parsed === null ? (entry.error ?? 'unreadable magnet link') : null,
    };
  });
}

export async function main(argv, { sites = TORRENT_SITE_MODULES } = {}) {
  const [siteName, ...rest] = argv;
  if (siteName === '--sites') {
    print(Object.values(sites).map((site) => ({ name: site.name, label: site.label, origin: site.defaultOrigin })));
    return 0;
  }
  const site = sites[siteName ?? ''];
  if (!site) {
    print({ ok: false, error: 'usage', detail: `unknown site "${siteName ?? ''}"; known: ${Object.keys(sites).join(', ')}` });
    return 2;
  }
  const command = rest[0] === 'search' || rest[0] === 'magnets' ? rest[0] : 'find';
  const options = readOptions(command === 'find' ? rest : rest.slice(1));
  const origin = options.origin ?? site.defaultOrigin;
  const fail = (error, detail, code) => {
    print({ ok: false, site: site.name, origin, error, detail });
    return code;
  };
  if (options.bad !== null) return fail('usage', options.bad, 2);
  const deadline = Date.now() + (options.deadlineS ?? DEFAULT_DEADLINE_S) * 1000;
  try {
    if (command === 'magnets') {
      if (options.words.length === 0 || options.words.length > MAX_PAGES_ASKED) return fail('usage', `magnets takes 1 to ${MAX_PAGES_ASKED} release page addresses`, 2);
      const paths = [];
      for (const url of options.words) {
        const releasePath = site.releasePath(url, origin);
        if (releasePath === null) return fail('usage', `not a release page on ${origin}: ${url}`, 2);
        paths.push(releasePath);
      }
      print({ ok: true, site: site.name, origin, magnets: await readMagnets(site, origin, paths, deadline) });
      return 0;
    }
    const parsed = command === 'find' ? parseQuery(options.words) : { name: '', year: null };
    const query = {
      title: options.title ?? (parsed.name === '' ? null : parsed.name),
      year: options.year ?? parsed.year,
      season: options.season,
      episode: options.episode,
      imdb: options.imdb,
    };
    if (query.title === null && (site.needsTitle || query.imdb === null)) return fail('no_title', `${site.label} is searched by the title's words: give --title`, 2);
    const found = await searchSite(site, origin, query, deadline);
    if (command === 'search') {
      print({ ok: true, site: site.name, origin, query, url: found.url, rows: found.rows, others: found.others });
      return 0;
    }
    const best = [...found.rows].sort((a, b) => b.seeds - a.seeds).slice(0, BY_HAND_RELEASES);
    const magnets = best.length === 0 ? [] : await readMagnets(site, origin, best.map((row) => site.releasePath(row.page_url, origin)), deadline);
    const byPage = new Map(magnets.map((entry) => [entry.page_url, entry]));
    const releases = best.map((row) => {
      const entry = byPage.get(row.page_url);
      return { ...row, info_hash: entry?.info_hash ?? null, trackers: entry?.trackers ?? [], magnet: entry?.magnet ?? null, error: entry ? entry.error : 'not read' };
    });
    print({ ok: true, site: site.name, origin, query, url: found.url, releases, others: found.others });
    return 0;
  } catch (err) {
    if (err instanceof BotCheckError) return fail('bot_check', err.detail, 1);
    if (err instanceof ChromeError) return fail(err.code, err.message, 1);
    return fail('site_error', String(err?.message ?? err), 1);
  }
}

// Run by path or through a symlink, so compare real paths.
function isMain() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
}

if (isMain()) process.exitCode = await main(process.argv.slice(2));
```
**Impact:** new file. Running it by hand drives the owner's streaming Chrome in a background tab.

### Step 9: Tests for the scripts, on the saved pages
**File:** `tests/unit/scripts/torrentSites.test.ts` (new; the jsdom pragma must be the first line)
**Code:**
```ts
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { ChromeError } from '../../../claude/streaming/chrome.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { BotCheckError } from '../../../claude/streaming/torrent/browser.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { main, readOptions } from '../../../claude/streaming/torrent/cli.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { parseMagnet, parseSize, releaseNames, sameTitle, searchWords, toRow } from '../../../claude/streaming/torrent/match.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { isBotCheckPage } from '../../../claude/streaming/torrent/page.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import x1337, { magnetsExpression, readMagnet, readRows as read1337xRows, searchExpression, searchPath as path1337x } from '../../../claude/streaming/torrent/sites/1337x.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import ext, { askExtMagnet, magnetExpression, navigateExpression, readRows as readExtRows, rowsExpression, searchPath as extPath } from '../../../claude/streaming/torrent/sites/ext.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { TORRENT_SITE_MODULES } from '../../../claude/streaming/torrent/sites/index.mjs';

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../../fixtures/torrent-sites/${name}`, import.meta.url)), 'utf8');
const page = (name: string): Document => new DOMParser().parseFromString(fixture(name), 'text/html');
const parses = (expression: string): void => {
  expect(() => new Function(`return ${expression}`)).not.toThrow();
};
const X = 'https://1337x.la';
const E = 'https://ext.to';

describe('torrent site modules', () => {
  it.each(Object.entries(TORRENT_SITE_MODULES) as Array<[string, any]>)('%s has the whole contract', (name, site) => {
    expect(site.name).toBe(name);
    expect(site.defaultOrigin).toMatch(/^https:\/\/[a-z0-9.-]+$/);
    expect(typeof site.label).toBe('string');
    expect(typeof site.needsTitle).toBe('boolean');
    for (const fn of ['search', 'magnets', 'releasePath']) expect(typeof site[fn]).toBe('function');
    expect(site.releasePath('https://elsewhere.example/torrent/1/x/', site.defaultOrigin)).toBeNull();
    expect(site.releasePath('javascript:alert(1)', site.defaultOrigin)).toBeNull();
    expect(site.releasePath('not a url', site.defaultOrigin)).toBeNull();
  });
});

describe('1337x pages (saved 2026-11-16)', () => {
  it('reads the rows of a result page', () => {
    const rows = read1337xRows(page('1337x-search-sintel.html'));
    expect(rows).toHaveLength(9);
    expect(rows[0]).toEqual({
      name: 'Sintel 4K UHD ENG FLAC ITA ENG Sub DMRip 1744p X264 ZMachine',
      href: '/torrent/1010994/Sintel-4K-UHD-ENG-FLAC-ITA-ENG-Sub-DMRip-1744p-X264-ZMachine/',
      seeds: '1',
      leeches: expect.any(String),
      size: '4.8 GB',
    });
    expect(toRow(rows[0], X)).toEqual({
      name: rows[0].name,
      page_url: 'https://1337x.la/torrent/1010994/Sintel-4K-UHD-ENG-FLAC-ITA-ENG-Sub-DMRip-1744p-X264-ZMachine/',
      seeds: 1,
      leeches: expect.any(Number),
      size_bytes: Math.round(4.8 * 1024 ** 3),
    });
    expect(x1337.releasePath(toRow(rows[0], X).page_url, X)).toBe('/torrent/1010994/Sintel-4K-UHD-ENG-FLAC-ITA-ENG-Sub-DMRip-1744p-X264-ZMachine/');
  });

  it('reads the magnet link of a release page', () => {
    const magnet = parseMagnet(readMagnet(page('1337x-release.html')));
    expect(magnet.info_hash).toBe('64877b5490208c3015c0f5121287949d62622e54');
    expect(magnet.trackers).toContain('udp://tracker.opentrackr.org:1337/announce');
  });

  it('asks films under Movies and an episode under TV', () => {
    expect(path1337x('Sintel', false, 1)).toBe('/category-search/Sintel/Movies/1/');
    expect(path1337x('Bear', true, 2)).toBe('/category-search/Bear/TV/2/');
  });

  it('builds expressions that parse', () => {
    parses(searchExpression(['/category-search/Sintel/Movies/1/', '/category-search/Sintel/Movies/2/']));
    parses(magnetsExpression(['/torrent/1/a/', '/torrent/2/b/']));
  });
});

describe('ext.to pages (saved 2026-11-16)', () => {
  it('reads the rows of an IMDb search', () => {
    const rows = readExtRows(page('ext-search-sintel.html'));
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({
      name: 'Sintel (2010) 720p BluRay x264 2.0 YTS YIFY',
      href: '/sintel-2010-720p-bluray-x264-2-0-yts-yify-15037012/',
      seeds: '33',
      leeches: '1',
      size: '136.52 MB',
      id: '15037012',
    });
    expect(toRow(rows[0], E)).toMatchObject({ seeds: 33, size_bytes: Math.round(136.52 * 1024 ** 2), page_url: 'https://ext.to/sintel-2010-720p-bluray-x264-2-0-yts-yify-15037012/' });
    expect(ext.releasePath(toRow(rows[0], E).page_url, E)).toBe('/sintel-2010-720p-bluray-x264-2-0-yts-yify-15037012/');
  });

  it('reads an episode search, every row that episode', () => {
    const rows = readExtRows(page('ext-search-bear-s02e03.html'));
    expect(rows).toHaveLength(8);
    for (const row of rows) expect(row.name).toMatch(/S02E03/);
  });

  it('searches by IMDb id, with the episode mark, most seeds first', () => {
    expect(extPath({ title: 'Sintel', year: 2010, season: null, episode: null, imdb: 'tt1727587' })).toBe('/browse/?imdb_id=tt1727587&sort=seeds&order=desc');
    expect(extPath({ title: 'The Bear', year: 2022, season: 2, episode: 3, imdb: 'tt14452776' })).toBe('/browse/?q=S02E03&imdb_id=tt14452776&sort=seeds&order=desc');
    expect(extPath({ title: 'Sintel', year: 2010, season: null, episode: null, imdb: null })).toBe('/browse/?q=Sintel+2010&sort=seeds&order=desc');
  });

  it("asks a release page's magnet the way its own button does", async () => {
    const answer = JSON.parse(fixture('ext-magnet.json'));
    const fetch = vi.fn(async () => ({ status: 200, json: async () => answer }));
    const out = await askExtMagnet({
      fetch,
      computeHMAC: (id: number, ts: number, token: string) => `h:${id}:${ts}:${token}`,
      sessid: '08cab522f5e0ce6a895f7e365a7d998a',
      pageToken: '6a3dfc854461768ba4652a2732343069',
      torrentId: 15037012,
      now: () => 1_794_832_570_000,
    });
    expect(parseMagnet(out.magnet).info_hash).toBe('a779fa758f2229586eebc2e5960eb32fe5659596');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { method: string; body: URLSearchParams }];
    expect(url).toBe('/ajax/getTorrentMagnet.php');
    expect(init.method).toBe('POST');
    expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({
      torrent_id: '15037012',
      action: 'get_magnet',
      timestamp: '1794832570',
      hmac: 'h:15037012:1794832570:6a3dfc854461768ba4652a2732343069',
      sessid: '08cab522f5e0ce6a895f7e365a7d998a',
    });
  });

  it('asks nothing on a page without the button script', async () => {
    const fetch = vi.fn();
    expect(await askExtMagnet({ fetch, computeHMAC: null, sessid: '', pageToken: undefined, torrentId: 1, now: Date.now })).toEqual({ error: 'the page has no magnet button script' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('builds expressions that parse', () => {
    parses(navigateExpression('/browse/?imdb_id=tt1727587&sort=seeds&order=desc'));
    parses(rowsExpression('/browse/?imdb_id=tt1727587&sort=seeds&order=desc'));
    parses(magnetExpression('/sintel-2010-15037012/', '/sintel-2010-16241483/'));
    parses(magnetExpression('/sintel-2010-15037012/', null));
  });
});

describe('bot checks', () => {
  it("knows Cloudflare's page and not the sites' own", () => {
    expect(isBotCheckPage(page('ext-challenge.html'))).toBe(true);
    for (const name of ['1337x-search-sintel.html', '1337x-release.html', 'ext-search-sintel.html', 'ext-release-sintel.html']) expect(isBotCheckPage(page(name))).toBe(false);
  });
});

describe('matching a release name to the title', () => {
  const film = (title: string, year: number | null) => ({ title, year, season: null, episode: null });

  it('takes every Oppenheimer row of the saved page and nothing for another title', () => {
    const names = read1337xRows(page('1337x-search-oppenheimer.html')).map((row: { name: string }) => row.name);
    expect(names).toHaveLength(8);
    for (const name of names) expect(sameTitle(name, film('Oppenheimer', 2023))).toBe(true);
    expect(sameTitle('Hawaii Five-0 2010 S09E01 HDTV x264-KILLERS [eztv]', film('Sintel', 2010))).toBe(false);
    expect(sameTitle('Iron man 2 (2010) 1080p BrRip x264 - 1.60GB - YIFY', film('Sintel', 2010))).toBe(false);
  });

  it('reads titles that hold years, slashes and other alphabets', () => {
    expect(sameTitle('Blade.Runner.2049.2017.1080p.BluRay.x264', film('Blade Runner 2049', 2017))).toBe(true);
    expect(sameTitle('Blade.Runner.2049.2017.1080p.BluRay.x264', film('Blade Runner', 1982))).toBe(false);
    expect(sameTitle('1917.2019.1080p.WEBRip.x264', film('1917', 2019))).toBe(true);
    expect(sameTitle('Синтел / Sintel (2010) 4K', film('Sintel', 2010))).toBe(true);
    expect(sameTitle('Sintel / Durian [2010, Netherlands, short, fantasy, HDRip 1080p] 2x DVO + VO + ENG + Sub', film('Sintel', 2010))).toBe(true);
    expect(sameTitle('Sintel H264 Eng Multisubs Tntvillage', film('Sintel', 2010))).toBe(true);
    expect(sameTitle("Charlotte's.Web.2006.DVDRip.XviD", film("Charlotte's", 2010))).toBe(false);
    expect(releaseNames('Blade.Runner.2049.2017.1080p').years).toEqual([2049, 2017]);
  });

  it("does not compare an episode's year", () => {
    expect(sameTitle('The.Bear.S02E03.1080p.WEB.h264-EDITH', { title: 'The Bear', year: 2022, season: 2, episode: 3 })).toBe(true);
    expect(sameTitle('The Bear 2023 S02E03 720p', { title: 'The Bear', year: 2022, season: 2, episode: 3 })).toBe(true);
  });

  it('searches without the small words', () => {
    expect(searchWords('The Bear')).toBe('Bear');
    expect(searchWords('Lord of the Rings')).toBe('Lord Rings');
    expect(searchWords("Ocean's Eleven")).toBe("Ocean's Eleven");
    expect(searchWords('The The')).toBe('The The');
  });
});

describe('sizes and magnets', () => {
  it('reads sizes', () => {
    expect(parseSize('4.8 GB')).toBe(Math.round(4.8 * 1024 ** 3));
    expect(parseSize('136.52 MB')).toBe(Math.round(136.52 * 1024 ** 2));
    expect(parseSize('1,234.5 MB')).toBe(Math.round(1234.5 * 1024 ** 2));
    expect(parseSize('2 GiB')).toBe(2 * 1024 ** 3);
    expect(parseSize('')).toBeNull();
  });

  it('reads hex and base32 hashes and keeps only tracker addresses', () => {
    expect(parseMagnet('magnet:?xt=urn:btih:MSDXWVEQECGDAFOA6UJBFB4UTVRGELSU&dn=Sintel')?.info_hash).toBe('64877b5490208c3015c0f5121287949d62622e54');
    expect(parseMagnet('magnet:?xt=urn:btih:64877B5490208C3015C0F5121287949D62622E54&tr=udp%3A%2F%2Fa.example%3A1337&tr=javascript%3Ax')?.trackers).toEqual(['udp://a.example:1337']);
    expect(parseMagnet('magnet:?xt=urn:sha1:abc')).toBeNull();
    expect(parseMagnet('https://1337x.la/')).toBeNull();
  });
});

describe('cli.mjs', () => {
  const ORIGIN = 'https://1337x.example';
  const SINTEL = { name: 'Sintel.2010.720p.BluRay.x264', page_url: `${ORIGIN}/torrent/1/sintel-720p/`, seeds: 12, leeches: 1, size_bytes: 100 };
  const HAWAII = { name: 'Hawaii Five-0 2010 S09E01 HDTV x264-KILLERS [eztv]', page_url: `${ORIGIN}/torrent/2/hawaii/`, seeds: 1717, leeches: 470, size_bytes: 200 };
  const HASH = 'ab'.repeat(20);

  function fakeSite(overrides: Record<string, unknown> = {}) {
    return {
      name: '1337x',
      label: '1337x',
      defaultOrigin: ORIGIN,
      needsTitle: true,
      releasePath: x1337.releasePath,
      search: vi.fn(async () => ({ url: `${ORIGIN}/category-search/Sintel/Movies/1/`, rows: [SINTEL, HAWAII] })),
      magnets: vi.fn(async (_origin: string, paths: string[]) => paths.map((path) => ({ path, magnet: `magnet:?xt=urn:btih:${HASH}&tr=udp%3A%2F%2Ftracker.example%3A1337`, error: null }))),
      ...overrides,
    };
  }

  async function run(argv: string[], site: ReturnType<typeof fakeSite>) {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await main(argv, { sites: { '1337x': site } });
      return { code, out: JSON.parse(String(log.mock.calls.at(-1)?.[0])) };
    } finally {
      log.mockRestore();
    }
  }

  it('search keeps only the releases named as the title', async () => {
    const site = fakeSite();
    const { code, out } = await run(['1337x', 'search', '--title', 'Sintel', '--year', '2010', '--origin', ORIGIN], site);
    expect(code).toBe(0);
    expect(out.rows).toEqual([SINTEL]);
    expect(out.others).toBe(1);
    expect(site.search).toHaveBeenCalledWith(ORIGIN, { title: 'Sintel', year: 2010, season: null, episode: null, imdb: null }, { deadline: expect.any(Number) });
  });

  it('search without a title on 1337x asks nothing', async () => {
    const site = fakeSite();
    const { code, out } = await run(['1337x', 'search', '--imdb', 'tt1727587'], site);
    expect(code).toBe(2);
    expect(out.error).toBe('no_title');
    expect(site.search).not.toHaveBeenCalled();
  });

  it("magnets refuses an address that is not a release page on the site", async () => {
    const site = fakeSite();
    const { code, out } = await run(['1337x', 'magnets', '--origin', ORIGIN, 'https://evil.example/torrent/1/x/'], site);
    expect(code).toBe(2);
    expect(out.error).toBe('usage');
    expect(site.magnets).not.toHaveBeenCalled();
  });

  it('magnets answers each page with its info hash and trackers', async () => {
    const site = fakeSite();
    const { code, out } = await run(['1337x', 'magnets', '--origin', ORIGIN, SINTEL.page_url], site);
    expect(code).toBe(0);
    expect(out.magnets).toEqual([{ page_url: SINTEL.page_url, info_hash: HASH, trackers: ['udp://tracker.example:1337'], magnet: expect.stringContaining(HASH), error: null }]);
    expect(site.magnets).toHaveBeenCalledWith(ORIGIN, ['/torrent/1/sintel-720p/'], { deadline: expect.any(Number) });
  });

  it('a bot check is the answer bot_check, and nothing more is asked', async () => {
    const site = fakeSite({ search: vi.fn(async () => { throw new BotCheckError('the page stayed on "Just a moment..."'); }) });
    const { code, out } = await run(['1337x', 'search', '--title', 'Sintel'], site);
    expect(code).toBe(1);
    expect(out).toMatchObject({ ok: false, error: 'bot_check' });
    expect(site.magnets).not.toHaveBeenCalled();
  });

  it('a machine without the Windows Chrome answers no_chrome', async () => {
    const site = fakeSite({ search: vi.fn(async () => { throw new ChromeError('no_chrome', 'chrome.exe was not found'); }) });
    const { out } = await run(['1337x', 'search', '--title', 'Sintel'], site);
    expect(out).toMatchObject({ ok: false, error: 'no_chrome' });
  });

  it('by hand it searches, then reads the magnets of the matching releases', async () => {
    const site = fakeSite();
    const { code, out } = await run(['1337x', 'sintel', '2010', '--origin', ORIGIN], site);
    expect(code).toBe(0);
    expect(out.query).toEqual({ title: 'sintel', year: 2010, season: null, episode: null, imdb: null });
    expect(out.releases).toEqual([{ ...SINTEL, info_hash: HASH, trackers: ['udp://tracker.example:1337'], magnet: expect.any(String), error: null }]);
    expect(site.magnets).toHaveBeenCalledWith(ORIGIN, ['/torrent/1/sintel-720p/'], { deadline: expect.any(Number) });
  });

  it('--sites lists the real modules', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await main(['--sites'])).toBe(0);
      expect(JSON.parse(String(log.mock.calls[0]?.[0])).map((s: { name: string }) => s.name)).toEqual(['1337x', 'ext']);
    } finally {
      log.mockRestore();
    }
  });

  it('reads flags and names what is wrong with them', () => {
    expect(readOptions(['--season', '2']).bad).toBe('--season and --episode go together');
    expect(readOptions(['--imdb', '1727587']).bad).toMatch(/IMDb id/);
    expect(readOptions(['--origin', 'https://1337x.la/x/y']).origin).toBe('https://1337x.la');
    expect(readOptions(['--bogus']).bad).toBe('unknown flag --bogus');
  });
});
```
**Impact:** this file covers the scripts. No test opens Chrome: the CLI tests inject a fake site,
and the page readers run on the saved pages.

### Step 10: The settings
**File:** `src/config.ts`. Put the constants, the interface and the default right above phase 1's
`export interface TorrentConfig` (phase 1 adds it after `DEFAULT_DIRECT_STREAM_CONFIG`, around line
231). Put `parseTorrentSites` and `parseTorrentSiteOrigin` right after phase 1's `parseTorrent` function (phase 6 renames
`parseAnimeMapUrl` to `parseUrlOrOff`, so that is no anchor).
**Change:** each address is checked once, where it enters. `off` is `null`, so a site that is off
cannot be asked. The names of the sites are the keys of `origins`, and `find-sites.ts` types its
list against them.
**Code (constants and types):**
```ts
/** `claude/streaming/torrent/cli.mjs` in this checkout: the torrent sites script the daemon runs (torrent phase 9). */
export const DEFAULT_TORRENT_SITES_CLI = path.join(REPO_ROOT, 'claude', 'streaming', 'torrent', 'cli.mjs')

/** Where 1337x and ext.to are by default. claude/streaming/torrent/sites/*.mjs default to the same addresses (a test compares them). */
export const TORRENT_SITE_ORIGIN_DEFAULTS = { '1337x': 'https://1337x.la', ext: 'https://ext.to' } as const

/**
 * The torrent sites the finder falls back on when the JSON indexes give nothing usable, asked through
 * the streaming Chrome (src/directStream/torrent/find-sites.ts).
 */
export interface TorrentSitesConfig {
  /**
   * Each site's address, scheme and host only: `NOTESD_TORRENT_1337X_ORIGIN` (default
   * https://1337x.la) and `NOTESD_TORRENT_EXT_ORIGIN` (default https://ext.to). Null: `off`, the
   * site is never asked.
   */
  origins: { '1337x': string | null; ext: string | null }
  /** `NOTESD_TORRENT_SITES_CLI`, absolute, default DEFAULT_TORRENT_SITES_CLI: the script run as `node <cli>`. */
  cli: string
}

export const DEFAULT_TORRENT_SITES_CONFIG: TorrentSitesConfig = {
  origins: { ...TORRENT_SITE_ORIGIN_DEFAULTS },
  cli: DEFAULT_TORRENT_SITES_CLI,
}
```
**Code (inside phase 1's `TorrentConfig` interface, as its last field):**
```ts
  /** 1337x and ext.to, the finder's fallback (phase 9). Unset: DEFAULT_TORRENT_SITES_CONFIG. */
  sites?: TorrentSitesConfig
```
**Code (inside phase 1's `DEFAULT_TORRENT_CONFIG` object, as its last property):**
```ts
  sites: DEFAULT_TORRENT_SITES_CONFIG,
```
**Code (inside the object phase 1's `parseTorrent(env)` returns, as its last property):**
```ts
    sites: parseTorrentSites(env),
```
**Code (parsers, after phase 1's `parseTorrent`):**
```ts
export function parseTorrentSites(env: Record<string, string | undefined>): TorrentSitesConfig {
  return {
    origins: {
      '1337x': parseTorrentSiteOrigin('NOTESD_TORRENT_1337X_ORIGIN', env.NOTESD_TORRENT_1337X_ORIGIN, TORRENT_SITE_ORIGIN_DEFAULTS['1337x']),
      ext: parseTorrentSiteOrigin('NOTESD_TORRENT_EXT_ORIGIN', env.NOTESD_TORRENT_EXT_ORIGIN, TORRENT_SITE_ORIGIN_DEFAULTS.ext),
    },
    cli: parseOptionalAbsolutePath('NOTESD_TORRENT_SITES_CLI', env.NOTESD_TORRENT_SITES_CLI) ?? DEFAULT_TORRENT_SITES_CLI,
  }
}

/** A torrent site's address: unset or blank is the default, `off` is null, anything else must be scheme and host only. */
function parseTorrentSiteOrigin(name: string, raw: string | undefined, fallback: string): string | null {
  const value = (raw ?? '').trim()
  if (value === '') return fallback
  if (value.toLowerCase() === 'off') return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConfigError(`${name} must be a site address such as https://1337x.la, or off (got "${raw}")`)
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== value.replace(/\/+$/, '')) {
    throw new ConfigError(`${name} must be a site address such as https://1337x.la (scheme and host, no path), or off (got "${raw}")`)
  }
  return url.origin
}
```
**Impact:** `Config.torrent.sites` exists after a real `loadConfig`. Test literals of
`TorrentConfig` that leave `sites` out still compile, because the field is optional.

### Step 11: The index per site
**File:** `src/directStream/torrent/find-sites.ts` (new)
**Change:** each site becomes a `TorrentIndex`. `find` runs `search`. It keeps at most five rows,
choosing them with **phase 2's `parseRelease`** (no copy of its rules): no dub, cinema copy or 3D,
no other episode, at least one seed, most seeds first. It then runs `magnets` for those rows and
makes `TorrentCandidate`s. Phase 2's `findCandidates` then filters and ranks those candidates like
any other. Every failure becomes an `IndexAnswer` and nothing is thrown.
**Code:**
```ts
import { z } from 'zod'
import type { TorrentSitesConfig } from '../../config.js'
import { runJsonScript } from '../../streaming/service.js'
import { candidateFrom, parseRelease, type IndexAnswer, type TorrentCandidate, type TorrentIndex } from './find/index.js'

/**
 * 1337x and ext.to: the torrent finder's fallback (torrent phase 9). They are asked through
 * claude/streaming/torrent/cli.mjs inside the streaming Chrome only when the JSON indexes give
 * nothing usable. claude/streaming/torrent/sites/index.mjs holds the same names; a test compares them.
 */
export const TORRENT_SITES = ['1337x', 'ext'] as const satisfies ReadonlyArray<keyof TorrentSitesConfig['origins']>
export type TorrentSiteName = (typeof TORRENT_SITES)[number]

/** One site, both steps. The finder asks the sites side by side, so both together take about this long. */
export const TORRENT_SITES_DEADLINE_MS = 40_000
/** The search step's share at most, so the release pages keep the rest. */
export const TORRENT_SITES_SEARCH_MS = 25_000
/** Release pages read for magnet links: the best-seeded rows that survive the release-name filter. */
export const MAX_RELEASE_PAGES = 5
/** The script is told to answer this much before the daemon would stop it. */
const SCRIPT_MARGIN_S = 3

type FindQuery = Parameters<TorrentIndex['find']>[0]
type FindContext = Parameters<TorrentIndex['find']>[1]
type ReleaseInfo = ReturnType<typeof parseRelease>

/** Runs `node claude/streaming/torrent/cli.mjs <args...>` and returns the JSON it prints; tests inject a fake. */
export type TorrentSiteRunner = (args: string[], options: { timeoutMs: number }) => Promise<unknown>

export function torrentSitesScriptRunner(options: { cliPath: string; nodeBin?: string }): TorrentSiteRunner {
  const nodeBin = options.nodeBin ?? process.execPath
  return (args, { timeoutMs }) => runJsonScript({ label: 'torrent sites script', nodeBin, argv: [options.cliPath, ...args], timeoutMs })
}

const rowSchema = z.object({
  name: z.string().min(1),
  page_url: z.string().url(),
  seeds: z.number().int().nonnegative(),
  leeches: z.number().int().nonnegative().nullish(),
  size_bytes: z.number().int().nonnegative().nullish(),
})
type SiteRow = z.infer<typeof rowSchema>

const failedSchema = z.object({ ok: z.literal(false), error: z.string().min(1), detail: z.string().nullish() })
const searchSchema = z.object({ ok: z.literal(true), url: z.string(), rows: z.array(rowSchema), others: z.number().int().nonnegative().nullish() })
const magnetsSchema = z.object({
  ok: z.literal(true),
  magnets: z.array(
    z.object({
      page_url: z.string(),
      info_hash: z.string().regex(/^[0-9a-f]{40}$/).nullish(),
      trackers: z.array(z.string()).nullish(),
      error: z.string().nullish(),
    }),
  ),
})

const answer = (outcome: IndexAnswer['outcome'], detail: string, candidates: TorrentCandidate[] = []): IndexAnswer => ({ outcome, detail, candidates })

/** A failure the script printed. A bot check is its own outcome; anything else (no_chrome too) is an error. */
function failed(value: unknown, step: string): IndexAnswer | null {
  const parsed = failedSchema.safeParse(value)
  if (!parsed.success) return null
  const detail = `${step}: ${parsed.data.error}${parsed.data.detail ? `: ${parsed.data.detail}` : ''}`
  return answer(parsed.data.error === 'bot_check' ? 'bot_check' : 'error', detail)
}

/** The asked episode, or null for a film (phase 2's TorrentQuery is a union: only a `tv` query has one). */
const episodeOf = (query: FindQuery): { season: number; episode: number } | null => (query.kind === 'tv' ? { season: query.season, episode: query.episode } : null)

/**
 * The rows worth a release page: seeded, not a dub, a cinema copy or 3D, and not another episode
 * (by phase 2's reading of the release name), most seeds first, at most MAX_RELEASE_PAGES.
 * findCandidates applies the full filter and ranking afterwards; this only spends the page reads well.
 */
export function pickRows(rows: SiteRow[], query: FindQuery): Array<SiteRow & { release: ReleaseInfo }> {
  const episode = episodeOf(query)
  return rows
    .map((row) => ({ ...row, release: parseRelease(row.name) }))
    .filter(({ seeds, release }) => seeds > 0 && !release.dubbed && !release.cam && !release.threeD)
    .filter(({ release }) => episode === null || ((release.season == null || release.season === episode.season) && (release.episode == null || release.episode === episode.episode)))
    .sort((a, b) => b.seeds - a.seeds)
    .slice(0, MAX_RELEASE_PAGES)
}

function imdbArg(imdbId: string | null | undefined): string | null {
  if (!imdbId) return null
  return imdbId.startsWith('tt') ? imdbId : `tt${imdbId}`
}

function searchArgs(site: TorrentSiteName, origin: string, query: FindQuery, timeoutMs: number): string[] {
  const args = [site, 'search', '--origin', origin, '--deadline-s', String(Math.max(5, Math.floor(timeoutMs / 1000) - SCRIPT_MARGIN_S))]
  if (query.title) args.push('--title', query.title)
  if (query.year != null) args.push('--year', String(query.year))
  const episode = episodeOf(query)
  if (episode !== null) args.push('--season', String(episode.season), '--episode', String(episode.episode))
  const imdb = imdbArg(query.imdbId)
  if (imdb !== null) args.push('--imdb', imdb)
  return args
}

export interface TorrentSiteIndexOptions {
  /** The site's address, scheme and host (from TorrentSitesConfig.origins). */
  origin: string
  runner: TorrentSiteRunner
  /** Default TORRENT_SITES_DEADLINE_MS. */
  deadlineMs?: number
  /** Default Date.now; tests pin it. */
  now?: () => number
}

/** One torrent site as an index of the finder. Never throws: every failure is its answer's outcome. */
export function torrentSiteIndex(site: TorrentSiteName, options: TorrentSiteIndexOptions): TorrentIndex {
  const deadlineMs = options.deadlineMs ?? TORRENT_SITES_DEADLINE_MS
  const now = options.now ?? Date.now
  return {
    name: site,
    // A fallback index keeps its own limit (phase 2): the JSON indexes' 10 s would cut a browser-driven site short.
    timeoutMs: deadlineMs,
    async find(query: FindQuery, context: FindContext): Promise<IndexAnswer> {
      const signal = (context as { signal?: AbortSignal } | undefined)?.signal
      if (signal?.aborted) return answer('error', 'aborted before the search')
      const deadline = now() + deadlineMs
      const left = (): number => deadline - now()
      try {
        const searchMs = Math.min(TORRENT_SITES_SEARCH_MS, left())
        const searched = await options.runner(searchArgs(site, options.origin, query, searchMs), { timeoutMs: searchMs })
        const searchFailure = failed(searched, 'search')
        if (searchFailure !== null) return searchFailure
        const found = searchSchema.safeParse(searched)
        if (!found.success) return answer('error', `search: unreadable answer (${found.error.issues[0]?.message ?? 'no detail'})`)
        if (found.data.rows.length === 0) return answer('empty', `no release named as the title on ${found.data.url}`)
        const picked = pickRows(found.data.rows, query)
        if (picked.length === 0) {
          return answer('empty', `${found.data.rows.length} releases listed, none seeded and free of dubs, cinema copies, 3D and other episodes`)
        }
        if (signal?.aborted) return answer('error', 'aborted before the release pages')
        if (left() < 5_000) return answer('error', 'deadline: no time left for the release pages')
        const magnetMs = left()
        const read = await options.runner(
          [site, 'magnets', '--origin', options.origin, '--deadline-s', String(Math.max(5, Math.floor(magnetMs / 1000) - SCRIPT_MARGIN_S)), ...picked.map((row) => row.page_url)],
          { timeoutMs: magnetMs },
        )
        const magnetFailure = failed(read, 'magnets')
        if (magnetFailure !== null) return magnetFailure
        const magnets = magnetsSchema.safeParse(read)
        if (!magnets.success) return answer('error', `magnets: unreadable answer (${magnets.error.issues[0]?.message ?? 'no detail'})`)
        const byPage = new Map(magnets.data.magnets.map((entry) => [entry.page_url, entry]))
        const candidates: TorrentCandidate[] = []
        for (const row of picked) {
          const entry = byPage.get(row.page_url)
          if (!entry?.info_hash) continue
          // Phase 2's one place a listed row becomes a candidate (hash, trackers, release parsed with the query).
          candidates.push(
            candidateFrom({ infoHash: entry.info_hash, name: row.name, seeds: row.seeds, sizeBytes: row.size_bytes ?? null, trackers: entry.trackers ?? [], site }, site, query),
          )
        }
        if (candidates.length === 0) {
          const why = magnets.data.magnets.find((entry) => entry.error)?.error ?? 'no magnet link'
          return answer('error', `magnets: none of ${picked.length} release pages gave a magnet link (${why})`)
        }
        return answer('ok', `${candidates.length} of ${found.data.rows.length} listed releases`, candidates)
      } catch (err) {
        return answer('error', err instanceof Error ? err.message : String(err))
      }
    },
  }
}

/** The sites that are on, as the finder's fallback indexes, in TORRENT_SITES order. */
export function torrentSiteIndexes(config: TorrentSitesConfig, runner: TorrentSiteRunner): TorrentIndex[] {
  const indexes: TorrentIndex[] = []
  for (const site of TORRENT_SITES) {
    const origin = config.origins[site]
    if (origin !== null) indexes.push(torrentSiteIndex(site, { origin, runner }))
  }
  return indexes
}
```
**Impact:** new file. It calls phase 2's `parseRelease` and type names only.

### Step 12: Tests for the index and the settings
**Files:** `tests/unit/directStream/torrent/findSites.test.ts` (new),
`tests/unit/config.torrentSites.test.ts` (new)
**Code (`findSites.test.ts`):**
```ts
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error -- plain .mjs scripts without type declarations
import { TORRENT_SITE_MODULES } from '../../../../claude/streaming/torrent/sites/index.mjs'
import { DEFAULT_TORRENT_SITES_CONFIG, TORRENT_SITE_ORIGIN_DEFAULTS } from '../../../../src/config.js'
import { findCandidates, parseRelease, type TorrentIndex } from '../../../../src/directStream/torrent/find/index.js'
import {
  MAX_RELEASE_PAGES,
  TORRENT_SITES,
  TORRENT_SITES_DEADLINE_MS,
  torrentSiteIndex,
  torrentSiteIndexes,
  type TorrentSiteRunner,
} from '../../../../src/directStream/torrent/find-sites.js'

type FindQuery = Parameters<TorrentIndex['find']>[0]
type FindContext = Parameters<TorrentIndex['find']>[1]

const ORIGIN = 'https://1337x.la'
const hashOf = (url: string): string => createHash('sha1').update(url).digest('hex')
const row = (id: number, name: string, seeds: number) => ({
  name,
  page_url: `${ORIGIN}/torrent/${id}/${name.replace(/[^A-Za-z0-9]+/g, '-')}/`,
  seeds,
  leeches: 10,
  size_bytes: 2_000_000_000,
})
// The Oppenheimer rows of the saved 1337x page (tests/fixtures/torrent-sites/1337x-search-oppenheimer.html),
// as `cli.mjs 1337x search` prints them, plus one unseeded row.
const ROWS = [
  row(5876708, 'Oppenheimer.2023.1080p.BluRay.DD5.1.x264-GalaxyRG', 6115),
  row(5829624, 'Oppenheimer (2023) NEW ENG 1080p.MP4.InfosPack022', 3212),
  row(5876811, 'Oppenheimer.2023.1080p.BluRay.DDP5.1.x265.10bit-GalaxyRG265', 2215),
  row(5737733, 'Oppenheimer (2023) NEW ENG 1080p HQ-CAM x264 AAC - HushRips', 1903),
  row(5876703, 'Oppenheimer.2023.720p.BluRay.999MB.x264-GalaxyRG', 1811),
  row(5752149, 'Oppenheimer.2023.1080p.LM.HD-TeleSync.DUAL.DD2.0.H.264-xCLuMsYx', 1713),
  row(5882292, 'Oppenheimer.2023.2160p.UHD.Bluray.REMUX.HDR10.HEVC.DTS-HD.MA.5.1-GHD[TGx]', 1687),
  row(5876686, 'Oppenheimer.2023.1080p.Bluray.REMUX.AVC.DTS-HD.MA.5.1-GHD[TGx]', 1253),
  row(1, 'Oppenheimer.2023.1080p.WEBRip.x264-NOBODY', 0),
]
const FILM = { imdbId: 'tt15398776', kind: 'movie', title: 'Oppenheimer', year: 2023 } as unknown as FindQuery
const CONTEXT = { fetch: globalThis.fetch, signal: new AbortController().signal } as unknown as FindContext
const pageUrls = (args: string[]): string[] => args.filter((arg) => arg.startsWith(`${ORIGIN}/torrent/`))

function fakeRunner(searchAnswer: unknown, magnetsAnswer?: (urls: string[]) => unknown) {
  return vi.fn<TorrentSiteRunner>(async (args) => {
    if (args[1] === 'search') return searchAnswer
    const urls = pageUrls(args)
    return magnetsAnswer
      ? magnetsAnswer(urls)
      : { ok: true, site: args[0], origin: ORIGIN, magnets: urls.map((url) => ({ page_url: url, info_hash: hashOf(url), trackers: ['udp://tracker.opentrackr.org:1337/announce'], error: null })) }
  })
}
const searched = (rows: unknown[]) => ({ ok: true, site: '1337x', origin: ORIGIN, url: `${ORIGIN}/category-search/Oppenheimer/Movies/1/`, rows, others: 0 })

describe('the torrent site list', () => {
  it('is the same in claude/streaming/torrent, the finder and the settings', () => {
    expect([...TORRENT_SITES].sort()).toEqual(Object.keys(TORRENT_SITE_MODULES).sort())
    expect([...TORRENT_SITES].sort()).toEqual(Object.keys(DEFAULT_TORRENT_SITES_CONFIG.origins).sort())
    for (const site of TORRENT_SITES) expect(TORRENT_SITE_MODULES[site].defaultOrigin).toBe(TORRENT_SITE_ORIGIN_DEFAULTS[site])
  })

  it('leaves out a site that is off', () => {
    const runner = fakeRunner(searched([]))
    expect(torrentSiteIndexes({ ...DEFAULT_TORRENT_SITES_CONFIG, origins: { '1337x': null, ext: 'https://ext.to' } }, runner).map((index) => index.name)).toEqual(['ext'])
    expect(torrentSiteIndexes(DEFAULT_TORRENT_SITES_CONFIG, runner).map((index) => index.name)).toEqual(['1337x', 'ext'])
  })
})

describe('torrentSiteIndex', () => {
  it('reads the magnets of the five best-seeded rows that are no cinema copy, dub or unseeded release', async () => {
    const runner = fakeRunner(searched(ROWS))
    const out = await torrentSiteIndex('1337x', { origin: ORIGIN, runner }).find(FILM, CONTEXT)
    expect(out.outcome).toBe('ok')
    expect(runner).toHaveBeenCalledTimes(2)
    const [searchArgs, searchOptions] = runner.mock.calls[0]!
    expect(searchArgs).toEqual(['1337x', 'search', '--origin', ORIGIN, '--deadline-s', expect.stringMatching(/^\d+$/), '--title', 'Oppenheimer', '--year', '2023', '--imdb', 'tt15398776'])
    expect(searchOptions.timeoutMs).toBeLessThanOrEqual(TORRENT_SITES_DEADLINE_MS)
    const asked = pageUrls(runner.mock.calls[1]![0])
    expect(asked).toHaveLength(MAX_RELEASE_PAGES)
    expect(asked.join(' ')).not.toMatch(/CAM|TeleSync|NOBODY/)
    expect(out.candidates.map((c) => c.seeds)).toEqual([6115, 3212, 2215, 1811, 1687])
    for (const candidate of out.candidates) {
      expect(candidate.index).toBe('1337x')
      expect(candidate.infoHash).toMatch(/^[0-9a-f]{40}$/)
      // Built by phase 2's candidateFrom: the release read with the query's title, the site's trackers first.
      expect(candidate.release).toEqual(parseRelease(candidate.name, { title: 'Oppenheimer', fileName: null }))
      expect(candidate.trackers[0]).toBe('udp://tracker.opentrackr.org:1337/announce')
      expect(candidate).toMatchObject({ listedBy: ['1337x'], site: '1337x', scoped: false, fileName: null, fileIdx: null })
      expect(candidate.sizeBytes).toBe(2_000_000_000)
    }
    expect(out.candidates[0]!.infoHash).toBe(hashOf(ROWS[0]!.page_url))
  })

  it('asks an episode by season and episode and leaves other episodes out', async () => {
    const episode = { imdbId: 'tt14452776', kind: 'tv', title: 'The Bear', year: 2022, season: 2, episode: 3 } as unknown as FindQuery
    const runner = fakeRunner(searched([row(10, 'The.Bear.S02E03.1080p.WEB.h264-EDITH', 300), row(11, 'The.Bear.S02E04.1080p.WEB.h264-EDITH', 900), row(12, 'The.Bear.S02.COMPLETE.1080p.HULU.WEB.H264-SuccessfulCrab', 500)]))
    const out = await torrentSiteIndex('1337x', { origin: ORIGIN, runner }).find(episode, CONTEXT)
    expect(runner.mock.calls[0]![0]).toEqual(expect.arrayContaining(['--season', '2', '--episode', '3']))
    expect(pageUrls(runner.mock.calls[1]![0]).join(' ')).not.toMatch(/S02E04/)
    expect(out.candidates.map((c) => c.name)).toEqual(['The.Bear.S02.COMPLETE.1080p.HULU.WEB.H264-SuccessfulCrab', 'The.Bear.S02E03.1080p.WEB.h264-EDITH'])
  })

  it('a bot check is the outcome bot_check and no release page is asked', async () => {
    const runner = fakeRunner({ ok: false, site: 'ext', origin: 'https://ext.to', error: 'bot_check', detail: 'the page stayed on "Just a moment..."' })
    const out = await torrentSiteIndex('ext', { origin: 'https://ext.to', runner }).find(FILM, CONTEXT)
    expect(out).toEqual({ outcome: 'bot_check', detail: 'search: bot_check: the page stayed on "Just a moment..."', candidates: [] })
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('a machine without the Windows Chrome is an error naming no_chrome', async () => {
    const runner = fakeRunner({ ok: false, error: 'no_chrome', detail: 'cannot run PowerShell' })
    const out = await torrentSiteIndex('1337x', { origin: ORIGIN, runner }).find(FILM, CONTEXT)
    expect(out.outcome).toBe('error')
    expect(out.detail).toContain('no_chrome')
  })

  it('a script that fails or hangs is an error, never a throw', async () => {
    const runner = vi.fn<TorrentSiteRunner>(async () => {
      throw new Error('torrent sites script failed: Command failed: timeout')
    })
    const out = await torrentSiteIndex('1337x', { origin: ORIGIN, runner }).find(FILM, CONTEXT)
    expect(out).toMatchObject({ outcome: 'error', candidates: [] })
    expect(out.detail).toContain('timeout')
  })

  it('no matching row is empty and no release page is asked', async () => {
    const runner = fakeRunner(searched([]))
    expect((await torrentSiteIndex('1337x', { origin: ORIGIN, runner }).find(FILM, CONTEXT)).outcome).toBe('empty')
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('release pages without a magnet link are an error', async () => {
    const runner = fakeRunner(searched(ROWS), (urls) => ({ ok: true, magnets: urls.map((url) => ({ page_url: url, info_hash: null, trackers: [], error: 'HTTP 404: no magnet link' })) }))
    const out = await torrentSiteIndex('1337x', { origin: ORIGIN, runner }).find(FILM, CONTEXT)
    expect(out.outcome).toBe('error')
    expect(out.detail).toContain('HTTP 404')
  })
})

describe('findCandidates with the sites as fallback', () => {
  it('adds what the site lists when every JSON index answers nothing, through the same filter', async () => {
    const notFound = vi.fn(async () => new Response('not found', { status: 404 }))
    const runner = fakeRunner(searched(ROWS))
    const result = await findCandidates(FILM, { fetch: notFound, fallback: [torrentSiteIndex('1337x', { origin: ORIGIN, runner })] } as unknown as Parameters<typeof findCandidates>[1])
    expect(runner).toHaveBeenCalled()
    expect(result.candidates.length).toBeGreaterThan(0)
    for (const candidate of result.candidates) {
      expect(candidate.index).toBe('1337x')
      expect(candidate.name).not.toMatch(/CAM|TeleSync/)
    }
    expect(JSON.stringify(result.indexes)).toContain('1337x')
  })
})
```
**Code (`config.torrentSites.test.ts`):**
```ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_TORRENT_SITES_CLI, parseTorrentSites } from '../../src/config.js'

describe('the torrent sites settings', () => {
  it('defaults to 1337x.la, ext.to and the script in this checkout', () => {
    expect(parseTorrentSites({})).toEqual({ origins: { '1337x': 'https://1337x.la', ext: 'https://ext.to' }, cli: DEFAULT_TORRENT_SITES_CLI })
  })

  it('takes another address, scheme and host only, and off', () => {
    const sites = parseTorrentSites({ NOTESD_TORRENT_1337X_ORIGIN: 'https://1337x.to/', NOTESD_TORRENT_EXT_ORIGIN: 'OFF' })
    expect(sites.origins).toEqual({ '1337x': 'https://1337x.to', ext: null })
  })

  it('refuses a path, a non-web address and a relative script path', () => {
    expect(() => parseTorrentSites({ NOTESD_TORRENT_1337X_ORIGIN: 'https://1337x.la/search' })).toThrow(/NOTESD_TORRENT_1337X_ORIGIN must be a site address/)
    expect(() => parseTorrentSites({ NOTESD_TORRENT_EXT_ORIGIN: 'ftp://ext.to' })).toThrow(/NOTESD_TORRENT_EXT_ORIGIN must be a site address/)
    expect(() => parseTorrentSites({ NOTESD_TORRENT_SITES_CLI: 'claude/streaming/torrent/cli.mjs' })).toThrow(/NOTESD_TORRENT_SITES_CLI must be an absolute path/)
  })
})
```
**Impact:** tests only. The `findCandidates` test depends on phase 2's option names (see Handoffs).

### Step 13: Hand the sites to the finder
**File:** `src/daemon.ts`. Phase 3 builds the finder's options inside `buildTorrentSource(config, torrents, wiring)`
and takes the fallback from `wiring.fallback`; its `torrentSourceOf` closure has a `// Phase 5 adds remux and phase 9
fallback here` comment in the wiring object.
**Change:** build the two site indexes before phase 3's `let torrentSource ...` and add one line at that comment.
**Code (imports, next to phase 3's torrent imports):**
```ts
import { DEFAULT_TORRENT_SITES_CONFIG } from './config.js'
import { torrentSiteIndexes, torrentSitesScriptRunner } from './directStream/torrent/find-sites.js'
```
(If `./config.js` is already imported in `src/daemon.ts`, add `DEFAULT_TORRENT_SITES_CONFIG` to that import instead.)
**Code (just before phase 3's `let torrentSource: TorrentSource | null = null;`):**
```ts
  // 1337x and ext.to through the streaming Chrome (torrent phase 9): asked only when the JSON indexes
  // give nothing usable; NOTESD_TORRENT_<SITE>_ORIGIN=off leaves a site out.
  const torrentSites = config.torrent?.sites ?? DEFAULT_TORRENT_SITES_CONFIG
  const torrentSiteFallback = torrentSiteIndexes(torrentSites, torrentSitesScriptRunner({ cliPath: torrentSites.cli }))
```
**Code (one property in the wiring object of phase 3's `buildTorrentSource(...)` call):**
```ts
        fallback: torrentSiteFallback,
```
**Impact:** with torrents off (phase 3 builds no `TorrentSource`), these lines build two plain
objects and start nothing. The sites run only when `findCandidates` asks them.

### Step 14: The throwaway daemon's stand-in
**Files:** `tests/fixtures/direct-stream/fake-torrent-sites.mjs` (new);
`.claude/skills/verify-notesd/scripts/verify.sh` (the `--direct-stream` block at lines 186–195, the
env block at lines 255–263, and the `down` copies at lines 465–470);
`.claude/skills/verify-notesd/SKILL.md` (Gotchas)
**Change:** a throwaway daemon never runs the real script, which would drive the owner's
streaming Chrome. The fake answers by mode and records every call.
**Code (`fake-torrent-sites.mjs`):**
```js
#!/usr/bin/env node
// Stands in for claude/streaming/torrent/cli.mjs in `verify.sh up --direct-stream`: it opens no
// Chrome and reaches no site. Its state is the folder named by TORRENT_SITES_FAKE_DIR:
//   mode         rows (default) | empty | bot_check | no_chrome: how every site answers
//                (rows: 1337x lists one release, ext.to none)
//   calls.jsonl  one line per call, appended: {"at", "args"}
// The release 1337x lists is the torrent TORRENT_SITES_FIXTURE names ({"info_hash", "trackers"?, "size_bytes"?}: the
// loopback-seeded fixture torrent under `up --torrent`), else a made-up Sintel. Its name is made from the asked
// `--title` and `--year` (`<Title>.<Year>.1080p.WEB-DL.x264-NOTESD`), so the finder's title check keeps it.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const dir = process.env.TORRENT_SITES_FAKE_DIR;
const fixtureFile = process.env.TORRENT_SITES_FIXTURE;
const args = process.argv.slice(2);
const DEFAULT_RELEASE = { info_hash: 'a779fa758f2229586eebc2e5960eb32fe5659596', name: 'Sintel.2010.720p.BluRay.x264-FIXTURE', trackers: [], size_bytes: 143_151_268 };

function print(value, code = 0) {
  console.log(JSON.stringify(value, null, 2));
  process.exitCode = code;
}

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

function main() {
  if (!dir) return print({ ok: false, error: 'fake_not_configured', detail: 'set TORRENT_SITES_FAKE_DIR' }, 2);
  appendFileSync(path.join(dir, 'calls.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), args })}\n`);
  if (args[0] === '--sites') return print([{ name: '1337x', label: '1337x' }, { name: 'ext', label: 'ext.to' }]);
  const [site, command] = args;
  const origin = flag('--origin') ?? (site === 'ext' ? 'https://ext.to' : 'https://1337x.la');
  const modeFile = path.join(dir, 'mode');
  const mode = (existsSync(modeFile) ? readFileSync(modeFile, 'utf8').trim() : '') || 'rows';
  if (mode === 'bot_check') return print({ ok: false, site, origin, error: 'bot_check', detail: 'fake: the page stayed on "Just a moment..."' }, 1);
  if (mode === 'no_chrome') return print({ ok: false, site, origin, error: 'no_chrome', detail: 'fake: chrome.exe was not found' }, 1);
  const release = fixtureFile && existsSync(fixtureFile) ? { ...DEFAULT_RELEASE, ...JSON.parse(readFileSync(fixtureFile, 'utf8')) } : DEFAULT_RELEASE;
  const pageUrl = `${origin}/torrent/1/fixture/`;
  if (command === 'search') {
    const title = flag('--title');
    const year = flag('--year');
    const name = title ? `${title.replace(/[^A-Za-z0-9]+/g, '.').replace(/^\.|\.$/g, '')}${year ? `.${year}` : ''}.1080p.WEB-DL.x264-NOTESD` : release.name;
    const rows = mode === 'rows' && site === '1337x' ? [{ name, page_url: pageUrl, seeds: 42, leeches: 3, size_bytes: release.size_bytes }] : [];
    return print({ ok: true, site, origin, url: `${origin}/category-search/fixture/Movies/1/`, rows, others: 0 });
  }
  if (command === 'magnets') {
    const originAt = args.indexOf('--origin');
    const urls = args.filter((arg, i) => /^https?:\/\//.test(arg) && i !== originAt + 1);
    return print({
      ok: true,
      site,
      origin,
      magnets: urls.map((url) =>
        url === pageUrl
          ? { page_url: url, info_hash: release.info_hash, trackers: release.trackers ?? [], magnet: `magnet:?xt=urn:btih:${release.info_hash}`, error: null }
          : { page_url: url, info_hash: null, trackers: [], magnet: null, error: 'fake: not the fixture page' },
      ),
    });
  }
  return print({ ok: false, site, origin, error: 'usage', detail: `fake: unknown command ${command ?? ''}` }, 2);
}

main();
```
**Code (`verify.sh`, inside `if [ "$direct" = 1 ]; then` of the `up` block, after `mkdir -p "$dir/direct"`):**
```sh
    # The torrent sites script's stand-in keeps its mode and calls here (tests/fixtures/direct-stream/fake-torrent-sites.mjs).
    mkdir -p "$dir/torrent-sites"
```
**Code (`verify.sh`, inside `env+=(` of the `if [ "$direct" = 1 ]` env block, after `"DIRECT_STREAM_FAKE_DIR=$dir/direct"`):**
```sh
      # Never the real torrent sites script: it drives the owner's streaming Chrome on Windows.
      "NOTESD_TORRENT_SITES_CLI=$root/tests/fixtures/direct-stream/fake-torrent-sites.mjs"
      "TORRENT_SITES_FAKE_DIR=$dir/torrent-sites"
      "TORRENT_SITES_FIXTURE=$dir/torrent/fixture.json"
```
**Code (`verify.sh` `down`, after the `direct/calls.jsonl` copy line):**
```sh
  if [ -f "$dir/torrent-sites/calls.jsonl" ]; then cp "$dir/torrent-sites/calls.jsonl" "$dir/evidence/torrent-sites-calls.jsonl"; fi
```
**Code (`SKILL.md`, a new bullet at the end of `## Gotchas`):**
```markdown
- Never give a throwaway daemon the real `claude/streaming/torrent/cli.mjs` (1337x and ext.to): it opens a
  tab in the owner's streaming Chrome. `up --direct-stream` points `NOTESD_TORRENT_SITES_CLI` at
  `tests/fixtures/direct-stream/fake-torrent-sites.mjs`; `<run>/torrent-sites/mode` picks its answer (`rows`,
  `empty`, `bot_check`, `no_chrome`) and its calls are kept as `evidence/torrent-sites-calls.jsonl`.
```
**Impact:** every `--direct-stream` run gets the fake. Runs without direct streaming are unchanged.

### Step 15: Docs and the feature map
**Files:** `docs/guide/reference/configuration.md`, `docs/guide/streaming.md`,
`.claude/skills/verify-notesd/features/direct-streaming.md`
**Change:** three settings rows, a guide subsection, a code-map row and a feature bullet. No route
or MCP tool changes, so `docs:gen` is not needed.
**Code (`configuration.md`, three rows after the `NOTESD_TORRENT_*` rows phase 1 adds to the direct
streaming table; if phase 1 put them elsewhere, after `NOTESD_ANIME_MAP_URL`, line 139):**
```markdown
| `NOTESD_TORRENT_1337X_ORIGIN` | `https://1337x.la` | The address of 1337x, which the torrent finder asks through the streaming Chrome when the JSON indexes have nothing usable. Scheme and host only. `off`: 1337x is never asked. See [streaming.md](../streaming.md). |
| `NOTESD_TORRENT_EXT_ORIGIN` | `https://ext.to` | The address of ext.to, asked the same way and at the same time. Scheme and host only. `off`: ext.to is never asked. |
| `NOTESD_TORRENT_SITES_CLI` | `claude/streaming/torrent/cli.mjs` in this checkout | Absolute path of the torrent sites script the daemon runs as `node <path>`. `verify.sh up --direct-stream` points it at a fake; a relative path is rejected. |
```
**Code (`streaming.md`, a subsection at the end of the "Torrents" section phase 3 adds. Its heading
is one level below that section's):**
```markdown
### When the indexes have nothing: 1337x and ext.to

When every JSON index answers nothing usable for a title, the finder asks two torrent sites, 1337x
and ext.to, side by side. Their releases go through the same filter and ranking as the indexes'.
Each site is one more attempt in the play's answer (`Index: 1337x`, `Index: ext`), and a site that
fails never fails the play.

- **Only through the streaming Chrome**, in a tab out of sight. `claude/streaming/torrent/tab.ps1`
  opens the site's tab in the background, or starts that Chrome minimized on the site, so nothing
  comes to the front and a film on screen stays where it is. No other client talks to these sites.
- **1337x** is asked with the title's words. Its search lists a row when any one word matches, so
  small words such as "the" are left out. It searches Movies or TV and reads the first two result
  pages. A row counts only when its release name is the title, by the same exact-title rule as the
  streaming sites, and names the asked year if it names a year at all.
- **ext.to** is asked by the title's IMDb id, most seeds first, with `S02E03` for an episode.
  Cloudflare answers a script's request with a check, so the tab goes to the search page itself, as
  a person would.
- **Magnet links** come from the release pages of the five best-seeded rows that are seeded and
  are not a dub, a cinema copy or 3D. On 1337x the page carries the link. On ext.to the page
  gives it through its own "Copy magnet link" request.
- **About 40 seconds** for both. A bot check is the attempt's outcome `bot_check` and is never
  clicked through. A machine without the Windows Chrome answers `error` with `no_chrome`.
- `NOTESD_TORRENT_1337X_ORIGIN` and `NOTESD_TORRENT_EXT_ORIGIN` move a site to another address, or
  leave it out with `off`.

To see what a site lists, by hand:

    node claude/streaming/torrent/cli.mjs 1337x sintel 2010
    node claude/streaming/torrent/cli.mjs ext sintel 2010 --imdb tt1727587
```
**Code (`streaming.md`, a row in the "Where the code is" table, after the `claude/streaming/direct/` row, line 1118):**
```markdown
| `claude/streaming/torrent/`, `src/directStream/torrent/find-sites.ts` | 1337x and ext.to for the torrent finder: `cli.mjs`, one module per site, `tab.ps1` (a tab in the background); the finder's index per site |
```
**Code (`features/direct-streaming.md`, a bullet at the end of `## Sub-features`, after the torrent bullets of phases 1 and 3):**
```markdown
- Torrent fallback sites: when the JSON torrent indexes answer nothing usable, 1337x and ext.to are
  asked through the streaming Chrome (`claude/streaming/torrent/cli.mjs`, a background tab), side by
  side within about 40 s. Their rows pass the same release filter and ranking, and each site is an
  `Index: 1337x` / `Index: ext` attempt (`bot_check`, `error` naming `no_chrome`, `empty`, or
  candidates). Not asked at all when an index had a usable candidate. Under `up --direct-stream` the
  script is a fake (`<run>/torrent-sites/mode`: `rows`, `empty`, `bot_check`, `no_chrome`; calls in
  `evidence/torrent-sites-calls.jsonl`). Proven by
  `npx vitest run tests/unit/scripts/torrentSites.test.ts tests/unit/directStream/torrent/findSites.test.ts tests/unit/config.torrentSites.test.ts`,
  by a `provider: "torrent"` play with the fake index set to `empty` and the fake sites set to `rows`
  (the session's torrent comes from `1337x`) and to `bot_check` (both sites `bot_check`, no
  `magnets` call), and live by `node claude/streaming/torrent/cli.mjs 1337x sintel 2010` (releases with
  seeds and 40-hex `info_hash`).
```
**Impact:** `npm run docs:check` stays green. The three settings are documented, and the scanned
`claude/streaming/torrent/*.mjs` files read no environment variable.

## Principles applied

- Laziness protocol: reuse rather than build new. `runJsonScript` runs the script, `evaluateInChrome` and `cdp.ps1` evaluate in the tab, and `pathOnSite`, `normalizeName` and `parseQuery` come from `claude/streaming/match.mjs`. The only new Windows piece is the ~60-line `tab.ps1`, which is needed because `cdp.ps1` (not ours to change) opens a missing tab in front. The deadline is a constant, not a setting.
- Boundary discipline: a magnet is parsed into a checked 40-hex hash in one place (`match.mjs parseMagnet`, in the CLI). The daemon validates the script's JSON once with zod in `find-sites.ts` and trusts it after that. The site addresses are validated once in `parseTorrentSites`. `magnets` accepts only release-page paths on the configured origin.
- Make illegal states unrepresentable: `off` is `null` in `origins`, so a switched-off site cannot be built into an index. `TORRENT_SITES` is typed `satisfies keyof TorrentSitesConfig['origins']`, so the daemon's list cannot name a site the settings lack.
- Subtract / one source of truth: the five rows worth a release page are chosen with phase 2's `parseRelease`. This phase does not copy its dub, CAM or 3D rules, and `findCandidates` still applies the full filter and ranking.
- Encode lessons in structure: a test compares the site lists in `claude/streaming/torrent/sites/index.mjs`, `TORRENT_SITES` and `TORRENT_SITE_ORIGIN_DEFAULTS` (the `STREAMING_SITES` precedent). The page readers are tested on pages saved live, so a layout change shows up as a fixture to replace, not as silent empty answers.
- Prove it works: proof runs the real daemon with a fake script and a real lookup by hand against both live sites. The bot-check path is a journey of its own.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` (includes `tests/unit/docs/reference.test.ts`), and on their own `npx vitest run tests/unit/scripts/torrentSites.test.ts tests/unit/directStream/torrent/findSites.test.ts tests/unit/config.torrentSites.test.ts tests/unit/scripts/streamingSites.test.ts tests/unit/mcp.streamingTools.test.ts`
**Proof:**
- Harness: `.claude/skills/verify-notesd`, with `up --direct-stream --torrent` (`--torrent` is phase 1's). J4 is a live run by hand of the real script against both sites in the owner's streaming Chrome, in a background tab. It never touches the live daemon on 7317.
- Feature-map entries: `.claude/skills/verify-notesd/features/direct-streaming.md`
- Journeys (setup for J1–J2: `V=.claude/skills/verify-notesd/scripts/verify.sh; $V up --direct-stream --torrent`, then `RUN=<printed RUN>; D=~/.local/state/notesd-verify/$RUN`. The title is Bad Apples (`movie-990003`, 2025), a film of the fake TMDB; the fake 1337x names its row `Bad.Apples.2025.1080p.WEB-DL.x264-NOTESD` after the asked title. Run J2 before J1, because after J1 the fixture film is on disk and a second play does not ask the finder; R2.9)
  - **J1** · traces R1.7 — `echo empty > $D/torrent/index-mode; echo rows > $D/torrent-sites/mode; $V mcp $RUN direct_stream_play '{"title":"movie-990003","provider":"torrent"}'; jq -c '.args[0:2]' $D/torrent-sites/calls.jsonl` → passes when the play answers a session (no error), its torrent's info hash equals `jq -r .info_hash $D/torrent/fixture.json` and its index is `1337x`, its attempts list `Index: 1337x` with an outcome other than `error`/`bot_check`, and `calls.jsonl` holds `["1337x","search"]`, `["ext","search"]` and `["1337x","magnets"]` and no `["ext","magnets"]`
  - **J2** · traces R1.7 — `echo empty > $D/torrent/index-mode; echo bot_check > $D/torrent-sites/mode; : > $D/torrent-sites/calls.jsonl; $V mcp $RUN direct_stream_play '{"title":"movie-990003","provider":"torrent"}'; jq -c '.args[0:2]' $D/torrent-sites/calls.jsonl` → passes when the play answers an error (no session), its attempts list `Index: 1337x` and `Index: ext` each with outcome `bot_check`, and `calls.jsonl` has exactly two lines, `["1337x","search"]` and `["ext","search"]`, with no `magnets` call (nothing clicked, nothing more asked)
  - **J3** · traces R1.7 — on a fresh run (`$V down $RUN; $V up --direct-stream --torrent`, new `RUN` and `D`): `echo ok > $D/torrent/index-mode; echo rows > $D/torrent-sites/mode; $V mcp $RUN direct_stream_play '{"title":"movie-990003","provider":"torrent"}'; wc -l < $D/torrent-sites/calls.jsonl 2>/dev/null || echo 0` → passes when the play answers a session whose torrent index is not `1337x`/`ext` and the count is `0`: the sites are not asked when an index had a usable candidate (the WHERE clause of R1.7)
  - **J4** · traces R1.7 — `node claude/streaming/torrent/cli.mjs 1337x sintel 2010 | tee /tmp/claude-1000/j4-1337x.json | jq '{ok, n: (.releases|length), hashed: ([.releases[]|select(.info_hash|test("^[0-9a-f]{40}$"))]|length), seeds: [.releases[].seeds]}'` and `node claude/streaming/torrent/cli.mjs ext sintel 2010 --imdb tt1727587 | tee /tmp/claude-1000/j4-ext.json | jq '{ok, error, hashed: ([.releases[]?|select(.info_hash|test("^[0-9a-f]{40}$"))]|length)}'` → passes when 1337x prints `ok: true` and at least one release with numeric `seeds` and a 40-hex `info_hash`. ext.to must print `ok: true` with at least one hashed release, or `ok: false, error: "bot_check"`, its honest answer when Cloudflare holds the tab, and either one is recorded. In both cases no Chrome window comes to the front.
  - **J5** · traces R1.7 — `npx vitest run tests/unit/scripts/torrentSites.test.ts tests/unit/directStream/torrent/findSites.test.ts tests/unit/config.torrentSites.test.ts` → passes when all pass. On the pages saved from the live sites, the readers find 9, 6 and 8 rows, the bot-check page is recognized, the fallback's rows become candidates through `findCandidates`, and CAM, TeleSync and unseeded rows never reach a release page.
- Neighbor check: the play sites must stay apart. `npx vitest run tests/unit/scripts/streamingSites.test.ts tests/unit/mcp.streamingTools.test.ts tests/unit/streaming.test.ts && node claude/streaming/cli.mjs --sites | jq -r '.[].name'` → the tests pass and it prints only `idlix` and `lk21`
- Cost: nothing billed. J4 uses the owner's streaming Chrome in a background tab, two lookups with no play and no sound.
**Exit criteria:** with every JSON index empty, a torrent play takes its candidate from the fake 1337x rows through the same filter and ranking (J1). A bot check from either site is `bot_check` and stops that site (J2). The sites are not asked when an index answered (J3). Live, `cli.mjs 1337x sintel 2010` lists releases with seeds and magnets (J4). `npm run typecheck` and `npm test` pass.

## Handoffs

- **Phase 2 (reconciled):** candidates are built with `candidateFrom(row, site, query)` (phase 2's one place a row becomes a candidate). A fallback index keeps its own `timeoutMs` (40 s here); phase 2's `findCandidates` gives it that limit in the fallback round. The test that `fallback` is **not** asked when a JSON index has a usable candidate is phase 2's; J3 here shows it on the daemon. `ReleaseInfo.cam` for `HQ-CAM`/`HD-TeleSync` and `dubbed` for `DUAL` are phase 2's reading (`findSites.test.ts` asserts it through `pickRows`).
- **Phase 3 (reconciled):** the query carries `title` and `year` (1337x has no IMDb search; without a title it answers `error` `no_title`); `fallback` goes through `buildTorrentSource`'s wiring (Step 13, one line); each `IndexAnswer` is an `Index: <name>` attempt; the fake index's knob is `$dir/torrent/index-mode`.
- **Phase 1:** `up --torrent` writes `$dir/torrent/fixture.json` with `info_hash` and `trackers: []`; the daemon finds the seeder through `NOTESD_TORRENT_PEERS`, so the fake's magnet answer needs nothing more.
- **Phase 6:** renames `parseAnimeMapUrl` (this phase's parsers sit after phase 1's `parseTorrent` instead). Both add a field to `TorrentConfig`, `DEFAULT_TORRENT_CONFIG` and `parseTorrent` (this phase's `sites` goes after phase 6's `subtitleUrl` when both have landed; a merge keeps both lines).
- **Not this phase:** the `/direct-stream` skill, the MCP instructions and the chat prompt (phase 3) need no new words for the fallback, since it runs inside `direct_stream_play`. No drive-by changes were made in `claude/streaming/cli.mjs`, `chrome.mjs` or `cdp.ps1`.

## Rollback

Revert this phase's merge. That removes `claude/streaming/torrent/`, `find-sites.ts`, the fake, the
fixtures, the tests, the three settings rows and the docs, and returns `src/daemon.ts` to the
finder options without `fallback`. Phase 2 treats a missing `fallback` as none, so the finder
answers from the JSON indexes alone. Nothing is written to the database. Without a revert, setting
`NOTESD_TORRENT_1337X_ORIGIN=off` and `NOTESD_TORRENT_EXT_ORIGIN=off` turns the fallback off. The
background tabs it left in the streaming Chrome can be closed like any tab.

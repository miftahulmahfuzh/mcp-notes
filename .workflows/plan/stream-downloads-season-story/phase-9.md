# Phase 9: Guides, pictures, the feature map and the end-to-end proof

**Plan set:** `STREAM_DOWNLOADS_SEASON_STORY_PLAN.md`
**Analysis:** `.workflows/analyze/20261120-213359-K7Q2_code_analyzer.md`
**Satisfies:** R3, R4, R6 — the owner sees a download's bar on the title page, can filter the Cache page to what downloads, and opens a season's story; this phase writes those features down and proves them end to end on the real daemon
**Criteria:** R3.1, R4.2, R6.1
**Depends on:** Phase 5, Phase 8 (and through them 1, 2, 3, 4, 6, 7)
**Difficulty:** NORMAL
**Package:** `docs/guide`, `.claude/skills/verify-notesd`

---

## Goal

After this phase the two guides, `CLAUDE.md` and the configuration reference describe downloads, the
Cache page's Downloading view and the web-written season story as they landed; the streaming guide
shows four new fixture pictures of them; the verify-notesd feature map has entries for them; and one
rerunnable script (`direct-stream/downloads.sh`) drives a throwaway daemon through a real torrent
download of a film and of a season pack, the Cache page's Downloading filter and the season story
pop-up, with evidence kept. No behaviour changes, except the smallest fix for a defect the proof
finds (Step 13).

## Interface Contract

**Deletes:** none.
**Renames:** guide heading `### What a title says: its dialogue` -> `### What a title says: its story` (anchor `#what-a-title-says-its-dialogue` -> `#what-a-title-says-its-story`; every link to it is updated in this phase).
**Creates:**
- `.claude/skills/verify-notesd/scripts/direct-stream/downloads.sh` (stages `story title season cache`)
- `.claude/skills/verify-notesd/scripts/stream/downloads-bars.mjs` (helper for the two bar journeys)
- `.claude/skills/verify-notesd/scripts/stream/downloads-title.steps.mjs` (J1)
- `.claude/skills/verify-notesd/scripts/stream/downloads-season.steps.mjs` (J2)
- `.claude/skills/verify-notesd/scripts/stream/downloads-cache.steps.mjs` (J3)
- `.claude/skills/verify-notesd/scripts/stream/season-story.steps.mjs` (J4)
- harness knob `TORRENT_SEED_KBPS` (environment of `verify.sh up --torrent`, default 200: the loopback seeder's upload cap). A verify harness variable, not a daemon setting: no configuration row.
- pictures `docs/guide/img/streaming/{download-bars,download-menu,cache-downloading,season-story}.png`
- guide section `### Downloading a title` in `docs/guide/streaming.md`
**Signature changes:** `scripts/docs/shots/streaming.mjs`: `export const up = []` -> `['--direct-stream']`; gains `export async function seed`; the default export also takes `fetchJson`.
**Requires (from earlier phases)** — what the proof and the pictures drive. Each name below is what the index's phase sections say; where the landed code chose another, the implementer uses the landed one and fixes the constant at the top of the script or steps file (they are gathered there for that reason):
- Phase 1: `movie_stories (title_id, season, episode, text, sections jsonb, sources jsonb, origin, model, written_at)`, a season's story at `episode = 0`; `sections` items `{episode, name, text, found}`, `sources` items `{url, title, site}`. `stream_torrents.kept_at`.
- Phase 2: `NOTESD_STREAM_DOWNLOADS` (configuration row in place); `via: "torrent"` downloads a 1080p torrent with live seeds, else one below 1080p (never 2160p unasked; the fake index names its releases `720p`); row states `queued|running|paused|done|failed`; codes `no_source`, `no_peers_here`, `dubbed`, `download_failed`, `cancelled`, `torrent_off`, `cloud_off`; one torrent download at a time. The SSID seam is `NOTESD_STREAM_DOWNLOAD_SSID` (unset: read from WARP's status; set: that value, nothing read), with its configuration row, and phase 2 pins it in `verify.sh` (`NOTESD_STREAM_DOWNLOAD_SSID=verify-home`, beside `NOTESD_STREAM_WARP=off`): a throwaway daemon is never on the office network, so this phase adds no SSID line (reconciled).
- Phase 3: a season request makes one row per aired episode not whole here; the fixture pack (S01E01, S01E02) is downloaded from that one torrent.
- Phase 4: `POST /api/stream/downloads {kind, tmdb_id, season?, episode?, via?}` answers 202 (made) or 200 (already queued or whole), `{ok, created, whole, not_aired, downloads}`; `GET /api/stream/downloads[?title=<title key>]` answers `{host, active, downloads: [{id, host, available, title_id, kind, tmdb_id, season, episode, state, via, info_hash, batch, source, source_id, progress, bytes_done, bytes_total, peers, down_kbps, error, detail, created_at, updated_at, finished_at}]}`: without `?title=` no `done` rows; with it the title's `done` rows still on this machine too (the latest per film or episode); `active` from queued, running and paused rows only (reconciled); `DELETE /api/stream/downloads/:id`.
- Phase 5: on `/movies/cache` an icon toggle whose accessible name starts with `Downloading` and which carries `aria-pressed`; in the Downloading view only rows with something downloading, unfolded; on every downloading row a bar with `role="progressbar"` and `aria-valuenow` (0–100) inside that row's own `.cp-row`; the existing `li.cp-title[data-title]`, `li.cp-season[data-season]`, `li.cp-episode[data-episode]` and the list `Titles on disk` kept; `DiskEpisode.downloading` is `{progress, why, state} | null`, `DiskSeason.downloading` and `DiskTitle.downloading` the roll-up `{count, progress, why, state} | null` (`progress` the mean), and `DiskView.downloading` the count (phase 5's names, reconciled). The toggle is named `Downloading · N`; a bar is named `<title> download` (`… S01 download`, `… S01E05 download`).
- Phase 6: `GET /api/movies/:id/story?season=1` answers a stored season story from the store (`cached: true`, `story.sections`, `story.sources`, `story.origin`) with `NOTESD_MOVIES_STORY_MODEL=off`, i.e. `MovieStories` is still built when the model is off (as `daemon.ts:514` does today); per-season `has_story` on the title detail.
- Phase 7 (names pinned by its tests): on the season head (`.mv-season[data-season="1"] .mv-season-head`) a book button named exactly `Narrate the full story of S01`; `StoryModal` is `role="dialog"` named `Story of MobLand S01`; a season's sections are regions named and headed (`<h3>`) `S01E01 · <episode name>`; the line `No published recap was found for this episode.`; sources as links in the region `Sources`.
- Phase 8 (names pinned by its tests): the download bar is `role="progressbar"` named `Download of <name>` with `aria-valuenow` (0–100) — at a film's head inside `.mv-actions`, on the season head inside `.mv-season-head`, on an episode row inside `li[data-episode="S01E01"]`; the hook asks `GET /api/stream/downloads?title=` every 2.5 s while `active` (queued, running or paused) and the page is visible; the caret is named `Choose how to download <name>` and opens a `role="menu"` of the same name; the cancel icon is named `Cancel the download of <name>`.
**Leaves alone (owned by others):** every file under `src/` and `web/src/` (phases 1–8), `drizzle/`, `scripts/docs/httpRoutes.ts`, the generated `docs/guide/reference/{mcp-tools,http-api}.md` (phase 4 and 6 regenerate them), `src/mcp/instructions.ts` and `claude/skills/direct-stream/` (phase 4), `src/chat/prompt.ts` (read: it says nothing of stories, so it is not changed).

## Files

| File | Action | What changes |
|---|---|---|
| `.claude/skills/verify-notesd/scripts/verify.sh:25-27`, `:216-217` | modify | `TORRENT_SEED_KBPS` for the seeder (phase 2 already added the SSID pin after line 261; this phase does not touch it) |
| `.claude/skills/verify-notesd/SKILL.md:62-71` | modify | the knob, one sentence |
| `.claude/skills/verify-notesd/scripts/direct-stream/downloads.sh` | create | J1–J4 driver |
| `.claude/skills/verify-notesd/scripts/stream/downloads-bars.mjs` | create | bar and polling-gap helper |
| `.claude/skills/verify-notesd/scripts/stream/downloads-title.steps.mjs` | create | J1 |
| `.claude/skills/verify-notesd/scripts/stream/downloads-season.steps.mjs` | create | J2 |
| `.claude/skills/verify-notesd/scripts/stream/downloads-cache.steps.mjs` | create | J3 |
| `.claude/skills/verify-notesd/scripts/stream/season-story.steps.mjs` | create | J4 |
| `.claude/skills/verify-notesd/features/direct-streaming.md:343` | modify | new section "Downloads asked for" after "The next episode, fetched ahead" |
| `.claude/skills/verify-notesd/features/movies.md:16-28`, `:44-50` | modify | Cache page's Downloading view; the Download buttons; the season story and the web-first episode story |
| `.claude/skills/verify-notesd/features/README.md:19-20` | modify | the two rows name the new sub-features |
| `scripts/docs/shots/streaming.mjs:15-19`, `:28`, `:218`, `:284` | modify | four fixture pictures |
| `docs/guide/img/streaming/*.png` | create | written by `npm run docs:shots -- streaming` |
| `docs/guide/streaming.md:29`, `:45-54`, `:65-67`, `:1588-1605`, `:1900`, `:2875`, `:2912-2930`, `:2969-2975` | modify | the new section, the story section, rules, code table, proof |
| `docs/guide/movies.md:94`, `:396-404`, `:703`, `:1195`, `:1209`, `:1279-1280`, `:1320` | modify | title page buttons, stories, Cache page, stored tables, off switches, code, proof |
| `docs/guide/reference/configuration.md:103` | modify | `NOTESD_MOVIES_STORY_MODEL` row (only if phase 6 left it saying "from its dialogue") |
| `CLAUDE.md:91`, `:100`, `:101`, `:105`, `:106` | modify | stories web-first; downloads asked, held, kept; `DownloadsRepo` |
| `docs/guide/architecture.md:68-72`, `:95-96` | modify | `stream_downloads`/`DownloadsRepo` in the writer table; `stream_downloads`, `movie_stories`, `kept_at` in the data model (phase 1's handoff) |

## Implementation Steps

Placeholders of the form `[[CHECK: …]]` mark a name only the landed code can give (a log line, a test
path). Resolve every one before committing; Step 14 fails while any is left.

### Step 1: Read what landed

**File:** none written.
**Change:** before writing prose, read the landed names this phase quotes: `src/directStream/downloads/{service,plan,types,repo}.ts`, `src/http/streamDownloadsApi.ts`, `src/mcp/streamCacheTools.ts`, `src/config.ts` (`NOTESD_STREAM_DOWNLOADS` and the SSID seam), `src/movies/{story,webStory}.ts`, `web/src/components/movies/{DownloadButton,CachePage,StoryModal,EpisodeList}.tsx`, `web/src/lib/downloads.ts`, `web/src/moviesApi.ts`, and the test files phases 1–8 added (`git diff --stat origin/main...HEAD -- tests web/src`). Note the accessible names, the route answer shapes and the log lines; they replace the `[[CHECK]]` marks and, where they differ from the names under **Requires**, the constants at the top of Steps 3–7's files.
**Impact:** none.

### Step 2: The harness: a slower seeder, and no real SSID on a throwaway daemon

**File:** `.claude/skills/verify-notesd/scripts/verify.sh:216-217` (seeder start), `:25-27` (usage), `:261` (env block)
**Change:** the loopback seeder's upload cap comes from `TORRENT_SEED_KBPS` (default 200, today's value), so a journey can keep a download running long enough to watch its bar. The downloads' SSID is already pinned by phase 2 (`NOTESD_STREAM_DOWNLOAD_SSID=verify-home` beside `NOTESD_STREAM_WARP=off`), so a throwaway daemon never runs `warp.mjs`/`netsh` to read the machine's real network (CLAUDE.md "Tests"); `downloads.sh` keeps its `INCONCLUSIVE` exit only as a guard should the pin ever be dropped.
**Code:** replace lines 216–217:
```bash
    local seed_kbps="${TORRENT_SEED_KBPS:-200}"
    [[ $seed_kbps =~ ^[1-9][0-9]*$ ]] || die "--torrent: TORRENT_SEED_KBPS=$seed_kbps is not a whole number of kB/s"
    setsid node "$HERE/torrent/seed.mjs" seed --film "$film" --pack "$fixture/Fixture.Show.S01.1080p.WEB-DL.x264-NOTESD" \
      --state "$dir/torrent" --upload-kbps "$seed_kbps" </dev/null >"$dir/torrent/seeder.out" 2>&1 &
```
replace the usage lines 25–27:
```bash
#                                       --torrent (implies --direct-stream) turns torrents on against a loopback
#                                       seeder of a generated film and pack (scripts/torrent/; TORRENT_FIXTURE_FILE=
#                                       <path> seeds that file as the film; TORRENT_SEED_KBPS=<kB/s> caps its upload,
#                                       default 200); without it NOTESD_TORRENT=off is pinned
```
The SSID pin (`NOTESD_STREAM_DOWNLOAD_SSID=verify-home`, after line 261) is phase 2's and is already in the file: nothing to add here.
**Impact:** none on existing journeys: the default cap stays 200 kB/s. `verify.sh restart` re-uses the env file `up` wrote; the seeder is not restarted by it, so the cap holds across a restart.

**File:** `.claude/skills/verify-notesd/SKILL.md:66-67`
**Code:** replace the sentence `TORRENT_FIXTURE_FILE=<path>` … `seeds that file as the film.` with:
```markdown
`TORRENT=<run>/torrent`, where `fixture.json`, `pack.json` and `seeder.jsonl` are. `TORRENT_FIXTURE_FILE=<path>`
seeds that file as the film, and `TORRENT_SEED_KBPS=<kB/s>` caps the seeder's upload (default 200; the downloads
journeys use 20, so a download runs long enough to watch). `scripts/torrent/torrent.sh RUN` drives it; see `features/direct-streaming.md`.
```

### Step 3: The bar helper

**File:** `.claude/skills/verify-notesd/scripts/stream/downloads-bars.mjs` (new)
**Code:**
```js
// downloads-bars.mjs: shared by downloads-title.steps.mjs and downloads-season.steps.mjs
// (stream-downloads-season-story phase 9). Not a steps file: it has no default export.
//
// A download's bar is role="progressbar" with aria-valuenow from 0 to 100 (phases 5 and 8). The page asks
// GET /api/stream/downloads every 2.5 s while something of the title is queued, running or paused and the page is
// visible (phase 8); R3.1 allows at most 3 s between two reads.

/** Records when the page asks GET /api/stream/downloads. Call it before page.goto. */
export function recordAsks(page) {
  const at = []
  page.on('request', (r) => {
    if (r.method() === 'GET' && new URL(r.url()).pathname === '/api/stream/downloads') at.push(Date.now())
  })
  return at
}

/** The bar's value, 0 to 100. */
export async function valueOf(bar, name) {
  const raw = await bar.getAttribute('aria-valuenow')
  const v = Number(raw)
  if (raw === null || !Number.isFinite(v) || v < 0 || v > 100) throw new Error(`the bar on ${name} says aria-valuenow=${raw}`)
  return v
}

/**
 * Watches `bars` ({name: locator}) for watchMs. Every bar must be on the page at the start and still there at the
 * end; each name in `rising` must end higher than it began; and the page must not go longer than maxGapMs without
 * asking GET /api/stream/downloads. Returns {first, last, worst}.
 */
export async function watchBars(page, asks, bars, { rising, watchMs = 15000, maxGapMs = 3000, log }) {
  const first = {}
  for (const [name, bar] of Object.entries(bars)) {
    await bar.waitFor({ state: 'visible', timeout: 30000 })
    first[name] = await valueOf(bar, name)
  }
  const from = Date.now()
  await page.waitForTimeout(watchMs)
  const to = Date.now()
  const last = {}
  for (const [name, bar] of Object.entries(bars)) {
    if (!(await bar.isVisible())) throw new Error(`the bar on ${name} left the page while the download runs`)
    last[name] = await valueOf(bar, name)
  }
  for (const name of rising) {
    if (!(last[name] > first[name])) throw new Error(`the bar on ${name} did not move in ${watchMs} ms: ${first[name]} -> ${last[name]}`)
  }
  const inside = asks.filter((t) => t > from && t <= to)
  const points = [from, ...inside, to]
  let worst = 0
  for (let i = 1; i < points.length; i++) worst = Math.max(worst, points[i] - points[i - 1])
  if (worst > maxGapMs) throw new Error(`the page went ${worst} ms without asking GET /api/stream/downloads (at most ${maxGapMs})`)
  for (const name of Object.keys(bars)) log(`bar on ${name}: ${first[name]} -> ${last[name]}`)
  log(`asked GET /api/stream/downloads ${inside.length} times in ${to - from} ms, longest gap ${worst} ms`)
  return { first, last, worst }
}
```
**Impact:** none (test harness).

### Step 4: J1 and J2 steps (R3.1)

**File:** `.claude/skills/verify-notesd/scripts/stream/downloads-title.steps.mjs` (new)
**Code:**
```js
// downloads-title.steps.mjs: J1 of stream-downloads-season-story phase 9 (R3.1), run by
// `direct-stream/downloads.sh RUN title` once the film's torrent download runs.
// The film's Stream-side title page shows a bar under the Download button at the page's head (.mv-actions), the
// bar rises, and the page reads GET /api/stream/downloads at most 3 s apart while it does.
// Env: TITLE_ID (default movie-467905, the fixture library's "How to Make a Killing").
import { recordAsks, watchBars } from './downloads-bars.mjs'

const TITLE_ID = process.env.TITLE_ID ?? 'movie-467905'
const HEAD_BAR = '.mv-actions [role="progressbar"]'

export default async ({ page, base, shot, log }) => {
  const asks = recordAsks(page)
  await page.goto(`${base}/movies/${TITLE_ID}?side=stream`)
  const bar = page.locator(HEAD_BAR).first()
  const r = await watchBars(page, asks, { 'the title page': bar }, { rising: ['the title page'], log })
  await shot('title-downloading')
  log(`J1 PASS: ${TITLE_ID}'s head bar ${r.first['the title page']} -> ${r.last['the title page']}, read at most ${r.worst} ms apart`)
}
```

**File:** `.claude/skills/verify-notesd/scripts/stream/downloads-season.steps.mjs` (new)
**Code:**
```js
// downloads-season.steps.mjs: J2 of stream-downloads-season-story phase 9 (R3.1), run by
// `direct-stream/downloads.sh RUN season` once MobLand season 1 downloads from the fixture pack.
// On the Stream-side title page the season row and the rows of S01E01 and S01E02 each show a bar; the season's
// bar rises, so does at least one episode's, and the page reads GET /api/stream/downloads at most 3 s apart.
// Env: SERIES_ID (default tv-247718, the fixture library's MobLand).
import { recordAsks, watchBars } from './downloads-bars.mjs'

const SERIES_ID = process.env.SERIES_ID ?? 'tv-247718'
const BAR = '[role="progressbar"]'

export default async ({ page, base, shot, log }) => {
  const asks = recordAsks(page)
  await page.goto(`${base}/movies/${SERIES_ID}?side=stream`)
  const season = page.locator('.mv-season[data-season="1"]')
  await season.waitFor({ timeout: 20000 })
  if ((await season.getAttribute('data-folded')) === 'true') {
    await season.getByRole('button', { name: 'Show the episodes of season 1' }).click()
  }
  const bars = {
    'the season row': season.locator(`.mv-season-head ${BAR}`).first(),
    S01E01: season.locator(`li[data-episode="S01E01"] ${BAR}`).first(),
    S01E02: season.locator(`li[data-episode="S01E02"] ${BAR}`).first(),
  }
  const r = await watchBars(page, asks, bars, { rising: ['the season row'], log })
  if (!(r.last.S01E01 > r.first.S01E01 || r.last.S01E02 > r.first.S01E02)) {
    throw new Error(`neither episode's bar moved: S01E01 ${r.first.S01E01} -> ${r.last.S01E01}, S01E02 ${r.first.S01E02} -> ${r.last.S01E02}`)
  }
  await season.scrollIntoViewIfNeeded()
  await shot('season-downloading')
  log(`J2 PASS: season 1 ${r.first['the season row']} -> ${r.last['the season row']}, bars on S01E01 and S01E02, read at most ${r.worst} ms apart`)
}
```
**Impact:** none (test harness).

### Step 5: J3 steps (R4.2)

**File:** `.claude/skills/verify-notesd/scripts/stream/downloads-cache.steps.mjs` (new)
**Code:**
```js
// downloads-cache.steps.mjs: J3 of stream-downloads-season-story phase 9 (R4.2), run by
// `direct-stream/downloads.sh RUN cache` while MobLand season 1 downloads and the film has a ready cloud cache.
// Default view: both titles. Downloading filter on: the film is gone, MobLand stays, and every episode row listed
// carries a bar (only what downloads now is listed). Filter off again: the film is back.
// Env: FILM_ID (default movie-467905), SERIES_ID (default tv-247718).
const FILM_ID = process.env.FILM_ID ?? 'movie-467905'
const SERIES_ID = process.env.SERIES_ID ?? 'tv-247718'
const FILTER = /^Downloading/

export default async ({ page, base, shot, log }) => {
  await page.goto(`${base}/movies/cache`)
  const list = page.getByRole('list', { name: 'Titles on disk' })
  const film = list.locator(`li.cp-title[data-title="${FILM_ID}"]`)
  const series = list.locator(`li.cp-title[data-title="${SERIES_ID}"]`)
  await film.waitFor({ timeout: 20000 })
  await series.waitFor({ timeout: 20000 })
  await shot('default-view')
  log('default view: the film (on disk, not downloading) and MobLand (downloading) are both listed')

  const filter = page.getByRole('button', { name: FILTER })
  if ((await filter.getAttribute('aria-pressed')) !== 'false') throw new Error('the Downloading filter is on before it was clicked')
  await filter.click()
  await film.waitFor({ state: 'detached', timeout: 10000 })
  if ((await filter.getAttribute('aria-pressed')) !== 'true') throw new Error('the Downloading filter does not say it is on')
  await series.waitFor()
  const titles = await list.locator('li.cp-title').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-title')))
  if (titles.length !== 1 || titles[0] !== SERIES_ID) throw new Error(`the Downloading view lists ${JSON.stringify(titles)}, not only ${SERIES_ID}`)
  const season = series.locator('li.cp-season[data-season="1"]')
  await season.waitFor({ timeout: 10000 })
  const episodes = season.locator('li.cp-episode')
  await episodes.first().waitFor({ timeout: 10000 })
  const n = await episodes.count()
  for (let i = 0; i < n; i++) {
    const row = episodes.nth(i)
    if ((await row.locator(':scope > .cp-row [role="progressbar"]').count()) === 0) {
      throw new Error(`episode ${await row.getAttribute('data-episode')} is listed in the Downloading view with no bar`)
    }
  }
  await shot('downloading-view')
  log(`Downloading view: only ${SERIES_ID}, season 1 unfolded, ${n} episode row(s), each with a bar`)

  await filter.click()
  await film.waitFor({ timeout: 10000 })
  await series.waitFor()
  if ((await filter.getAttribute('aria-pressed')) !== 'false') throw new Error('the Downloading filter still says it is on')
  await shot('default-again')
  log('J3 PASS: the second click is back on the default view, the film listed again')
}
```
**Impact:** none (test harness).

### Step 6: J4 steps (R6.1)

**File:** `.claude/skills/verify-notesd/scripts/stream/season-story.steps.mjs` (new)
**Code:**
```js
// season-story.steps.mjs: J4 of stream-downloads-season-story phase 9 (R6.1), run by
// `direct-stream/downloads.sh RUN story` after it seeded movie_stories with MobLand season 1's story (three
// sections, the third with no recap found, one source). The season row's book icon opens the pop-up with one
// section per episode under its code and name. No model is asked: the run pins NOTESD_MOVIES_STORY_MODEL=off,
// so only a stored story can open.
// Env: SERIES_ID (default tv-247718).
const SERIES_ID = process.env.SERIES_ID ?? 'tv-247718'
const EPISODES = [
  ['S01E01', 'Stick or Twist', 'Harry Da Souza is called in'],
  ['S01E02', 'Eye for an Eye', 'The Harrigans answer the killing'],
  ['S01E03', 'Lie Down with Dogs', null],
]
const NOT_FOUND = 'No published recap was found for this episode.'
const SOURCE = 'https://en.wikipedia.org/wiki/MobLand'

export default async ({ page, base, shot, log }) => {
  await page.goto(`${base}/movies/${SERIES_ID}?side=stream`)
  const head = page.locator('.mv-season[data-season="1"] .mv-season-head')
  await head.waitFor({ timeout: 20000 })
  await head.getByRole('button', { name: /story of S01$/ }).click()
  const dialog = page.getByRole('dialog', { name: /^Story of / })
  await dialog.waitFor({ timeout: 10000 })
  for (const [code, name, text] of EPISODES) {
    await dialog.getByRole('heading', { name: `${code} · ${name}` }).waitFor({ timeout: 10000 })
    if (text !== null) await dialog.getByText(text).first().waitFor()
  }
  const sections = await dialog.getByRole('heading', { name: /^S01E\d\d · / }).count()
  if (sections !== EPISODES.length) throw new Error(`the pop-up has ${sections} episode sections, not ${EPISODES.length}`)
  await dialog.getByText(NOT_FOUND, { exact: true }).waitFor()
  const hrefs = await dialog.getByRole('link').evaluateAll((links) => links.map((a) => a.getAttribute('href')))
  if (!hrefs.includes(SOURCE)) throw new Error(`the pop-up does not link its source; links: ${JSON.stringify(hrefs)}`)
  await shot('season-story')
  log(`J4 PASS: ${sections} sections under S01E01..S01E03, S01E03 says no recap was found, the source is a link`)
}
```
**Impact:** none (test harness).

### Step 7: The driver

**File:** `.claude/skills/verify-notesd/scripts/direct-stream/downloads.sh` (new, `chmod +x`)
**Code:**
```bash
#!/usr/bin/env bash
# downloads.sh RUN [story title season cache ...]: downloads asked for on the title page, the Cache page's
# Downloading view and the season story (stream-downloads-season-story phase 9), on a run started with
#   TORRENT_SEED_KBPS=20 verify.sh up --web --torrent
# The loopback seeder at 20 kB/s keeps the fixture film (about 7 MB) downloading for minutes and the season pack
# (two episodes of about 1.2 MB) for about two, long enough to watch the bars move. Every stage drives the real
# daemon over HTTP and the real page with Playwright (scripts/stream/*.steps.mjs); end states are read over HTTP and
# from the page. Nothing reaches a real index, swarm, model or Chrome: the fake index, the loopback seeder, the fake
# resolver and fixture stream host, and NOTESD_MOVIES_STORY_MODEL=off.
#   story   J4 (R6.1): a seeded story of MobLand S01 answers from the store; the season row's book icon opens it
#   title   J1 (R3.1): the film's torrent download runs; its title page shows the head bar rising; then cancelled
#   season  J2 (R3.1): MobLand season 1 from the pack; the season row and its episode rows show bars rising
#   cache   J3 (R4.2): a ready cloud cache of the film beside the running season; the Downloading filter and back
# The first failed check stops it with `downloads: FAIL at <stage>` (exit 1). A download that answers
# `no_peers_here` (this machine on SSID Employee and no SSID pinned by verify.sh) stops it with
# `downloads: INCONCLUSIVE` (exit 3). No stage named: all four, in this order, once per fresh run.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="$HERE/../verify.sh"
STEPS="$HERE/../stream"
VERIFY_HOME="${VERIFY_HOME:-$HOME/.local/state/notesd-verify}"
RUN=${1:?usage: downloads.sh RUN [story|title|season|cache ...]}
shift
WANTED=("$@")
if [ ${#WANTED[@]} -eq 0 ]; then WANTED=(story title season cache); fi
DIR="$VERIFY_HOME/$RUN"
[ -s "$DIR/torrent/pack.json" ] || { echo "downloads: $RUN was not started with --torrent" >&2; exit 2; }
URL="http://127.0.0.1:$(cat "$DIR/port")"
DIRECT="$DIR/direct"
FILM=467905
SERIES=247718
FILM_SEL=".kind == \"movie\" and .tmdb_id == $FILM"
SEASON_SEL=".kind == \"tv\" and .tmdb_id == $SERIES and .season == 1"
STAGE=start
CODE=""
BODY=""
PASSED=()

stage() { STAGE=$1; echo "== $STAGE"; }
ok() { echo "   ok  $*"; "$V" note "$RUN" "downloads $STAGE: $*"; }
fail() {
  echo "downloads: FAIL at $STAGE: $*" >&2
  "$V" note "$RUN" "downloads FAIL at $STAGE: $*" || true
  exit 1
}
inconclusive() {
  echo "downloads: INCONCLUSIVE at $STAGE: $*" >&2
  "$V" note "$RUN" "downloads INCONCLUSIVE at $STAGE: $*" || true
  exit 3
}
api() {
  local out
  out="$("$V" api "$RUN" "$@" 2>/dev/null)"
  CODE="$(sed -n 's/^< HTTP \([0-9]*\).*/\1/p' <<<"$out" | head -1)"
  BODY="$(sed '1,/^< HTTP /d' <<<"$out")"
}
# rows FILTER: the rows of GET /api/stream/downloads the jq filter keeps, as one JSON array (no evidence per poll).
rows() { curl -sS "$URL/api/stream/downloads" | jq -c "[.downloads[] | select($1)]"; }
# wait_title KEY: waits until the library sync stored the title (GET /api/movies/KEY answers 200), at most 60 s.
wait_title() {
  local i
  for i in $(seq 1 60); do
    [ "$(curl -sS -o /dev/null -w '%{http_code}' "$URL/api/movies/$1")" = 200 ] && return 0
    if [ $((i % 10)) = 1 ]; then curl -sS -o /dev/null -X POST -H "Origin: $URL" "$URL/api/movies/sync" || true; fi
    sleep 1
  done
  fail "$1 is not stored after 60 s of library sync"
}
# wait_running FILTER WHAT: polls until a row the filter keeps is running, at most 120 s.
wait_running() {
  local filter=$1 what=$2 r=""
  for _ in $(seq 1 240); do
    r="$(rows "$filter")"
    if [ "$(jq '[.[] | select(.error == "no_peers_here")] | length' <<<"$r")" != 0 ]; then
      inconclusive "$what answered no_peers_here: this machine is on the office network and verify.sh pins no SSID"
    fi
    if [ "$(jq '[.[] | select(.state == "running")] | length' <<<"$r")" != 0 ]; then echo "$r"; return 0; fi
    if [ "$(jq 'length > 0 and all(.[]; .state == "failed")' <<<"$r")" = true ]; then fail "$what failed: $r"; fi
    sleep 0.5
  done
  fail "$what did not run within 120 s (finished too fast? start the run with TORRENT_SEED_KBPS=20): $r"
}
# cancel FILTER: cancels every queued, running or paused row the filter keeps.
cancel() {
  local id
  for id in $(rows "$1" | jq -r '.[] | select(.state == "queued" or .state == "running" or .state == "paused") | .id'); do
    api DELETE "/api/stream/downloads/$id"
    case "$CODE" in 200|202|204) ;; *) fail "DELETE /api/stream/downloads/$id answered HTTP $CODE: $BODY" ;; esac
  done
}

stage_story() {
  stage story
  wait_title "tv-$SERIES"
  "$V" exec "$RUN" "delete from movie_stories where title_id = 'tv-$SERIES' and season = 1 and episode = 0" >/dev/null
  "$V" exec "$RUN" "insert into movie_stories (title_id, season, episode, text, sections, sources, origin, model, written_at) values (
    'tv-$SERIES', 1, 0, 'Season 1 of MobLand, from the recaps of a verify fixture.',
    '[{\"episode\":1,\"name\":\"Stick or Twist\",\"text\":\"Harry Da Souza is called in when a London crime family loses a son.\",\"found\":true},
      {\"episode\":2,\"name\":\"Eye for an Eye\",\"text\":\"The Harrigans answer the killing and Harry is caught between both sides.\",\"found\":true},
      {\"episode\":3,\"name\":\"Lie Down with Dogs\",\"text\":\"\",\"found\":false}]'::jsonb,
    '[{\"url\":\"https://en.wikipedia.org/wiki/MobLand\",\"title\":\"MobLand - Wikipedia\",\"site\":\"Wikipedia\"}]'::jsonb,
    'web', 'verify-fixture', now())" >/dev/null
  api GET "/api/movies/tv-$SERIES/story?season=1"
  [ "$CODE" = 200 ] || fail "GET the season story answered HTTP $CODE: $BODY"
  [ "$(jq '.story.sections | length' <<<"$BODY")" = 3 ] || fail "the season story does not answer its three sections: $BODY"
  [ "$(jq -r .cached <<<"$BODY")" = true ] || fail "the season story was not answered from the store: $BODY"
  ok "the stored story of MobLand S01 answers three sections from the store (the story model is off on this run)"
  SERIES_ID="tv-$SERIES" "$V" ui "$RUN" "$STEPS/season-story.steps.mjs" || fail "season-story.steps.mjs failed (see the evidence)"
  ok "the season row's story button opens the pop-up with one section per episode"
  PASSED+=(story)
}

stage_title() {
  stage title
  wait_title "movie-$FILM"
  api POST /api/stream/downloads "{\"kind\":\"movie\",\"tmdb_id\":$FILM,\"via\":\"torrent\"}"
  case "$CODE" in 200|202) ;; *) fail "POST /api/stream/downloads for the film answered HTTP $CODE: $BODY" ;; esac
  wait_running "$FILM_SEL" "the film's download" >/dev/null
  ok "the film's torrent download runs"
  TITLE_ID="movie-$FILM" "$V" ui "$RUN" "$STEPS/downloads-title.steps.mjs" || fail "downloads-title.steps.mjs failed (see the evidence)"
  ok "the film's title page shows its head bar rising, read at most 3 s apart"
  cancel "$FILM_SEL"
  [ "$(rows "$FILM_SEL" | jq '[.[] | select(.state == "queued" or .state == "running" or .state == "paused")] | length')" = 0 ] \
    || fail "the film still downloads after DELETE: $(rows "$FILM_SEL")"
  ok "the film's download is cancelled, so the seeder serves the season next"
  PASSED+=(title)
}

stage_season() {
  stage season
  wait_title "tv-$SERIES"
  cancel "$FILM_SEL"
  api POST /api/stream/downloads "{\"kind\":\"tv\",\"tmdb_id\":$SERIES,\"season\":1,\"via\":\"torrent\"}"
  case "$CODE" in 200|202) ;; *) fail "POST /api/stream/downloads for season 1 answered HTTP $CODE: $BODY" ;; esac
  local r
  r="$(wait_running "$SEASON_SEL" "MobLand season 1")"
  [ "$(jq '[.[] | .episode] | (index(1) != null) and (index(2) != null)' <<<"$r")" = true ] \
    || fail "season 1's rows do not hold S01E01 and S01E02: $r"
  ok "MobLand season 1 downloads: $(jq -c '[.[] | {episode, state}]' <<<"$r")"
  SERIES_ID="tv-$SERIES" "$V" ui "$RUN" "$STEPS/downloads-season.steps.mjs" || fail "downloads-season.steps.mjs failed (see the evidence)"
  ok "the season row and the rows of S01E01 and S01E02 show bars, read at most 3 s apart"
  PASSED+=(season)
}

stage_cache() {
  stage cache
  wait_title "movie-$FILM"
  wait_title "tv-$SERIES"
  # On disk and not downloading: a ready cloud cache of the film (the fake resolver and the fixture stream host).
  printf 'hls\n' >"$DIRECT/mode"
  api POST /api/stream/cache "{\"kind\":\"movie\",\"tmdb_id\":$FILM}"
  case "$CODE" in 200|202) ;; *) fail "POST /api/stream/cache for the film answered HTTP $CODE: $BODY" ;; esac
  local id state="" i
  id="$(jq -r .cache.id <<<"$BODY")"
  for i in $(seq 1 360); do
    state="$(curl -sS "$URL/api/stream/cache/$id" | jq -r .state)"
    [ "$state" = ready ] && break
    [ "$state" = failed ] && fail "the film's cloud cache failed: $(curl -sS "$URL/api/stream/cache/$id")"
    sleep 0.25
  done
  [ "$state" = ready ] || fail "the film's cloud cache is $state after 90 s"
  ok "the film has a ready cloud cache ($id): on disk, downloading nothing"
  # Downloading: season 1 (the season stage's, or asked for again here: 200 when it already is).
  cancel "$FILM_SEL"
  api POST /api/stream/downloads "{\"kind\":\"tv\",\"tmdb_id\":$SERIES,\"season\":1,\"via\":\"torrent\"}"
  case "$CODE" in 200|202) ;; *) fail "POST /api/stream/downloads for season 1 answered HTTP $CODE: $BODY" ;; esac
  wait_running "$SEASON_SEL" "MobLand season 1" >/dev/null
  ok "MobLand season 1 still downloads"
  FILM_ID="movie-$FILM" SERIES_ID="tv-$SERIES" "$V" ui "$RUN" "$STEPS/downloads-cache.steps.mjs" \
    || fail "downloads-cache.steps.mjs failed (see the evidence)"
  ok "the Downloading filter lists only MobLand's downloading rows, and a second click brings the film back"
  PASSED+=(cache)
}

for s in "${WANTED[@]}"; do
  case "$s" in
    story) stage_story ;;
    title) stage_title ;;
    season) stage_season ;;
    cache) stage_cache ;;
    *) echo "downloads: unknown stage $s (story, title, season, cache)" >&2; exit 2 ;;
  esac
done
echo "downloads: PASS (${PASSED[*]})"
"$V" note "$RUN" "downloads: PASS (${PASSED[*]})"
```
**Impact:** none (test harness). The SQL in `stage_story` names phase 1's columns; if they landed under other names, fix this one statement.

### Step 8: The feature map

**File:** `.claude/skills/verify-notesd/features/direct-streaming.md:343` (after the last line of "## The next episode, fetched ahead", before "## /report-stream-bug")
**Code:** insert:
```markdown

## Downloads asked for (the title page's Download buttons, `direct_stream_cache` with a torrent)
- `POST /api/stream/downloads` (same-origin; the Download button on a Stream-side title page, its season rows and
  its episode rows; `direct_stream_cache` `action: "start"` with `provider: "torrent"`) queues a film, a season (every
  aired episode not whole here, one row each under one batch) or an episode, and answers at once (202 with the rows,
  200 when already queued or whole). With no source named: a 1080p torrent with live seeders, else a cloud cache at
  1080p or lower, else a torrent below 1080p; a named kind is that kind only. On SSID `Employee` a download with no
  source named is cloud only and a torrent asked for fails `no_peers_here`; WARP is never switched. One torrent
  download at a time, paused while a torrent plays on screen, carried on after a restart. A finished torrent download
  is kept (`stream_torrents.kept_at`) through the age and budget prunes, holds its remux, subtitle and seek previews,
  and plays from disk with no index and no swarm. `GET /api/stream/downloads[?title=<title key>]` answers
  `{host, active, downloads}` (queued, running, paused and failed rows of this host with progress 0..1, bytes and
  error); `DELETE /api/stream/downloads/:id` cancels one. `NOTESD_STREAM_DOWNLOADS=off` starts nothing.
- On the title page: a bar (`role="progressbar"`) under the head's Download button of a film, on each season row and on
  each episode row, read again every 2.5 s while `active` and the page is visible, and not at all otherwise. On the
  Cache page: a bar and a reason (`asked`, `ahead`, `pause`) on every downloading row, and the Downloading filter
  (see `features/movies.md`, Cache page).
- Logic: `npx vitest run tests/unit/directStream/downloads tests/unit/directStream/torrent/keptFetch.test.ts tests/unit/directStream/torrent/keptPrune.test.ts tests/unit/directStream/torrent/seasonPack.test.ts tests/unit/directStream/downloadsRoutes.test.ts tests/unit/mcp.streamCacheTools.test.ts web/src/components/movies/DownloadButton.test.tsx web/src/lib/downloads.test.tsx`;
  `npm run test:int -- tests/integration/streamDownloads.routes.int.test.ts tests/integration/streamDownloads.engine.int.test.ts tests/integration/directStream.seasonDownloads.int.test.ts`.
- Throwaway daemon, no model and no real swarm: `TORRENT_SEED_KBPS=20 $V up --web --torrent` (the loopback seeder at
  20 kB/s keeps a download running long enough to watch), then
  `.claude/skills/verify-notesd/scripts/direct-stream/downloads.sh RUN` (stages `story title season cache`, in order,
  once per fresh run, about five minutes) ends with `downloads: PASS (story title season cache)`:

  | Stage | What it proves |
  | --- | --- |
  | story | a season story seeded into `movie_stories` answers `GET /api/movies/tv-247718/story?season=1` from the store with the model off; `season-story.steps.mjs`: the season row's book icon opens one section per episode (`S01E01 · Stick or Twist` …), S01E03 says no recap was found, the source is a link |
  | title | `POST /api/stream/downloads` the fixture film with `via: "torrent"`; `downloads-title.steps.mjs`: the head bar on `/movies/movie-467905?side=stream` rises over 15 s and the page asks `GET /api/stream/downloads` at most 3 s apart; `DELETE` cancels it |
  | season | `POST` MobLand season 1; rows for S01E01 and S01E02 run from the pack; `downloads-season.steps.mjs`: bars on the season row and both episode rows, the season's rising, asked at most 3 s apart |
  | cache | a ready cloud cache of the film beside the running season; `downloads-cache.steps.mjs`: both titles in the default view, only MobLand (every episode row with a bar) under the Downloading filter, both again on the second click |

  A stage that finds a download answering `no_peers_here` ends `downloads: INCONCLUSIVE` (exit 3): the run read the
  office network's SSID, which `verify.sh` pins (`NOTESD_STREAM_DOWNLOAD_SSID=verify-home`), so it means the pin was lost.
  Pictures of the same screens with fixed numbers: `npm run docs:shots -- streaming`.
```

**File:** `.claude/skills/verify-notesd/features/movies.md:16-28` (the "Cache page" sub-feature)
**Code:** append to the end of that bullet (after `... left pending by the restart`).`):
```markdown
  What downloads now is listed with what is on disk (a queued download with nothing on disk yet has a 0 B row),
  each downloading row with a bar (`role="progressbar"`) and why it downloads (`asked`, `ahead`, `pause`); while
  anything downloads the page reads every 3 s instead of 15 s. The Downloading filter (an icon beside the bulk
  buttons, its count beside it, `aria-pressed`) lists only the titles, seasons and episodes downloading now,
  unfolded; a second click goes back. Proof: `web/src/components/movies/CachePage.test.tsx`,
  `tests/unit/directStream/cacheShelf.test.ts`; on a `TORRENT_SEED_KBPS=20 $V up --web --torrent` run,
  `direct-stream/downloads.sh RUN season cache` (see `features/direct-streaming.md`, "Downloads asked for").
- Download buttons (Stream side, direct streaming on): an icon on a film's page beside Play, on each season row
  and on each episode row (none at a series' head) queues the film, the season's aired episodes or the episode
  (`POST /api/stream/downloads`); its caret opens "Choose how to download <name>" (Best torrent, Cloud, Pick a
  torrent… which opens `TorrentsModal` with a download action per row; no pick row on a season). A bar under the
  button while queued or downloading; filled when on this machine; failed says why. Proof:
  `web/src/components/movies/DownloadButton.test.tsx web/src/lib/downloads.test.tsx`; on a throwaway run,
  `direct-stream/downloads.sh RUN title season`.
```

**File:** `.claude/skills/verify-notesd/features/movies.md:44-50`
**Change:** replace the story sentences as phase 1 leaves them (phase 1 Step 14 changed the seeding hint), from `The book icon of an episode` through ``seed a `movie_stories` row (origin `dialogue`) through `$V exec` and open it on the page.`` with:
```markdown
The book icon of an episode
  opens its story, written once by Claude from published recaps found with WebSearch (the episode's dialogue only
  when no recap covers it) and kept in `movie_stories`; the book icon of a season row ("Narrate the full story of
  S01") opens the season's story, one section per episode, an episode no recap covers saying so, its sources as
  links (`POST /api/movies/:id/story` with `{season}` alone). Proof: `npx vitest run tests/unit/movies/story.test.ts
  tests/unit/movies/webStory.test.ts web/src/components/movies/StoryModal.test.tsx web/src/components/movies/EpisodeList.test.tsx`,
  `npm run test:int -- tests/integration/movies.api.int.test.ts` ("the story of an episode"). A throwaway daemon
  never writes one (`NOTESD_MOVIES_STORY_MODEL=off` is pinned): seed a `movie_stories` row through `$V exec` and
  open it on the page, as `direct-stream/downloads.sh RUN story` does.
```

**File:** `.claude/skills/verify-notesd/features/README.md:19-20`
**Code:** replace the two rows:
```markdown
| Movies: library sync, TMDB metadata, Play/Resume in VLC with progress, deleted vs watched, unmatched list, the Stream side (titles verified to stream here), the Download buttons, the Cache page and its Downloading view, episode and season stories, `movies_*` tools | [movies.md](movies.md) | background sync (`up --movies`), API, MCP, fake VLC, wall `/movies` |
| Direct streaming: provider registry and health, play, sessions, the stream pass-through (`/api/stream/*`), the daily provider canary, torrent downloads and their file route (`--torrent`), downloads asked for (`/api/stream/downloads`), seek previews on the player's timeline | [direct-streaming.md](direct-streaming.md) | API, fake resolver and fixture stream host (`up --direct-stream`), database, loopback torrent seeder (`up --torrent`) |
```
**Impact:** the feature map describes the new behaviour; `features/README.md` keeps its four-section rule per file.

### Step 9: The streaming guide's pictures

**File:** `scripts/docs/shots/streaming.mjs`
**Change:** the run gains `--direct-stream` (the fake library and TMDB, so a title page and the Cache page render; the player pictures still answer their session and torrent routes in Playwright, unchanged); a `seed` stores MobLand's season story; four pictures follow the player pictures, with `GET /api/stream/downloads` and `GET /api/stream/disk` answered in Playwright (fixed numbers, no swarm).
**Code:** replace the header list lines 15–19 with:
```js
//   player.png             a cloud stream: the title, the English subtitle the page draws, the controls
//   player.gif             the quality menu, the subtitle delay key, a seek
//   player-preview.png     the pointer on the timeline: the frame of that time from the stream's own preview track
//   player-torrent.png     a torrent session: the magnet, peers and speed beside the title, the bar of what is on disk
//   player-fetching.png    a seek past what is on disk: "Fetching this part from peers"
//
// Downloads and the season story (stream-downloads-season-story), on the fake library and TMDB of --direct-stream:
// GET /api/stream/downloads and GET /api/stream/disk are answered here in the daemon's shapes, so a season is seen
// downloading with no swarm; the story is a row seed() puts in movie_stories, read like any stored story (no model).
//   download-bars.png      MobLand on the Stream side: season 1 downloading, E01 and E02 running, E03 queued
//   download-menu.png      the season row's caret: "Choose how to download MobLand"
//   season-story.png       the season's story pop-up: a section per episode, one with no recap found, the source
//   cache-downloading.png  the Cache page's Downloading view: the bars and why each row downloads
```
replace line 28 `export const up = [];` with:
```js
export const up = ['--direct-stream'];

const SERIES_KEY = 'tv-247718'; // MobLand in the fixture library
const FILM_KEY = 'movie-467905'; // How to Make a Killing in the fixture library
const STORY_SQL = `delete from movie_stories where title_id = '${SERIES_KEY}' and season = 1 and episode = 0;
insert into movie_stories (title_id, season, episode, text, sections, sources, origin, model, written_at) values (
  '${SERIES_KEY}', 1, 0, 'Season 1 of MobLand.',
  '[{"episode":1,"name":"Stick or Twist","text":"Harry Da Souza, the Harrigans'' fixer, is called in when a London crime family loses a son, and the night ends with a body nobody can explain.","found":true},
    {"episode":2,"name":"Eye for an Eye","text":"Conrad answers the killing with one of his own, and Harry is sent to keep the Stevensons from striking back before the deal is done.","found":true},
    {"episode":3,"name":"Lie Down with Dogs","text":"","found":false}]'::jsonb,
  '[{"url":"https://en.wikipedia.org/wiki/MobLand","title":"MobLand","site":"Wikipedia"},{"url":"https://mobland.fandom.com/wiki/Season_1","title":"Season 1","site":"MobLand Wiki"}]'::jsonb,
  'web', 'sonnet', now())`;

/** Waits for the library sync to store MobLand, then keeps a season story for it (as the web writer would). */
export async function seed({ v, fetchJson }) {
  for (let i = 0; ; i++) {
    const stored = await fetchJson('GET', '/api/movies/' + SERIES_KEY).then(() => true, () => false);
    if (stored) break;
    if (i >= 60) throw new Error('streaming shots: the library sync never stored MobLand');
    if (i % 10 === 0) await fetchJson('POST', '/api/movies/sync').catch(() => null);
    await new Promise((r) => setTimeout(r, 1000));
  }
  await v('exec', STORY_SQL);
}

/** One row of GET /api/stream/downloads for an episode of MobLand's season 1, as phase 4 answers it. */
function downloadRow(episode, state, progress, total) {
  return {
    id: '00000000-0000-4000-8000-00000000000' + episode,
    title_id: SERIES_KEY,
    kind: 'tv',
    tmdb_id: 247718,
    season: 1,
    episode,
    state,
    via: 'auto',
    source: state === 'queued' ? null : 'torrent',
    progress,
    bytes_done: Math.round(total * progress),
    bytes_total: total,
    peers: state === 'running' ? 27 : 0,
    down_kbps: state === 'running' ? 4800 : 0,
    error: null,
    batch: '00000000-0000-4000-8000-0000000000b1',
  };
}

const DOWNLOADS = [downloadRow(1, 'running', 0.71, 1_480_000_000), downloadRow(2, 'running', 0.34, 1_390_000_000), downloadRow(3, 'queued', 0, 1_420_000_000)];

/** GET /api/stream/disk as phase 5 answers it: MobLand's season 1 asked for, and a film a pause is caching. */
function diskView(series, film) {
  const episode = (n, name, bytes, progress, state) => ({
    season: 1,
    episode: n,
    movie_id: null,
    name,
    bytes,
    kinds: ['torrent'],
    watched: false,
    playing: false,
    in_use: true,
    downloading: { progress, why: 'asked', state },
  });
  const episodes = [episode(1, 'Stick or Twist', 1_050_000_000, 0.71, 'running'), episode(2, 'Eye for an Eye', 473_000_000, 0.34, 'running'), episode(3, 'Lie Down with Dogs', 0, 0, 'queued')];
  const seasonBytes = episodes.reduce((n, e) => n + e.bytes, 0);
  const seasonProgress = (0.71 + 0.34 + 0) / 3;
  const mobland = {
    title_id: SERIES_KEY,
    movie_id: series.movie_id ?? null,
    kind: 'tv',
    tmdb_id: 247718,
    title: 'MobLand',
    year: 2025,
    poster_url: series.poster_url ?? null,
    stored: true,
    bytes: seasonBytes,
    torrent_bytes: seasonBytes,
    cloud_bytes: 0,
    kinds: ['torrent'],
    watched: false,
    not_interested: false,
    playing: false,
    in_use: true,
    shared_bytes: 0,
    downloading: null,
    downloading_count: 3,
    downloading_progress: seasonProgress,
    seasons: [{ season: 1, bytes: seasonBytes, shared_bytes: 0, kinds: ['torrent'], watched: false, playing: false, in_use: true, episodes, downloading_count: 3, downloading_progress: seasonProgress }],
  };
  const paused = {
    title_id: FILM_KEY,
    movie_id: film.movie_id ?? null,
    kind: 'movie',
    tmdb_id: 467905,
    title: 'How to Make a Killing',
    year: 2026,
    poster_url: film.poster_url ?? null,
    stored: true,
    bytes: 612_000_000,
    torrent_bytes: 0,
    cloud_bytes: 612_000_000,
    kinds: ['cloud'],
    watched: false,
    not_interested: false,
    playing: false,
    in_use: true,
    shared_bytes: 0,
    downloading: { progress: 0.48, why: 'pause', state: 'running' },
    downloading_count: 1,
    downloading_progress: 0.48,
    seasons: [],
  };
  return {
    host: 'verify',
    total_bytes: mobland.bytes + paused.bytes,
    torrent_bytes: mobland.bytes,
    cloud_bytes: paused.bytes,
    unnamed_bytes: 0,
    budget_bytes: 40 * 1024 ** 3,
    titles: [mobland, paused],
    bulk: { watched: { bytes: 0, titles: 0 }, not_interested: { bytes: 0, titles: 0 } },
    pending: [],
    undo_ms: 10_000,
    downloading: 4,
  };
}
```
replace line 218 `export default async ({ page, base, shot, clip }) => {` with:
```js
export default async ({ page, base, shot, clip, fetchJson }) => {
```
replace line 284 `  await page.goto('about:blank');` (the last line before `};`) with:
```js
  await page.goto('about:blank');

  // Downloads and the season story, with the downloads and the disk answered here.
  const series = await fetchJson('GET', '/api/movies/' + SERIES_KEY);
  const film = await fetchJson('GET', '/api/movies/' + FILM_KEY).catch(() => ({}));
  await page.route('**/api/stream/downloads**', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { host: 'verify', active: true, downloads: DOWNLOADS } }) : route.fulfill({ status: 404, json: { error: 'not_found' } }),
  );
  await page.route('**/api/stream/disk', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: diskView(series, film) }) : route.fulfill({ status: 404, json: { error: 'not_found' } }),
  );

  await page.goto(base + '/movies/' + SERIES_KEY + '?side=stream');
  const season = page.locator('.mv-season[data-season="1"]');
  const head = season.locator('.mv-season-head');
  await head.locator('[role="progressbar"]').waitFor({ timeout: 20_000 });
  await season.locator('li[data-episode="S01E02"] [role="progressbar"]').waitFor({ timeout: 10_000 });
  await season.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shot('download-bars');

  await head.getByRole('button', { name: /^Choose how to download / }).click();
  await page.getByRole('menu', { name: /^Choose how to download / }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(200);
  await shot('download-menu');
  await page.keyboard.press('Escape');

  await head.getByRole('button', { name: /story of S01$/ }).click();
  const story = page.getByRole('dialog', { name: /^Story of / });
  await story.getByRole('heading', { name: /^S01E03 · / }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(200);
  await shot('season-story', { locator: story });
  await page.keyboard.press('Escape');

  await page.goto(base + '/movies/cache');
  await page.getByRole('button', { name: /^Downloading/ }).click();
  await page.locator('li.cp-episode [role="progressbar"]').first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
  await shot('cache-downloading');
  await page.goto('about:blank');
```
The field names `downloading_count`, `downloading_progress` and `DiskView.downloading` are the index's; read `web/src/moviesApi.ts` after phase 5 and use its names (Step 1).

**Then run:** `npm run docs:shots -- streaming` (fetches the Sintel trailer once into `~/.local/state/notesd-verify/.docs-film`; offline a test picture stands in). It rewrites the five player pictures from the same fakes and writes the four new ones under `docs/guide/img/streaming/`. Open each new picture with the Read tool and check it shows what its caption says before Step 10 references it.
**Impact:** the streaming shots now need `--direct-stream` (the fixture library is built once and cached).

### Step 10: The streaming guide

**File:** `docs/guide/streaming.md`

(a) line 29–30, replace `Direct
streaming does download, to this machine only: the [stream cache](#caching-a-film-or-an-episode)
and [torrents](#torrents).` with:
```markdown
Direct
streaming does download, to this machine only: the [stream cache](#caching-a-film-or-an-episode),
[torrents](#torrents), and the [downloads you ask for](#downloading-a-title) on a title's page.
```

(b) line 45, after the row `| The next episode is already here | … |`, insert:
```markdown
| A title kept for later | The Download button on a title's page, a season row or an episode row: a 1080p torrent first, else the cloud, made whole with its subtitle and seek previews, and kept until you delete it | [Downloading a title](#downloading-a-title) |
```
and replace line 48 with:
```markdown
| It knows the story | A season's story and an episode's are written from published recaps found on the web, one section per episode, with the sources named | [What a title says](#what-a-title-says-its-story) |
```

(c) lines 52–54, replace the paragraph with:
```markdown
The player pictures in this guide show the trailer of Sintel (© Blender Foundation, CC BY 3.0) in a
throwaway daemon, and the download and story pictures its fixture library with fixed numbers (see
[Proving a change](#proving-a-change)); the Movies page pictures are the owner's real library, as in
[movies.md](movies.md).
```

(d) lines 65 and 67 (contents): `[What a title says](#what-a-title-says-its-dialogue) ·` -> `[What a title says](#what-a-title-says-its-story) ·`, and `[Caching](#caching-a-film-or-an-episode) · [The next episode](#the-next-episode-fetched-ahead) ·` -> `[Caching](#caching-a-film-or-an-episode) · [The next episode](#the-next-episode-fetched-ahead) · [Downloading](#downloading-a-title) ·`.

(e) lines 1588–1605, replace the whole section from `### What a title says: its dialogue` through the paragraph ending `synopsis) and a web search.` with:
```markdown
### What a title says: its story

The book icon of an episode, and the one on each season's row (see
[movies.md](movies.md#the-movies-page)), open the whole story with every spoiler, written once by
Claude and kept. It is written from what people published about the title, not from its subtitle:
a subtitle names no speaker and describes no silent action, and a story retold from one reads so.

![A season's story: one section per episode, an episode no recap covers said so, and the sources it was written from](img/streaming/season-story.png)

- **A season's story** ("Narrate the full story of S02") is one run of Claude with WebSearch as its
  only tool (`NOTESD_MOVIES_STORY_MODEL`; a minute or two, and the pop-up says so). It looks in this
  order: Wikipedia's article on the season or its "List of … episodes", the series' Fandom wiki, then
  recap sites (Dramabeans, Vulture, The A.V. Club, Den of Geek). It answers one section per episode,
  each built only from what a source says, and the sources it read, which the pop-up lists as links.
  An episode no source covers keeps its section, which says "No published recap was found for this
  episode."; nothing is made up for it. A section naming an episode the season does not have is
  dropped. A season's story never reads a subtitle.
- **An episode's story** goes to the web first, the same way, for that one episode. Only when no
  source covers it (an episode too new or too obscure for a recap) is it written from the episode's
  dialogue, below, as before; the pop-up's foot then says `written by <model> from <n> subtitle lines (<provider>)`,
  where a web story's says `written by <model> from <n> web sources`.
- **A film's story** follows the episode's route through the same writer: the web first, its dialogue only when no
  published recap covers it. A film has no season button.
- **It is kept**, in `movie_stories`: one row per film, season or episode, with its sections, its
  sources, where it came from (`web` or `dialogue`), the model and the day, written only by
  `MoviesRepo.saveStory`. A stored story opens at once and no model is asked again. The stories
  written from dialogue before 2026-11-20 were copied in, as `dialogue`. With
  `NOTESD_MOVIES_STORY_MODEL=off` none is written, and the stored ones still open.
- **When nothing tells it.** A season no source covers at all, and an episode with neither a recap
  nor an English subtitle, answer `no_story_source`, and the pop-up says so.

The dialogue, when an episode needs it, is the episode's English subtitle as a stream source
carries it, every line with the minute it is said:

- **The first read resolves a source**, as a play does but out of sight: a background tab, no
  window, no sound, no player page (5 to 40 seconds). The first English track that holds lines is
  read through the pass-through's rules (the session's hosts, the captured headers): a separate
  `.vtt` or `.srt` file first, then a track inside an HLS manifest, whose segments are joined. A
  source with no English track of its own reads the outside file a play would borrow.
- **It is kept**, in `movie_dialogues` (one row per film or episode, written only by
  `MoviesRepo.saveDialogue`).
- **What it is not.** Dialogue only: silent action is not described and the speaker is not named.

No tool hands the lines to Claude Code or the chat bar: `direct_stream_dialogue` was never called
and was removed on 2026-11-20. "What is this episode about?" is answered from `movies_get` (TMDB's
synopsis) and a web search.
```

(f) line 1900 (after the `NOTESD_STREAM_AHEAD=off` bullet that ends the fetch-ahead section, before `### The daily canary`), insert:
```markdown

### Downloading a title

A film, a season or an episode can be put on this laptop to watch later, at the best picture it can
be had in, with nothing left to fetch when it plays: the Download button on its Stream-side title
page, a season row or an episode row (see [movies.md](movies.md#the-movies-page)), or
`direct_stream_cache` with `action: "start"` and `provider: "torrent"` in Claude Code. The answer
comes at once; the download runs in the daemon, and the title page and the
[Cache page](movies.md#the-cache-page) show its bar.

![A season downloading: the bar under the season's Download button, and one under each of its episodes](img/streaming/download-bars.png)

- **Asked for, never guessed.** A download starts only from your click or tool call, for exactly the
  film, season or episode named. A season is every episode of it that has aired and is not whole on
  this machine already; an episode that has not aired, or that TMDB gives no air date, is left out,
  and the click's notice says how many were. Nothing is downloaded in the
  background for it: the [fetch-ahead](#the-next-episode-fetched-ahead) and a
  [pause](#a-pause-caches-the-film) keep their own rules.
- **The order, when no source is named** (the button's own click):
  1. a 1080p torrent whose trackers report live seeders, picked as a play picks one;
  2. else a cloud source at 1080p or lower, through the [stream cache](#caching-a-film-or-an-episode)
     as your own cache (`max_height` 1080);
  3. else a torrent below 1080p.
- **Choose how to download.** The caret beside the button opens a menu titled "Choose how to
  download <name>": Best torrent (1080p), Cloud, and Pick a torrent…, which opens
  [every torrent of the film or episode](#the-torrent-candidates-of-a-title) with a download button
  on each row (a season has no pick row). A chosen kind is downloaded from that kind only: a torrent
  choice that finds nothing fails, and never turns to the cloud.
- **The original language.** A torrent's audio is checked as a play checks it, from the file's
  header before the bulk of it is fetched; a dub is left undownloaded and the next candidate tried.
- **The office network.** On SSID `Employee` torrent peers are not reached, so a download with no
  source named goes straight to the cloud, and one that asks for a torrent fails `no_peers_here`.
  WARP is never switched for a download.
- **The play on screen first.** One torrent download runs at a time. While a torrent plays in the
  player, torrent downloads pause (their files deselected) and carry on when the play ends. A cloud
  download waits in the stream cache's queue like any other cache.
- **A season pack.** For a season, a pack whose trackers report live seeders is preferred: it is
  opened once, every wanted episode's video and subtitle files are selected, and each episode gets
  its own row, so each plays from disk on its own. The audio check runs on the pack's first wanted
  episode before the rest is selected. An episode the pack lacks, or a season with no pack, is
  downloaded episode by episode in order.
- **Ready to play offline.** A torrent download stays in the swarm until its file is whole and, for a
  file Chrome cannot play as is, until its [remux](#the-remux-for-files-chrome-cannot-play) is whole
  too; the [subtitle chain](#subtitles-for-a-torrent) runs to its end, and the
  [seek previews](#seek-previews) are made from the whole file. Then it leaves the swarm. A later
  play finds it on disk, asks no index and joins no swarm.
- **Kept until you delete it.** A torrent you asked for carries a kept mark
  (`stream_torrents.kept_at`): the 7-day prune and the budget's prune pass it over. It still counts
  in the total the Cache page shows against the budget, so what is not kept goes first. A cloud
  download is your own cache, which the three-day clean-up never touches. Deleting it on the Cache
  page (or with `stream_disk`) removes the files and the mark.
- **A restart** carries queued, running and paused downloads on from what is on disk.
- **Progress.** `GET /api/stream/downloads` answers every queued, running, paused and failed download
  of this machine with its state, its source, progress from 0 to 1, bytes and error (`?title=`
  narrows it to one title and adds its finished downloads still on this machine); `active` is true while any is
  queued, running or paused (a torrent play on screen holds a download back, and the page sees it resume). The title page asks it
  once when it opens, and again every 2.5 s only while something of that title is active and the
  page is visible. `DELETE /api/stream/downloads/<id>` cancels one. The routes are in
  [http-api.md](reference/http-api.md).
- `NOTESD_STREAM_DOWNLOADS=off` starts nothing; the Download buttons still show, read no downloads (the route
  answers 503 `downloads_off`), and a click says "downloads are off on this daemon". The daemon's
  log says what each download does: [[CHECK: one of phase 2's log lines, quoted]].

![The menu of a season row's Download button](img/streaming/download-menu.png)

![The Cache page's Downloading view: the bars, and why each row downloads](img/streaming/cache-downloading.png)

| Answer | Meaning |
| --- | --- |
| `no_source` | No torrent and no cloud source of the title could be downloaded |
| `no_peers_here` | A torrent was asked for on the office network |
| `dubbed` | Every torrent found speaks another language than the title's original |
| `download_failed` | The download kept failing |
| `cancelled` | Cancelled on the title page or with `DELETE /api/stream/downloads/<id>` |
| `downloads_off` | `NOTESD_STREAM_DOWNLOADS=off` |
| `invalid_body` | The request named no film, season or episode the daemon understands |
| `unknown_download` | No download has that id |
| A stream cache answer | A cloud download fails as [a cache does](#caching-a-film-or-an-episode) |
```

(g) line 2875 (after the `- The next episode is fetched while one plays (`ahead.ts` …` rule), insert two rules:
```markdown
  - Downloads (`src/directStream/downloads/`): `StreamDownloads` queues what the owner asked for (`POST /api/stream/downloads`, `direct_stream_cache` with `provider: "torrent"`), one row per film or episode in `stream_downloads`, whose only writer is `DownloadsRepo` (`downloads/repo.ts`). Nothing starts unasked; a season is its aired episodes not whole here (`requestSeason`). The order with no source named is pure (`plan.ts`): a 1080p torrent with live seeders (`PREFERRED_TORRENT_HEIGHT`), the cloud cache at `max_height` 1080 as the owner's (never `auto`), a torrent below 1080p; a named kind is that kind only. On SSID `Employee` (an injected, read-only SSID reader) `auto` is cloud and `torrent` fails `no_peers_here`; a download never switches WARP. A torrent download goes through `TorrentSource.fetchKept`: resolved as a play is (the audio check before the bulk of the file; a dub skipped), the subtitle chain and the remux run to their end, the torrent held until the files are whole and then let go, its rows marked by `TorrentsRepo.setKept`; `pruneNow` and `keepBudget` pass a kept torrent over. One torrent download at a time, paused while a torrent session plays. A restart carries on queued, running and paused rows (`StreamDownloads.start`). `NOTESD_STREAM_DOWNLOADS=off` starts nothing. Tests inject the swarm, the cache, the clock and the SSID.
  - Stories (`src/movies/webStory.ts`, `src/movies/story.ts`): `WebStoryWriter` is Claude with WebSearch as its only tool (`tools` and `allowedTools`), no MCP, a turn cap and a timeout; `parseWebStory` keeps only the sections of episodes the season has and reads an unparseable answer as `story_failed`. An episode no source covers is stored `found: false` with no text, never filled in. `MovieStories.writeSeason` never reads a subtitle; an episode's `write` reads its dialogue only when the web writer answered `found: false`. Every story is kept by `MoviesRepo.saveStory` in `movie_stories` and read back without a model. Tests inject the writer.
```

(h) "Where the code is" table: replace the row at line 2912 (`src/directStream/dialogue.ts`) with these three rows, and after the row at line 2930 (`src/directStream/ahead.ts`) insert the fourth:
```markdown
| `src/directStream/dialogue.ts` | Subtitle text to dialogue lines, and its pages (an episode's story when the web has none) |
| `src/movies/webStory.ts`, `src/movies/story.ts` | The story of a season, an episode or a film: the web writer and its parser, the dialogue fallback, the store |
| `web/src/components/movies/StoryModal.tsx` | The story pop-up: sections per episode and the sources |
```
```markdown
| `src/directStream/downloads/`, `src/http/streamDownloadsApi.ts`, `web/src/components/movies/DownloadButton.tsx`, `web/src/lib/downloads.ts` | Downloads asked for: the queue, the order and the office rule (`plan.ts`), `stream_downloads` (`repo.ts`); the `/api/stream/downloads` routes; the button, its menu and bar, and the page's polling |
```

(i) "Proving a change", after the bullet at lines 2972–2975 (`- Torrents: …`), insert:
```markdown
- Downloads and the season story: `TORRENT_SEED_KBPS=20 verify.sh up --web --torrent`, then
  `scripts/direct-stream/downloads.sh RUN` (`downloads: PASS (story title season cache)`): a real torrent
  download of the fixture film and of the season pack from the loopback seeder, the bars on the title page,
  the Cache page's Downloading filter, and the season story pop-up from a story seeded into `movie_stories`;
  see the feature map entry. The pictures `download-bars.png`, `download-menu.png`, `season-story.png` and
  `cache-downloading.png` come from `npm run docs:shots -- streaming`, with `GET /api/stream/downloads` and
  `GET /api/stream/disk` answered by Playwright.
```
**Impact:** prose only; the heading rename changes one anchor, whose links (streaming.md lines 48, 65; movies.md lines 94, 399, 1195) are all updated in this phase.

### Step 11: The movies guide

**File:** `docs/guide/movies.md`

(a) line 94, replace the `Dialogue and story` row with two rows:
```markdown
| Dialogue | `movie_dialogues` | Shared | One row per film or episode: the lines of its English subtitle as a stream source carried them, read when an episode's story has no published recap ([streaming.md](streaming.md#what-a-title-says-its-story)). Read once and kept. |
| Story | `movie_stories` | Shared | One row per film, season or episode: the story Claude wrote when you pressed a book icon, its sections per episode, the sources it was written from and whether it came from the web or the dialogue. Written once and kept. |
```

(b) lines 396–404, replace the `**An episode's story.**` bullet with:
```markdown
- **An episode's story.** The book icon between an episode's code and its name opens the whole
  story of that episode, every spoiler included, in a pop-up. The first press has it written:
  Claude searches the web for published recaps of the episode and retells it from them, with the
  sources as links under it; only an episode no recap covers is retold from its English subtitle
  (see [streaming.md](streaming.md#what-a-title-says-its-story)). That takes a minute or two
  (`NOTESD_MOVIES_STORY_MODEL`). The story is kept, so it is written once: after that the icon is
  filled and the story opens at once on this machine. Nothing is written until you press. When
  neither the web nor a subtitle tells it, the pop-up says so. Closing the pop-up while it is being
  written does not stop it.
- **A season's story.** The book icon on each season's row ("Narrate the full story of S01"; none on
  Specials) opens the story of the whole season, one section per episode under its code and name,
  written once from the web the same way and kept, its sources as links. An episode no recap covers
  says so, and nothing is made up for it. A season's story never reads a subtitle.
- **Download** (the Stream side, with direct streaming on). An arrow icon beside Play on a film's
  page, on each season's row and on each episode row puts the film, the season's aired episodes or
  the episode on this machine to watch later: a 1080p torrent first, else a cloud source at 1080p
  or lower, else a smaller torrent; on the office network, the cloud. A series has no button at the
  top: its seasons carry it. The caret beside the icon opens "Choose how to download <name>": Best
  torrent (1080p), Cloud, or Pick a torrent… from [every torrent of it](#the-torrents-of-a-title).
  While it is queued or downloading a thin bar under the icon fills and its tooltip says how far;
  a season's bar is the mean of its episodes'. The page reads it again every 2.5 s while something
  of the title downloads and the tab is visible, and not otherwise. Done, the icon is filled and
  its tooltip names torrent or cloud and the size; failed, the tooltip says why and a click asks
  again. While it is queued, downloading or paused an X beside the caret ("Cancel the download of <name>")
  cancels it; what it already fetched stays, and is deleted on the Cache page. A download is kept until you
  delete it on the [Cache page](#the-cache-page). How it chooses, what it keeps and the pictures are
  in [streaming.md](streaming.md#downloading-a-title).
```

(c) after line 705 (the `**Playing.**` bullet of the Cache page), insert:
```markdown
- **Downloading.** What is downloading now is listed with what is on disk: a download you asked for
  on a title's page, the next episode [fetched ahead](streaming.md#the-next-episode-fetched-ahead)
  and a cloud cache a [pause](streaming.md#a-pause-caches-the-film) started. A thin bar on its row
  shows how far it is (on a season's and a title's row, the mean of what downloads under it), and a
  tag says why it downloads: `asked` (the Download button, `direct_stream_cache`), `ahead` (the next
  episode, fetched while one plays) or `pause` (a pause in the player). A download with nothing on
  disk yet has a row of 0 B. While anything downloads the page reads the disk every 3 s instead of
  every 15 s.
- **The Downloading filter** (the arrow icon beside the bulk buttons, with how many download) lists
  only the titles, seasons and episodes downloading now, unfolded, with their bars; another click
  goes back to the full list. A picture of it is in [streaming.md](streaming.md#downloading-a-title).
```
No picture is embedded here: this guide shows only the owner's real library, and no live run starts a download for a picture. The Downloading view's fixture picture is shown by the streaming guide (Step 10 (f)).

(d) line 1195, `([streaming.md](streaming.md#what-a-title-says-its-dialogue)).` -> `([streaming.md](streaming.md#what-a-title-says-its-story)); a season's is its row's book icon.`

(e) line 1209, after the `NOTESD_DIRECT_STREAM=off` row, insert:
```markdown
| `NOTESD_STREAM_DOWNLOADS=off` | `POST /api/stream/downloads` answers 503 `downloads_off`; the Download buttons still show, and a click says downloads are off on this daemon. |
```

(f) line 1280, replace `| `src/movies/story.ts` | An episode's story |` with:
```markdown
| `src/movies/story.ts`, `src/movies/webStory.ts` | The story of an episode, a season or a film: written from the web first, from the dialogue only when no recap covers an episode, kept in `movie_stories` |
| `web/src/components/movies/DownloadButton.tsx`, `web/src/lib/downloads.ts` | The Download button, its menu and bar on the title page, and the polling of `GET /api/stream/downloads` |
```

(g) line 1320, append to the bullet `- Unit tests: …`:
```markdown
 Downloads, the Cache page's Downloading view and the season story end to end:
  `TORRENT_SEED_KBPS=20 verify.sh up --web --torrent` and
  `.claude/skills/verify-notesd/scripts/direct-stream/downloads.sh RUN` (see
  [streaming.md](streaming.md#proving-a-change)). The real-library pictures never show a download:
  no live run starts one for a picture.
```
**Impact:** prose only. The real-library pictures (`episodes.png`, `stream-title.png`, `film.png`, `cache.png`) still show the page before this set's buttons until the live retake under Handoffs.

### Step 12: Configuration, the architecture guide and CLAUDE.md

**File:** `docs/guide/architecture.md:68-72` (the single-writer table) and `:96` (the data model's "Direct streaming" row)
**Change (reconciled: an analysis impact point no plan owned):** in the writer table, after the `stream_torrent_marks` row, add
```markdown
| `stream_downloads` | `DownloadsRepo` (`src/directStream/downloads/repo.ts`) |
```
(`movie_stories` is covered by the existing `movie_*` → `MoviesRepo` row, and `stream_torrents.kept_at` by `TorrentsRepo`.)
In the "Direct streaming" data-model row, add `stream_downloads` to the table list and, at the end of its description,
`A download is one film or episode the owner asked for on one host (a season click makes one per episode under one batch); it ends on a torrent download, kept by the owner (`stream_torrents.kept_at`: both prunes skip it), or on the owner's stream cache.`
In the "Movies" data-model row (line 95), add `movie_stories` to the table list and `Stories (film, episode, season) are kept in movie_stories, one row each, with their web sources.` to its description.

**File:** `docs/guide/reference/configuration.md:103`
**Change:** only if the row still says the story is written "from its dialogue" (phase 6 may have updated it): replace the row with
```markdown
| `NOTESD_MOVIES_STORY_MODEL` | `sonnet` | Claude model that writes a story when you press a book icon: an episode's, or a season's from its row, with WebSearch as its one tool, from published recaps; an episode no recap covers is written from its dialogue instead, and a season never is. One run per story, and the story is kept. `off`: no story is written; stored ones still open. The same model, with WebSearch, collates what a genre means for a title when you click the genre on its page (once per title and genre); `off` stops that too. See [What a title says](../streaming.md#what-a-title-says-its-story). |
```
Check `NOTESD_STREAM_DOWNLOADS` has a row (phase 2's); if it is missing, `tests/unit/docs/reference.test.ts` already fails on phase 2's tree — add the row from `src/config.ts`'s comment and say so in Handoffs.

**File:** `CLAUDE.md`
(a) line 91, after the `- A person and a studio are read from TMDB …` sub-bullet, insert:
```markdown
  - A story (an episode's, a season's from its row's book icon) is written from the web first: Claude with WebSearch as its only tool (`src/movies/webStory.ts`, `NOTESD_MOVIES_STORY_MODEL`), one section per episode built only from what a source says, its sources kept and shown. An episode no source covers says so and is never invented. A season's story never reads a subtitle; an episode's reads its dialogue only when the web has nothing. `MoviesRepo.saveStory` keeps every story in `movie_stories`, and a stored story is answered without a model.
```
(b) line 100, append to the `**Nothing is guessed, nothing starts unasked.**` bullet:
```markdown
 A download starts only from the owner's click or `direct_stream_cache` call, for exactly the film, season (its aired episodes) or episode named.
```
(c) line 101, in the `**Single writers.**` bullet, replace `` `TorrentsRepo` writes `stream_torrents`; `` with:
```markdown
`TorrentsRepo` writes `stream_torrents` (the owner's kept mark too, `setKept`); `DownloadsRepo` writes `stream_downloads`;
```
(d) line 105, in the WARP bullet, replace `never for a cloud stream,` with `never for a cloud stream or a download,`.
(e) line 106, after the `**Torrents.**` bullet, insert:
```markdown
  - **Downloads** (`src/directStream/downloads/*`). A download is held in the swarm until its files (and remux) are whole, then let go; one the owner asked for is kept through the age and budget prunes until it is deleted on the Cache page. With no source named: a 1080p torrent with live seeders, then the cloud at 1080p or lower, then a smaller torrent; on SSID `Employee`, the cloud only. Torrent downloads pause while a torrent plays on screen. How it works is `docs/guide/streaming.md` ("Downloading a title").
```
**Impact:** rules for later changes; `tests/unit/docs/reference.test.ts` checks CLAUDE.md's links (none added).

### Step 13: Run the proof, fix the smallest defect, keep the evidence

**File:** none planned; a defect's fix lands in the file that holds it.
**Change:** run the Verification below (J1–J4 and the neighbor check) on fresh runs. A journey that fails because the product is broken (not because a name in Steps 3–7 differs from the landed one) is a defect: reproduce it with the failing journey first, trace it to a line, fix it in the fewest lines in the owning file, add or extend the owning phase's unit test so it would have caught it, rerun the journey, and record it as a line under `## Reconciliation Log` of `.workflows/plan/STREAM_DOWNLOADS_SEASON_STORY_PLAN.md` (`phase 9 proof: <journey> found <defect> in <file:line>; fixed by <change>`) and in the commit body. Never weaken a journey to make it pass. A name mismatch is fixed in the steps file's constants instead, and needs no log line.
**Impact:** at most a small fix in a phase 1–8 file.

### Step 14: Docs checks

**File:** none.
**Change:** `npm run docs:check` (no stale reference, no broken link, no unshown picture), `npm test`, `npm run typecheck`, and `! grep -rn '\[\[CHECK' docs/guide CLAUDE.md .claude/skills/verify-notesd scripts/docs` (prints nothing: every landed name was filled in).
**Impact:** none.

## Principles applied

- Build the lever: the proof is one rerunnable script (`direct-stream/downloads.sh`, four stages) with steps files, and the unresolved landed names are `[[CHECK]]` marks a grep in Step 14 refuses, so a reviewer reruns the script and the grep instead of reading prose for drift.
- Laziness protocol: the season story is proved by seeding `movie_stories` and opening it with the story model off (the store is the path R6.1's pop-up reads; R6.5 makes it model-free), instead of a fake story writer seam in the daemon; a running download is made observable by one seeder rate knob (`TORRENT_SEED_KBPS`) instead of a new, larger fixture; the movies guide gets no new picture.
- Prove it works: every owned criterion is proved on a throwaway daemon through the real routes, the real loopback swarm and the real page, with screenshots, video and `LOG.md` lines kept; the pictures are a separate concern and never stand as proof.
- Test behavior, not implementation: the steps assert what a user or an assistive tool sees (`role="progressbar"` and `aria-valuenow`, which rows the list shows, `aria-pressed`, headings, links) and the requests the page makes, never component state or class internals beyond the rows' existing data attributes.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` (includes `tests/unit/docs/reference.test.ts`), `npm run docs:check`
**Proof:** a real torrent download from the loopback seeder and the real wall, on a throwaway daemon.
- Harness: `.claude/skills/verify-notesd` (`verify.sh up --web --torrent`, `$V ui`, `$V api`, `$V exec`, `$V note`)
- Feature-map entries: `features/direct-streaming.md` ("Downloads asked for"), `features/movies.md` (Cache page; Download buttons; stories)
- Journeys (one fresh run for J1–J4: `V=.claude/skills/verify-notesd/scripts/verify.sh; TORRENT_SEED_KBPS=20 $V up --web --torrent` → note `RUN`; `D=.claude/skills/verify-notesd/scripts/direct-stream/downloads.sh`; run the stages in this order; `$V down RUN` at the end):
  - **J1** · traces R3.1 — `$D RUN title` (queues the fixture film with `via: "torrent"`, waits for it to run, then `$V ui RUN .claude/skills/verify-notesd/scripts/stream/downloads-title.steps.mjs` on `/movies/movie-467905?side=stream`) → passes when it prints `ok  the film's title page shows its head bar rising, read at most 3 s apart`, the ui transcript `evidence/NN-ui-downloads-title.txt` has `J1 PASS` with the bar's two values (second higher) and `longest gap` ≤ 3000 ms, and the screenshot `*-title-downloading.png` shows the bar under the head's Download button
  - **J2** · traces R3.1 — `$D RUN season` (cancels the film, queues MobLand season 1 with `via: "torrent"`, waits for its rows to run, then `downloads-season.steps.mjs` on `/movies/tv-247718?side=stream`) → passes when it prints `ok  the season row and the rows of S01E01 and S01E02 show bars, read at most 3 s apart`, the transcript has `J2 PASS` (season bar rising, at least one episode bar rising, longest gap ≤ 3000 ms), and `*-season-downloading.png` shows a bar on the season row and on both episode rows
  - **J3** · traces R4.2 — `$D RUN cache` (a ready cloud cache of the film from the fake resolver, season 1 still running, then `downloads-cache.steps.mjs` on `/movies/cache`) → passes when it prints `ok  the Downloading filter lists only MobLand's downloading rows, and a second click brings the film back` and the transcript has `J3 PASS`: default view lists `movie-467905` and `tv-247718`; with the filter `aria-pressed="true"` only `tv-247718` is listed, season 1 unfolded, every episode row with a bar; after the second click `aria-pressed="false"` and `movie-467905` is listed again (screenshots `*-default-view.png`, `*-downloading-view.png`, `*-default-again.png`)
  - **J4** · traces R6.1 — `$D RUN story` (seeds MobLand S01's story into `movie_stories` with `$V exec`; `GET /api/movies/tv-247718/story?season=1` must answer 3 sections, `cached: true`; then `season-story.steps.mjs`) → passes when it prints `ok  the season row's story button opens the pop-up with one section per episode` and the transcript has `J4 PASS: 3 sections under S01E01..S01E03`, with `*-season-story.png` showing headings `S01E01 · Stick or Twist`, `S01E02 · Eye for an Eye`, `S01E03 · Lie Down with Dogs` and the not-found line under the third
  - All four in one call: `$D RUN` ends `downloads: PASS (story title season cache)` (exit 0). Exit 3 `INCONCLUSIVE` means the run read SSID `Employee` (no SSID pin from phase 2): report the journeys as inconclusive, not as a pass or a fail.
- Neighbor check: `direct_stream_cache` and `POST /api/stream/cache` (the tool gained a `provider` option in phase 4; its default must still be the cloud cache). On a separate fresh run: `$V up --direct-stream`, then `.claude/skills/verify-notesd/scripts/direct-stream/cache.sh RUN start tool` → passes when it ends `cache: PASS (start tool)`; `$V down RUN`.
- Cost: none billed. No model call (`NOTESD_MOVIES_STORY_MODEL=off` is pinned, the story is seeded), no real index, swarm, Chrome or provider. About five minutes of wall time for J1–J4 at 20 kB/s, two for the neighbor check, and a few minutes for `npm run docs:shots -- streaming`.
**Exit criteria:** `npm run typecheck`, `npm test` and `npm run docs:check` pass; no `[[CHECK` is left; `downloads.sh RUN` ends `downloads: PASS (story title season cache)` on a fresh `TORRENT_SEED_KBPS=20 verify.sh up --web --torrent` run with the evidence kept under `~/.local/state/notesd-verify/<RUN>/evidence/`; the neighbor check ends `cache: PASS (start tool)`; the four new pictures exist and are shown by the streaming guide.

## Handoffs

- **Live retake of the movies guide's real-library pictures** (`episodes.png`, `stream-title.png`, `film.png`, `cache.png`): they cannot show the new buttons until the live daemon runs this set's build, which is after the merge to `main` and `scripts/install.sh` (restart allowed by the owner's standing consent). Then `npm run docs:shots -- --live movies` (read-only: no Play, no download is started, no trash pressed) retakes them; nothing in this phase replaces a real-library picture with a fixture one. For the completion step of the set, after landing.
- **The SSID seam (phase 2), settled.** Phase 2 owns `NOTESD_STREAM_DOWNLOAD_SSID`, its configuration row and the `verify.sh` pin `verify-home`; this phase adds no SSID line (Step 2). `downloads.sh`'s `INCONCLUSIVE` exit stays only as a guard against the pin being lost.
- **Test ids and roles phases 5, 7 and 8 must render** (listed under **Requires**): `role="progressbar"` with `aria-valuenow` on every download bar, the `Downloading` toggle with `aria-pressed`, the season story button's name ending `story of S01`, section headings `S01E0n · <name>`, the `Choose how to download …` caret and menu. The reconciler should copy these into those phases' plans so their tests pin them.
- **Criteria proved elsewhere, observed here only incidentally:** R1.1–R1.11, R2.1–R2.4 (phases 2–4, 8: the journeys queue through the same routes but assert only the bars), R3.2 (phase 4), R3.3 (phase 8: no polling while nothing is active), R4.1, R4.3, R5.1 (phase 5: J3 sees the default view and the bars but traces only R4.2), R6.2–R6.6 (phases 6, 7).
- `src/chat/prompt.ts` says nothing about stories or downloads; the chat bar still neither caches nor downloads (Scope), so it is not changed. If phase 4 left `src/mcp/instructions.ts` or the `direct-stream` skill without the download line, that is phase 4's.

## Rollback

Revert this phase's commit: the guides, `CLAUDE.md`, the configuration row, the feature map, `verify.sh`'s two edits, the streaming shots module and the four new pictures go back (the five player pictures return to their previous bytes). Nothing in the daemon depends on any of it. A defect fix from Step 13, if any, is its own commit and is reverted on its own.

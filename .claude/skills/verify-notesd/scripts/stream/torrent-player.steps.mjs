// The player page on a torrent session (torrent-stream-source phase 4) in a throwaway daemon's real
// build (verify.sh up --web). The session, the torrent's status and map and its file route are
// answered here by a fake in the shapes phases 1 and 3 give the page: a 300 s H.264/AAC MP4 made
// once with ffmpeg, of which only the first 40% is "on disk" until the steps release the rest.
// Nothing leaves this machine and no Chrome on Windows is touched.
//   verify.sh ui RUN .claude/skills/verify-notesd/scripts/stream/torrent-player.steps.mjs
// TORRENT_FILM_DIR overrides where the film is kept (default ~/.local/state/notesd-verify/.torrent-film).
// Logs "TORRENT STATUS PASS", "HIDDEN PASS", "TORRENT WAIT PASS", "NO AUTO MOVE PASS",
// "TORRENT READY PASS", "SHUFFLE PASS"; the first failed check throws and fails the run.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DIR = process.env.TORRENT_FILM_DIR ?? path.join(os.homedir(), '.local/state/notesd-verify/.torrent-film')
const FILM = path.join(DIR, 'film.mp4')
const DURATION_S = 300
/** The share of the file "on disk" until the steps release the rest. */
const ON_DISK = 0.4
const FIRST = { hash: '08ada5a7a6183aae1e09d831df6748d566095a10', name: 'Fixture.Film.2026.1080p.WEB.x264' }
const NEXT = { hash: '0123456789abcdef0123456789abcdef01234567', name: 'Fixture.Film.2026.720p.BluRay.x264' }
const PEERS = 7
/** 16 000 kilobits per second: 2.0 MB/s. */
const DOWN_KBPS = 16000

function check(ok, what) {
  if (!ok) throw new Error(what)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeFilm() {
  if (existsSync(FILM)) return
  mkdirSync(DIR, { recursive: true })
  const part = path.join(DIR, 'film.part.mp4')
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=duration=${DURATION_S}:size=640x360:rate=24`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${DURATION_S}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '48',
    '-c:a', 'aac', '-shortest', '-movflags', '+faststart', part,
  ])
  renameSync(part, FILM)
}

async function until(page, cond, ms, what) {
  for (let waited = 0; waited < ms; waited += 250) {
    if (await cond()) return
    await page.waitForTimeout(250)
  }
  check(await cond(), what)
}

/** How far the timeline's thick grey bar reaches, in percent of the film (0 without one). */
const loadedTo = (page) =>
  page.evaluate(() => {
    const bar = document.querySelector('.st-seek').style.getPropertyValue('--st-loaded-bar')
    const stops = [...bar.matchAll(/var\(--st-loaded\) ([\d.]+)%/g)].map((m) => Number(m[1]))
    return stops.length === 0 ? 0 : Math.max(...stops)
  })

/** window.notesdStream without its start() (functions do not cross into the steps). */
const streamState = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.notesdStream ?? null)))

const setVisibility = (page, state) =>
  page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s })
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)

export default async ({ page, base, shot, log }) => {
  makeFilm()
  const film = readFileSync(FILM)
  const size = film.length
  const cut = Math.floor(size * ON_DISK)
  const fake = { current: FIRST, released: false, statusReads: {}, sourceAsks: 0, cacheAsks: 0, held: 0 }
  const reads = (hash = FIRST.hash) => fake.statusReads[hash] ?? 0

  // Phase 3's SessionInfo for a torrent session.
  const sessionJson = () => ({
    session_id: 'T1',
    kind: 'movie',
    tmdb_id: 1,
    season: null,
    episode: null,
    title: 'Fixture Film (2026)',
    provider: 'Torrent',
    manifest_kind: 'mp4',
    manifest_url: `/api/stream/torrent/${fake.current.hash}/f/0`,
    subtitles: [],
    best_height: 360,
    resume_s: 0,
    created_at: null,
    refreshed_at: null,
    expires_at: null,
    cached: null,
    torrent: { info_hash: fake.current.hash, name: fake.current.name, index: 'Fixture', state: fake.released ? 'ready' : 'downloading', seeds: 52 },
  })

  await page.route('**/api/stream/sessions/**', async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    if (req.method() === 'GET' && u.pathname === '/api/stream/sessions/T1') return route.fulfill({ json: sessionJson() })
    if (req.method() === 'POST' && u.pathname === '/api/stream/sessions/T1/source') {
      fake.sourceAsks += 1
      fake.current = NEXT
      return route.fulfill({ json: { ...sessionJson(), switched: true, reason: null, from: 'Torrent', provider: 'Torrent' } })
    }
    if (req.method() === 'POST' && u.pathname === '/api/stream/sessions/T1/cache') fake.cacheAsks += 1
    // Positions and log lines: the page ignores the answer, a 404 included.
    return route.fulfill({ status: 404, json: { error: 'not_found' } })
  })

  // Phase 1's torrent routes: the status, the map and the file with Range.
  await page.route('**/api/stream/torrent/**', async (route) => {
    const req = route.request()
    const m = /^\/api\/stream\/torrent\/([0-9a-f]{40})(\/map|\/f\/0)?$/.exec(new URL(req.url()).pathname)
    if (!m) return route.fulfill({ status: 404, json: { error: 'not_found' } })
    const [, hash, tail] = m
    if (tail === undefined) {
      fake.statusReads[hash] = reads(hash) + 1
      return route.fulfill({
        json: fake.released
          ? { info_hash: hash, state: 'ready', peers: 0, down_kbps: 0, up_kbps: 0, progress: 1 }
          : { info_hash: hash, state: 'downloading', peers: PEERS, down_kbps: DOWN_KBPS, up_kbps: 800, progress: ON_DISK },
      })
    }
    if (tail === '/map') {
      return route.fulfill({ json: { duration_s: DURATION_S, ranges: fake.released ? [[0, DURATION_S]] : [[0, DURATION_S * ON_DISK]] } })
    }
    const asked = /bytes=(\d+)-(\d*)/.exec(req.headers()['range'] ?? '')
    const start = asked ? Number(asked[1]) : 0
    let end = asked && asked[2] !== '' ? Math.min(Number(asked[2]), size - 1) : size - 1
    if (!fake.released) {
      if (start >= cut) {
        // Not on disk yet: the answer waits for the pieces, as phase 1's file route does.
        fake.held += 1
        while (!fake.released) await sleep(250)
      } else {
        end = Math.min(end, cut - 1)
      }
    }
    try {
      await route.fulfill({
        status: 206,
        headers: { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}` },
        body: film.subarray(start, end + 1),
      })
    } catch {
      // The page gave the request up (a seek): nothing to answer.
    }
  })

  await page.goto(`${base}/stream/T1`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 30_000 })
  // Chromium refuses sound without a gesture: the page plays muted, which is still a play.
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !!v && !v.paused && v.currentTime > 2
  }, null, { timeout: 30_000 })
  await page.mouse.move(400, 400)

  // R2.7: the peers, the speed and the stretches on disk.
  const mark = page.locator('.st-top .st-torrent')
  await mark.waitFor({ state: 'attached', timeout: 10_000 })
  await until(page, async () => ((await mark.getAttribute('aria-label')) ?? '').includes(`${PEERS} peers, 2.0 MB/s`), 10_000, 'the torrent mark names the peers and the speed')
  const stats = await page.locator('.st-torrent-stat').allTextContents()
  check(stats[0] === String(PEERS) && stats[1] === '2.0 MB/s', `the numbers beside the title are ${JSON.stringify(stats)}`)
  const first = await streamState(page)
  check(first.torrent?.infoHash === FIRST.hash && first.torrent.peers === PEERS && first.torrent.downKbps === DOWN_KBPS, `window.notesdStream.torrent is ${JSON.stringify(first.torrent)}`)
  const bar = await loadedTo(page)
  check(bar >= 39.5 && bar <= 45, `the grey bar reaches what is on disk, 40% (to ${bar}%)`)
  await shot('torrent-status')
  log('TORRENT STATUS PASS')

  // Polls stop while the tab is hidden and start again when it shows.
  await setVisibility(page, 'hidden')
  await page.waitForTimeout(500)
  const hiddenFrom = reads()
  await page.waitForTimeout(6_000)
  check(reads() === hiddenFrom, `a hidden tab asked ${reads() - hiddenFrom} times`)
  await setVisibility(page, 'visible')
  await until(page, async () => reads() > hiddenFrom, 3_000, 'the tab asks again as soon as it shows')
  log('HIDDEN PASS')

  // A seek past what is on disk waits for it, through the page's own Position control.
  await page.getByLabel('Position').evaluate((el) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '200')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const waiting = page.getByRole('status', { name: 'Fetching this part from peers' })
  await waiting.waitFor({ timeout: 5_000 })
  check((await streamState(page)).torrent?.fetching === true, 'window.notesdStream.torrent.fetching is true while it waits')
  await shot('torrent-fetching')
  log('TORRENT WAIT PASS')

  // One long freeze is counted as a stall every 10 s; on a torrent none of them asks for another source.
  const lines = async (prefix) => ((await streamState(page)).log ?? []).filter((line) => line.startsWith(prefix)).length
  await until(page, async () => (await lines('stalled at')) >= 3, 45_000, 'the frozen film is counted as a stall three times')
  check(fake.sourceAsks === 0, `the page asked for another source by itself (${fake.sourceAsks} asks)`)
  check(!((await streamState(page)).log ?? []).some((line) => line.includes('asking for another source')), 'no "asking for another source" line')
  check(fake.held > 0, 'the page asked for bytes past what is on disk')
  log('NO AUTO MOVE PASS')

  // The pieces arrive: the film plays on, the bar covers it, the page stops asking.
  fake.released = true
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !!v && !v.paused && v.currentTime > 202
  }, null, { timeout: 30_000 })
  await waiting.waitFor({ state: 'detached', timeout: 5_000 })
  await until(page, async () => (await streamState(page)).torrent?.state === 'ready', 10_000, 'the torrent turns to on disk')
  await until(page, async () => (await loadedTo(page)) === 100, 10_000, 'the grey bar reaches the end once the whole file is on disk')
  check((await page.locator('.st-torrent[data-state="ready"]').count()) === 1, 'the drive mark shows')
  const doneAt = reads()
  await page.waitForTimeout(7_000)
  check(reads() === doneAt, `the page kept asking after the download was complete (${reads() - doneAt} more)`)
  await page.mouse.move(420, 420)
  await shot('torrent-ready')
  log('TORRENT READY PASS')

  // The owner's shuffle (S) moves to the next torrent and the line names its release.
  await page.keyboard.press('s')
  await page.locator('.st-notice', { hasText: `Torrent: ${NEXT.name}` }).waitFor({ state: 'attached', timeout: 10_000 })
  await until(page, async () => (await streamState(page)).torrent?.infoHash === NEXT.hash, 10_000, 'the page plays the next torrent')
  check(fake.sourceAsks === 1, `one ask for another source (${fake.sourceAsks})`)
  check(reads(NEXT.hash) >= 1, "the page reads the next torrent's numbers")
  check((await page.getByRole('button', { name: 'Another torrent (S)' }).count()) === 1, 'the shuffle button is named for torrents')
  check(fake.cacheAsks === 0, 'a torrent session never asks for a stream cache')
  log('SHUFFLE PASS')
}

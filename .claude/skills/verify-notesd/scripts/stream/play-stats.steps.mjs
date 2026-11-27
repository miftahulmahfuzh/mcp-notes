// The player page's counters (stream-play-log phase 2, R1.6) in a throwaway daemon's real build
// (verify.sh up --web). As in recovery.steps.mjs, the daemon's /api/stream/sessions/* routes are
// answered here: S1 from the HLS fixture make-hls-fixture.sh builds (under ?muted=1: 30 s loaded
// ahead, and a muted page never asks for another source), T1 a torrent session as in
// torrent-player.steps.mjs (a 300 s MP4, 40% "on disk" until released). Every position report the
// page posts is kept, and its `stats` read. Nothing leaves this machine; no Chrome on Windows.
//   STREAM_FIXTURE=<folder make-hls-fixture.sh printed> verify.sh ui RUN <this file>
// Logs "FIRST FRAME PASS", "STALL PASS", "GRACE PASS", "BEAT PASS", "NEW LOAD PASS",
// "TORRENT WAIT PASS"; the first failed check throws and fails the run.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const FIX = process.env.STREAM_FIXTURE
const TYPES = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.vtt': 'text/vtt' }
const LOAD = /^[A-Za-z0-9_-]{8,32}$/
const FILM_DIR = process.env.TORRENT_FILM_DIR ?? path.join(os.homedir(), '.local/state/notesd-verify/.torrent-film')
const FILM = path.join(FILM_DIR, 'film.mp4')
const FILM_S = 300
const ON_DISK = 0.4
const HASH = '08ada5a7a6183aae1e09d831df6748d566095a10'
/** Under hls.js's 10 s time-to-first-byte limit, over the 6.5 s a seek's wait needs to be a stall. */
const STALL_HOLD_MS = 8_000
/** Inside the 5 s seek grace: never a stall. */
const GRACE_HOLD_MS = 2_000
/** Long enough for the page's stall timer to fire during the torrent's wait. */
const TORRENT_HOLD_MS = 9_000

function check(ok, what) {
  if (!ok) throw new Error(what)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeFilm() {
  if (existsSync(FILM)) return
  mkdirSync(FILM_DIR, { recursive: true })
  const part = path.join(FILM_DIR, 'film.part.mp4')
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=duration=${FILM_S}:size=640x360:rate=24`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${FILM_S}`,
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

const hlsSession = {
  session_id: 'S1', kind: 'movie', tmdb_id: 1, season: null, episode: null, provider: 'Fixture', best_height: 720,
  created_at: null, refreshed_at: null, expires_at: null,
  title: 'Fixture Stats (2026)',
  manifest_url: '/api/stream/sessions/S1/p?u=v720/index.m3u8',
  manifest_kind: 'hls',
  subtitles: [],
  resume_s: 20,
}

const torrentSession = {
  session_id: 'T1', kind: 'movie', tmdb_id: 1, season: null, episode: null, provider: 'Torrent', best_height: 360,
  created_at: null, refreshed_at: null, expires_at: null, cached: null,
  title: 'Fixture Torrent Stats (2026)',
  manifest_url: `/api/stream/torrent/${HASH}/f/0`,
  manifest_kind: 'mp4',
  subtitles: [],
  resume_s: 0,
  torrent: { info_hash: HASH, name: 'Fixture.Film.2026.1080p.WEB.x264', index: 'Fixture', state: 'downloading', seeds: 52 },
}

const playingPast = (page, s, timeout = 30_000) =>
  page.waitForFunction((at) => {
    const v = document.querySelector('video')
    return !!v && !v.paused && v.currentTime > at
  }, s, { timeout })

const pageLog = (page) => page.evaluate(() => window.notesdStream?.log ?? [])

export default async ({ page, base, shot, log }) => {
  check(FIX, 'set STREAM_FIXTURE to the folder make-hls-fixture.sh printed')
  makeFilm()
  const film = readFileSync(FILM)
  const size = film.length
  const cut = Math.floor(size * ON_DISK)
  const fake = { posts: [], hold: null, released: false }
  const reportsOf = (id) => fake.posts.filter((p) => p.id === id)
  const statsOf = (id) => reportsOf(id).map((p) => p.body.stats).filter((s) => s !== undefined)
  const lastStats = (id) => statsOf(id).at(-1)
  const nextReport = async (id, what) => {
    const n = reportsOf(id).length
    await until(page, () => reportsOf(id).length > n, 8_000, what)
    return lastStats(id)
  }

  await page.route('**/api/stream/sessions/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    const m = /^\/api\/stream\/sessions\/(S1|T1)(?:\/(p|position|events|cache))?$/.exec(url.pathname)
    if (!m) return json(403, { error: 'unknown_session' })
    const [, id, tail] = m
    if (tail === 'position') {
      fake.posts.push({ id, body: req.postDataJSON() })
      return json(200, { ok: true })
    }
    if (tail === 'events' || tail === 'cache') return json(404, { error: 'not_found' })
    if (tail === 'p') {
      const u = url.searchParams.get('u') ?? ''
      const seg = /seg(\d+)\.ts$/.exec(u)
      const hold = fake.hold
      // A one-shot hold: the first segment asked in the range waits, as a slow host's would.
      if (seg && hold && Number(seg[1]) >= hold.from && Number(seg[1]) < hold.to) {
        fake.hold = null
        await sleep(hold.ms)
      }
      const file = path.join(FIX, u)
      try {
        await route.fulfill({ status: 200, headers: { 'x-notesd-upstream': '200' }, contentType: TYPES[path.extname(file)] ?? 'application/octet-stream', body: readFileSync(file) })
      } catch {
        // The page gave the request up: nothing to answer.
      }
      return
    }
    return json(200, id === 'S1' ? hlsSession : torrentSession)
  })

  await page.route('**/api/stream/torrent/**', async (route) => {
    const req = route.request()
    const m = /^\/api\/stream\/torrent\/([0-9a-f]{40})(\/map|\/f\/0)?$/.exec(new URL(req.url()).pathname)
    if (!m) return route.fulfill({ status: 404, json: { error: 'not_found' } })
    const [, hash, tail] = m
    if (tail === undefined) return route.fulfill({ json: { info_hash: hash, state: 'downloading', peers: 7, down_kbps: 16000, up_kbps: 800, progress: ON_DISK } })
    if (tail === '/map') return route.fulfill({ json: { duration_s: FILM_S, ranges: [[0, FILM_S * ON_DISK]] } })
    const asked = /bytes=(\d+)-(\d*)/.exec(req.headers()['range'] ?? '')
    const start = asked ? Number(asked[1]) : 0
    let end = asked && asked[2] !== '' ? Math.min(Number(asked[2]), size - 1) : size - 1
    if (!fake.released) {
      if (start >= cut) {
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

  // FIRST FRAME: the first reports carry a load id, a first-frame time and played time, nothing else.
  await page.goto(`${base}/stream/S1?muted=1`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 30_000 })
  await playingPast(page, 22)
  await until(page, () => (lastStats('S1')?.played_ms ?? 0) > 0, 12_000, 'a position report carries stats with play counted')
  const first = lastStats('S1')
  log(`FIRST ${JSON.stringify(first)}`)
  check(reportsOf('S1').every((p) => p.body.stats !== undefined), 'every position report carries stats')
  check(LOAD.test(first.load), `the load id is 8-32 of [A-Za-z0-9_-] (got ${first.load})`)
  check(typeof first.first_frame_ms === 'number' && first.first_frame_ms > 0 && first.first_frame_ms < 30_000, `first_frame_ms is a time under 30 s (got ${first.first_frame_ms})`)
  check(first.stalls === 0 && first.stalled_ms === 0 && first.waits === 0 && first.waited_ms === 0 && first.errors === 0, `nothing but play counted yet (got ${JSON.stringify(first)})`)
  log('FIRST FRAME PASS')

  // STALL: a seek to 100 s whose first segment answers after 8 s. Past the 5 s grace and 1.5 s, it is one stall,
  // timed from the moment the film stood still until it moved.
  fake.hold = { from: 50, to: 60, ms: STALL_HOLD_MS }
  await page.evaluate(() => {
    document.querySelector('video').currentTime = 100
  })
  await playingPast(page, 101.5, 40_000)
  const stall = await nextReport('S1', 'a report after the stall')
  log(`STALL ${JSON.stringify(stall)}`)
  check(stall.load === first.load, 'the same load id')
  check(stall.stalls === 1, `one stall (got ${stall.stalls})`)
  check(stall.stalled_ms >= 6_000 && stall.stalled_ms <= 12_000, `stalled_ms about 8 s (got ${stall.stalled_ms})`)
  check(stall.played_ms > first.played_ms, 'play went on counting')
  check((await pageLog(page)).some((line) => line.startsWith('stalled at')), 'the page wrote its own "stalled at" line')
  await shot('play-stats-after-stall')
  log('STALL PASS')

  // GRACE: a seek to 70 s whose first segment answers after 2 s, inside the grace: no new stall.
  fake.hold = { from: 35, to: 45, ms: GRACE_HOLD_MS }
  await page.evaluate(() => {
    document.querySelector('video').currentTime = 70
  })
  await playingPast(page, 71.5, 30_000)
  const grace = await nextReport('S1', 'a report after the short seek')
  log(`GRACE ${JSON.stringify(grace)}`)
  check(grace.stalls === 1 && grace.stalled_ms === stall.stalled_ms, `the seek's own wait was not a stall (got ${JSON.stringify(grace)})`)
  log('GRACE PASS')

  // BEAT: a paused page's beats carry the same counters; play stops counting.
  await page.evaluate(() => document.querySelector('video').pause())
  await until(page, () => reportsOf('S1').filter((p) => p.body.beat === true).length >= 2, 15_000, 'two beats while paused')
  const beats = reportsOf('S1').filter((p) => p.body.beat === true).slice(-2).map((p) => p.body.stats)
  check(beats.every((s) => s.load === first.load), 'beats carry the same load id')
  check(beats[0].played_ms === beats[1].played_ms, `no play counted while paused (${beats[0].played_ms} then ${beats[1].played_ms})`)
  log('BEAT PASS')

  // NEW LOAD: a reload is a new page load: a new id, counters from zero.
  await page.reload()
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 30_000 })
  await until(page, () => lastStats('S1')?.load !== first.load, 15_000, 'a report under a new load id')
  const reloaded = lastStats('S1')
  log(`NEW LOAD ${JSON.stringify(reloaded)}`)
  check(LOAD.test(reloaded.load) && reloaded.load !== first.load, 'a different load id')
  check(reloaded.stalls === 0 && reloaded.stalled_ms === 0, 'counters start again from zero')
  log('NEW LOAD PASS')

  // TORRENT WAIT: a seek past what is on disk waits 9 s for the torrent: one wait, timed, and not a stall,
  // though the page's stall timer fires during it.
  await page.goto(`${base}/stream/T1?muted=1`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 30_000 })
  await playingPast(page, 2)
  await until(page, () => statsOf('T1').length > 0, 8_000, 'a torrent report carries stats')
  const before = await nextReport('T1', 'a torrent report before the seek')
  await page.evaluate(() => {
    document.querySelector('video').currentTime = 200
  })
  await until(page, async () => (await page.evaluate(() => window.notesdStream?.torrent?.fetching === true)), 5_000, 'the page waits for the torrent')
  await page.waitForTimeout(TORRENT_HOLD_MS)
  fake.released = true
  await playingPast(page, 202)
  const after = await nextReport('T1', 'a torrent report after the wait')
  log(`TORRENT ${JSON.stringify({ before, after })}`)
  check(after.load === before.load, 'the same load id')
  check(after.waits - before.waits === 1, `one more wait (got ${after.waits - before.waits})`)
  check(after.waited_ms - before.waited_ms >= 7_000 && after.waited_ms - before.waited_ms <= 20_000, `the wait timed about 9 s (got ${after.waited_ms - before.waited_ms})`)
  check(after.stalls === before.stalls && after.stalled_ms === before.stalled_ms, `the torrent's wait was not a stall (got ${JSON.stringify(after)})`)
  check((await pageLog(page)).some((line) => line.startsWith('stalled at')), "the page's stall timer did fire during the wait")
  await shot('play-stats-torrent')
  log('TORRENT WAIT PASS')
}

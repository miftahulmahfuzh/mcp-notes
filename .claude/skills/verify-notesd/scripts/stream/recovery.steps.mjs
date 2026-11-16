// The player's recovery from network errors (R1.7) in a throwaway daemon's real build
// (verify.sh up --web). As in player.steps.mjs, the daemon's /api/stream/sessions/* routes are
// answered here from the HLS fixture make-hls-fixture.sh builds; a failed load is an aborted
// request (no answer at all, so no X-Notesd-Upstream: a network failure, not a refusal). Nothing
// leaves this machine and no Chrome on Windows is touched.
//   STREAM_FIXTURE=<folder make-hls-fixture.sh printed> verify.sh ui RUN <this file>
// Logs "RECOVER PASS" and "SPENT PASS"; the first failed check throws and fails the run.
import { readFileSync } from 'node:fs'
import path from 'node:path'

const FIX = process.env.STREAM_FIXTURE
const TYPES = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.vtt': 'text/vtt', '.srt': 'application/x-subrip' }
const LIMIT = 5

function check(ok, what) {
  if (!ok) throw new Error(what)
}

// S1 plays the fixture's 720p playlist (its segment addresses name S1); S9 is the same title
// under a session whose every load fails.
function sessionJson(id) {
  return {
    session_id: id, kind: 'movie', tmdb_id: 1, season: null, episode: null, provider: 'Fixture', best_height: 720,
    created_at: null, refreshed_at: null, expires_at: null,
    title: id === 'S1' ? 'Fixture Recover (2026)' : 'Fixture Down (2026)',
    manifest_url: `/api/stream/sessions/${id}/p?u=v720/index.m3u8`,
    manifest_kind: 'hls',
    subtitles: [],
    resume_s: 20,
  }
}

const pageState = () => ({
  stage: window.notesdStream?.stage ?? null,
  error: window.notesdStream?.error ?? null,
  errors: window.notesdStream?.errors ?? [],
  log: window.notesdStream?.log ?? [],
  title: document.title,
  path: location.pathname,
  video: !!document.querySelector('video'),
  t: document.querySelector('video')?.currentTime ?? 0,
  spinner: !!document.querySelector('[role="status"][aria-label="Reconnecting after a network error"]'),
  alert: document.querySelector('[role="alert"]')?.textContent ?? '',
})

export default async ({ page, base, shot, log }) => {
  check(FIX, 'set STREAM_FIXTURE to the folder make-hls-fixture.sh printed')
  const fake = { segmentsDown: false, aborted: 0, downLoads: 0, posts: [] }
  await page.route('**/api/stream/sessions/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    const m = /^\/api\/stream\/sessions\/(S1|S9)(?:\/(p|position|events))?$/.exec(url.pathname)
    if (!m) return json(403, { error: 'unknown_session' })
    const [, id, tail] = m
    if (tail === 'p') {
      const u = url.searchParams.get('u') ?? ''
      if (id === 'S9') {
        fake.downLoads += 1
        return route.abort('failed')
      }
      if (fake.segmentsDown && /seg\d+\.ts$/.test(u)) {
        fake.aborted += 1
        return route.abort('failed')
      }
      const file = path.join(FIX, u)
      return route.fulfill({ status: 200, headers: { 'x-notesd-upstream': '200' }, contentType: TYPES[path.extname(file)] ?? 'application/octet-stream', body: readFileSync(file) })
    }
    if (tail === 'position') {
      fake.posts.push({ id, at: Date.now(), ...req.postDataJSON() })
      return json(200, { ok: true })
    }
    // Phase 1's log lines: accepted, not checked here.
    if (tail === 'events') return json(200, { ok: true })
    return json(200, sessionJson(id))
  })

  // RECOVER (R1.7): every segment load fails mid-film; the page stays on the film, says it is
  // reconnecting, keeps reporting, and plays on from there once the host answers again.
  await page.goto(`${base}/stream/S1?muted=1`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 30_000 })
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !!v && !v.paused && v.currentTime > 21
  }, null, { timeout: 30_000 })
  fake.segmentsDown = true
  await page.evaluate(() => {
    document.querySelector('video').currentTime = 80
  })
  // hls.js gives up on the segment first (its own retries), then the page's recovery begins.
  await page.waitForFunction(() => ['recovering', 'error'].includes(window.notesdStream?.stage), null, { timeout: 120_000 })
  const during = await page.evaluate(pageState)
  log(`RECOVER during ${JSON.stringify(during)}`)
  check(during.stage === 'recovering', `RECOVER: a fatal network error put the page in recovering, not error (got ${during.stage} ${during.error})`)
  check(during.path === '/stream/S1' && during.video && during.title === 'Fixture Recover (2026)', 'RECOVER: the page stayed on the film')
  check(during.spinner, 'RECOVER: the reconnecting spinner shows')
  check(during.log.some((l) => new RegExp(`^recovering 1/${LIMIT} after networkError frag`).test(l)), `RECOVER: the log says recovering 1/${LIMIT} after a fragment error (log ${JSON.stringify(during.log)})`)
  check(fake.aborted > 0, 'RECOVER: segment loads were failed')
  await shot('recovering')
  const postsBefore = fake.posts.length
  await page.waitForTimeout(6_000)
  const still = await page.evaluate(pageState)
  check(still.stage === 'recovering', `RECOVER: still recovering while the host is down (got ${still.stage})`)
  check(fake.posts.length > postsBefore, 'RECOVER: positions were still reported during the recovery')
  fake.segmentsDown = false
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 60_000 })
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !v.paused && v.currentTime > 81
  }, null, { timeout: 60_000 })
  const after = await page.evaluate(pageState)
  log(`RECOVER after ${JSON.stringify(after)}`)
  check(after.log.some((l) => /^recovered at /.test(l)), 'RECOVER: the log says recovered')
  check(after.errors.length === 0 && after.error === null, `RECOVER: no error was shown (got ${JSON.stringify(after.errors)})`)
  check(after.t > 80 && after.t < 100, `RECOVER: playing on from 80 s (at ${after.t})`)
  log(`RECOVER PASS ${fake.aborted} segment loads failed at 80 s; the page stayed on the film reconnecting, reported positions, and played on from 80 s once they answered`)

  // SPENT (R1.7): every load of S9 fails; the error comes only after the five restarts and their waits.
  const started = Date.now()
  await page.goto(`${base}/stream/S9?muted=1`)
  const stages = new Set()
  for (;;) {
    const s = await page.evaluate(() => window.notesdStream?.stage ?? null)
    stages.add(s)
    if (s === 'error') break
    check(Date.now() - started < 180_000, `SPENT: no error within 180 s (stages ${[...stages].join(',')})`)
    await page.waitForTimeout(250)
  }
  const elapsedS = Math.round((Date.now() - started) / 100) / 10
  const end = await page.evaluate(pageState)
  log(`SPENT end after ${elapsedS} s ${JSON.stringify(end)} loads ${fake.downLoads}`)
  check(stages.has('recovering'), 'SPENT: the page was recovering before it stopped')
  check(end.error === 'networkError manifestLoadError', `SPENT: the error is the manifest's network error (got ${end.error})`)
  check(end.alert.includes('Playback stopped (networkError manifestLoadError).'), `SPENT: the page says playback stopped (got ${end.alert})`)
  for (let n = 1; n <= LIMIT; n++) {
    check(end.log.some((l) => l.startsWith(`recovering ${n}/${LIMIT} after networkError manifestLoadError`)), `SPENT: the log has try ${n} of ${LIMIT}`)
  }
  check(elapsedS >= 40, `SPENT: the error came only after the waits of 2+4+8+16+16 s (after ${elapsedS} s)`)
  check(fake.downLoads >= LIMIT + 1, `SPENT: the manifest was asked for at least once per try (got ${fake.downLoads})`)
  await shot('spent')
  log(`SPENT PASS ${LIMIT} restarts over ${elapsedS} s, ${fake.downLoads} manifest loads, then "Playback stopped (networkError manifestLoadError)."`)
}

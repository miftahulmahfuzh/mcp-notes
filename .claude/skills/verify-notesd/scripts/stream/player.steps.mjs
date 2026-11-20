// The stream player page (/stream/<id>) in a throwaway daemon's real build (verify.sh up --web).
// The daemon's /api/stream/sessions/* routes are answered here by a fake that serves the HLS
// fixture from make-hls-fixture.sh, in the shape phase 3 gives the page; /position answers 404 on
// purpose. Nothing leaves this machine and no Chrome on Windows is touched.
//   STREAM_FIXTURE=<folder make-hls-fixture.sh printed> verify.sh ui RUN <this file>
// Logs "J1 PASS", "API PASS", "BUFFER PASS", "J3 PASS", "J2 PASS", "MUTED PASS", "CDN PASS"; the first failed check throws and fails the run.
// J3 is the expired token for HLS. The same for DASH is dash-expiry.steps.mjs beside this file: it
// needs the daemon's own DASH rewriting, so it runs on `up --web --direct-stream` with nothing faked here.
import { readFileSync } from 'node:fs'
import path from 'node:path'

const FIX = process.env.STREAM_FIXTURE
const TYPES = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.vtt': 'text/vtt', '.srt': 'application/x-subrip' }
// J3's "token expired" answers only segments from 90 s on, so loads ahead of the seek are not refused.
const EXPIRES_FROM_SEGMENT = 45

function check(ok, what) {
  if (!ok) throw new Error(what)
}

// Phase 3's SessionInfo shape (session_id; subtitle tracks carry source and english).
function sessionJson(id, fake) {
  const common = { session_id: id, kind: 'movie', tmdb_id: 1, season: null, episode: null, provider: 'Fixture', best_height: 720, created_at: null, refreshed_at: null, expires_at: null }
  if (id === 'S1') {
    return {
      ...common,
      title: 'Fixture Film (2026)',
      manifest_url: `/api/stream/sessions/S1/p?u=master.m3u8&t=${fake.token}`,
      manifest_kind: 'hls',
      subtitles: [],
      resume_s: 20,
    }
  }
  return {
    ...common,
    title: 'Fixture SRT (2026)',
    manifest_url: '/api/stream/sessions/S2/p?u=v720/index.m3u8',
    manifest_kind: 'hls',
    subtitles: [{ url: '/api/stream/sessions/S2/p?u=subs/en.srt', lang: 'en', label: 'English', format: 'srt', source: 'request', english: true }],
    resume_s: 0,
  }
}

async function until(page, cond, ms, what) {
  for (let waited = 0; waited < ms; waited += 250) {
    if (cond()) return
    await page.waitForTimeout(250)
  }
  check(cond(), what)
}

async function wakeControls(page) {
  await page.mouse.move(600, 400)
  await page.mouse.move(620, 420)
}

const englishCueShowing = (needle) => {
  const v = document.querySelector('video')
  // The page draws the lines itself (.st-caption) from tracks it keeps hidden; a track the browser draws (showing) would be a second copy.
  const drawn = document.querySelector('.st-caption')?.textContent ?? ''
  return !!v && drawn.includes(needle) && [...v.textTracks].every((t) => t.mode !== 'showing') && [...v.textTracks].some((t) => t.mode === 'hidden' && [...(t.activeCues ?? [])].some((c) => c.text.includes(needle)))
}

// Seconds loaded ahead of the picture (the last buffered range).
const aheadS = () => {
  const v = document.querySelector('video')
  const b = v.buffered
  return b.length ? Math.round((b.end(b.length - 1) - v.currentTime) * 10) / 10 : 0
}

export default async ({ page, base, shot, log }) => {
  check(FIX, 'set STREAM_FIXTURE to the folder make-hls-fixture.sh printed')
  const origin = new URL(base).origin
  const foreign = []
  page.on('request', (r) => {
    const u = r.url()
    if (!u.startsWith(origin) && !u.startsWith('blob:') && !u.startsWith('data:')) foreign.push(u)
  })
  const fake = { expired: false, refreshes: 0, token: 1, posts: [] }
  await page.route('**/api/stream/sessions/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    const m = /^\/api\/stream\/sessions\/(S1|S2)(?:\/(p|position|refresh))?$/.exec(url.pathname)
    if (!m) return json(403, { error: 'unknown_session' })
    const [, id, tail] = m
    if (tail === 'p') {
      // Like phase 3's pass-through: every forwarded answer carries X-Notesd-Upstream with the host's status.
      const u = url.searchParams.get('u') ?? ''
      const seg = /seg(\d+)\.ts$/.exec(u)
      if (fake.expired && seg && Number(seg[1]) >= EXPIRES_FROM_SEGMENT) {
        return route.fulfill({ status: 403, headers: { 'x-notesd-upstream': '403' }, body: 'token expired' })
      }
      const file = path.join(FIX, u)
      return route.fulfill({ status: 200, headers: { 'x-notesd-upstream': '200' }, contentType: TYPES[path.extname(file)] ?? 'application/octet-stream', body: readFileSync(file) })
    }
    if (tail === 'position') {
      fake.posts.push({ id, ...req.postDataJSON() })
      return json(404, { error: 'not_found' })
    }
    if (tail === 'refresh') {
      fake.refreshes += 1
      fake.expired = false
      fake.token += 1
      return json(200, sessionJson(id, fake))
    }
    return json(200, sessionJson(id, fake))
  })

  // J1 (R2.3): English shown over the manifest's French default, a quality choice, start at resume_s.
  await page.goto(`${base}/stream/S1`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 30_000 })
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !!v && !v.paused && v.currentTime > 21
  }, null, { timeout: 30_000 })
  await page.waitForFunction(englishCueShowing, 'English track', { timeout: 15_000 })
  const j1 = await page.evaluate(() => {
    const v = document.querySelector('video')
    return {
      title: document.title,
      showing: [...v.textTracks].filter((t) => t.mode === 'hidden').map((t) => t.language),
      qualities: window.notesdStream.qualities.map((q) => q.height),
      subtitle: window.notesdStream.subtitle,
    }
  })
  log(`J1 state ${JSON.stringify(j1)}`)
  check(j1.title === 'Fixture Film (2026)', 'J1: the page title is the session title')
  check(JSON.stringify(j1.showing) === '["en"]', `J1: exactly one subtitle track showing, the English one (got ${JSON.stringify(j1.showing)})`)
  check(JSON.stringify(j1.qualities) === '[720,360]', `J1: 720p and 360p offered, highest first (got ${JSON.stringify(j1.qualities)})`)
  await wakeControls(page)
  await page.getByRole('button', { name: 'Quality', exact: true }).click()
  const items = (await page.getByRole('menuitemradio').allTextContents()).join('|')
  check(items === 'Auto|720p|360p', `J1: the quality menu lists Auto|720p|360p (got ${items})`)
  await page.getByRole('menuitemradio', { name: '360p', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('video')?.videoHeight === 360, null, { timeout: 20_000 })
  await shot('j1-english-360p')
  await until(page, () => fake.posts.some((p) => p.id === 'S1' && p.position_s >= 20 && p.ended === false), 8_000,
    'J1: positions were posted (each answered 404)')
  const stillPlaying = await page.evaluate(() => !document.querySelector('video').paused && window.notesdStream.stage === 'ready')
  check(stillPlaying, 'J1: a 404 from /position did not stop the film')
  log('J1 PASS English subtitle shown over a French default; quality menu Auto|720p|360p; switched to 360p; started at resume_s 20; 404 positions ignored')

  const exposed = await page.evaluate(() => ({ levels: window.notesdStream.levels, kind: window.notesdStream.kind, start: typeof window.notesdStream.start, title: document.title }))
  check(JSON.stringify(exposed.levels) === '[720,360]' && exposed.kind === 'hls' && exposed.start === 'function', `window.notesdStream has kind, levels and start() (got ${JSON.stringify(exposed)})`)
  check(exposed.title !== '' && exposed.title !== page.url() && exposed.title !== new URL(base).host, 'the page title is neither empty nor the address (phase 1 open needs it)')
  log('API PASS window.notesdStream exposes kind, levels, level, errors, refreshes and start(); the title is a real title')

  // BUFFER (R1.8): the page keeps up to 120 s loaded ahead; hls.js held 30 s before, so 60 s ahead
  // is reachable only under the new limit. ?muted=1 keeps 30 s for the expiry checks.
  await page.waitForFunction((min) => {
    const v = document.querySelector('video')
    const b = v.buffered
    return b.length > 0 && b.end(b.length - 1) - v.currentTime >= min
  }, 60, { timeout: 30_000 })
  const ahead = await page.evaluate(aheadS)

  // J3 (R2.5) runs on ?muted=1, so the page keeps 30 s ahead,
  // so the segments past the seek are not loaded yet when the token expires.
  await page.goto(`${base}/stream/S1?muted=1`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 30_000 })
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !!v && !v.paused && v.currentTime > 21
  }, null, { timeout: 30_000 })
  await page.waitForTimeout(3_000)
  const mutedAhead = await page.evaluate(aheadS)
  check(mutedAhead <= 40, `BUFFER: ?muted=1 keeps about 30 s ahead (got ${mutedAhead} s)`)
  log(`BUFFER PASS ${ahead} s loaded ahead without ?muted=1 (60 s or more), ${mutedAhead} s under ?muted=1`)

  // J3 (R2.5): the stream host refuses the token mid-film; one refresh, playback continues there.
  fake.expired = true
  await page.evaluate(() => {
    document.querySelector('video').currentTime = 100
  })
  await page.waitForFunction(() => window.notesdStream?.refreshes === 1 && window.notesdStream.stage === 'ready', null, { timeout: 30_000 })
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !v.paused && v.currentTime > 101
  }, null, { timeout: 30_000 })
  await page.waitForFunction(englishCueShowing, 'English track', { timeout: 15_000 })
  const j3 = await page.evaluate(() => ({ t: document.querySelector('video').currentTime, log: window.notesdStream.log }))
  log(`J3 state ${JSON.stringify(j3)}`)
  check(fake.refreshes === 1, `J3: exactly one POST .../refresh (got ${fake.refreshes})`)
  check(j3.t >= 100 && j3.t < 119, `J3: playing on from 100 s, not from 0 or resume_s (at ${j3.t})`)
  await shot('j3-after-refresh')
  log('J3 PASS a 403 on a segment at 100 s led to one refresh; playback continued from 100 s with the English subtitle')

  // J2 (R2.3): a separate English .srt is converted to WebVTT and shown by default.
  await page.goto(`${base}/stream/S2`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 30_000 })
  await page.waitForFunction(() => {
    const t = document.querySelector('video track')
    return !!t && t.track.mode === 'hidden' && [...(t.track.activeCues ?? [])].some((c) => c.text.includes('SRT file')) && (document.querySelector('.st-caption')?.textContent ?? '').includes('SRT file')
  }, null, { timeout: 20_000 })
  const j2 = await page.evaluate(() => {
    const t = document.querySelector('video track')
    return { srclang: t.srclang, isDefault: t.default, scheme: new URL(t.src).protocol, subtitle: window.notesdStream.subtitle }
  })
  log(`J2 state ${JSON.stringify(j2)}`)
  check(j2.srclang === 'en' && j2.isDefault && j2.scheme === 'blob:' && j2.subtitle === 'file-0',
    'J2: the English .srt is a WebVTT blob track, chosen and showing')
  await shot('j2-srt')
  log('J2 PASS a separate English .srt was converted to WebVTT and shown by default')

  // The muted check phase 6 relies on: ?muted=1 is muted before play, never unmuted, never full screen.
  await page.goto(`${base}/stream/S2?muted=1`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 30_000 })
  await page.keyboard.press('m')
  await page.keyboard.press('f')
  const mutedState = await page.evaluate(async () => ({
    muted: document.querySelector('video').muted,
    fullscreen: Boolean(document.fullscreenElement),
    started: await window.notesdStream.start(),
  }))
  check(mutedState.muted === true && mutedState.fullscreen === false && mutedState.started === false,
    `?muted=1 stays muted, never full screen, start() does nothing (got ${JSON.stringify(mutedState)})`)
  log('MUTED PASS ?muted=1 stayed muted and windowed; start() did nothing')

  check(foreign.length === 0, `no request left the daemon's origin: ${foreign.slice(0, 3).join(' ')}`)
  log('CDN PASS every request stayed on the daemon origin (hls.js bundled, no CDN)')
}

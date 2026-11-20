// The subtitle and the seek preview box never cover each other: in a throwaway daemon's real page build
// (verify.sh up --web), against routes faked here as the player's contract fixes them (the session, its
// pass-through serving the HLS fixture film of make-hls-fixture.sh, /position, /previews and one sheet).
// A subtitle track with one long cue is added to the video, so the caption comes through the page's own
// path (text track -> controller -> .st-caption). Nothing leaves this machine.
//   STREAM_FIXTURE=<folder make-hls-fixture.sh printed> verify.sh ui RUN <this file>
// Logs "CAPTION PASS".
import { readFileSync } from 'node:fs'
import path from 'node:path'

const FIX = process.env.STREAM_FIXTURE
const TYPES = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.vtt': 'text/vtt' }
const SHEET = '/api/stream/sessions/S1/previews/sheet-a.svg'
// Six 240 x 135 frames side by side: frame i stands for [10 i, 10 i + 10) s.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="135">${[0, 1, 2, 3, 4, 5]
  .map((i) => `<rect x="${i * 240}" y="0" width="240" height="135" fill="${i % 2 ? '#4a7ab0' : '#e9c46a'}"/>`)
  .join('')}</svg>`
// Frames for the first 60 s only: a hover past that shows the time alone.
const PREVIEWS = { state: 'partial', rev: 0, source: 'local', cues: [0, 1, 2, 3, 4, 5].map((i) => ({ start_s: i * 10, end_s: i * 10 + 10, url: SHEET, x: i * 240, y: 0, w: 240, h: 135 })) }
const SESSION = {
  session_id: 'S1', kind: 'movie', tmdb_id: 1, season: null, episode: null, provider: 'Fixture', best_height: 720,
  created_at: null, refreshed_at: null, expires_at: null, title: 'Fixture Film (2026)',
  manifest_url: '/api/stream/sessions/S1/p?u=v720/index.m3u8', manifest_kind: 'hls', subtitles: [], resume_s: 0,
  subtitle_rev: 0, source_rev: 0, preview_rev: 0,
}

function check(ok, what) {
  if (!ok) throw new Error(what)
}

// Where the caption's lines and the box are, in the page.
const measure = () => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom } }
  const box = document.querySelector('[data-testid="seek-preview"]')
  const lines = [...document.querySelectorAll('[data-testid="caption"] span')].map(rect)
  const stage = rect(document.querySelector('.st-stage'))
  return { box: box ? rect(box) : null, frame: !!box?.querySelector('.st-preview-frame'), lines, stage }
}
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

export default async ({ page, base, shot, log }) => {
  check(FIX, 'set STREAM_FIXTURE to the folder make-hls-fixture.sh printed')
  await page.route('**/api/stream/sessions/**', async (route) => {
    const url = new URL(route.request().url())
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (url.pathname === '/api/stream/sessions/S1') return json(200, SESSION)
    if (url.pathname === '/api/stream/sessions/S1/p') {
      const file = path.join(FIX, url.searchParams.get('u') ?? '')
      return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] ?? 'application/octet-stream', body: readFileSync(file) })
    }
    if (url.pathname === '/api/stream/sessions/S1/position') return json(200, { ok: true, play_id: 'p1', ended: false, subtitle_rev: 0, source_rev: 0, preview_rev: 0 })
    if (url.pathname === '/api/stream/sessions/S1/previews') return json(200, PREVIEWS)
    if (url.pathname === SHEET) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: SVG })
    return json(404, { error: 'not_found' })
  })
  const hoverAt = async (t) => {
    const b = await page.locator('.st-seek').boundingBox()
    check(b, 'the timeline is on the page')
    const d = await page.evaluate(() => document.querySelector('video').duration)
    await page.mouse.move(b.x + 5.5 + ((b.width - 11) * t) / d, b.y + b.height / 2)
  }

  await page.goto(`${base}/stream/S1?muted=1`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 30_000 })
  await page.waitForFunction(() => { const v = document.querySelector('video'); return !!v && !v.paused && v.currentTime > 1 && v.duration > 100 }, null, { timeout: 30_000 })
  // Two lines for the whole film, through the page's own caption path.
  await page.evaluate(() => {
    const track = document.querySelector('video').addTextTrack('subtitles', 'English', 'en')
    track.mode = 'hidden'
    track.addCue(new VTTCue(0, 600, 'A subtitle long enough to reach under the box,\nand a second line of it.'))
  })
  await page.waitForSelector('[data-testid="caption"] span', { timeout: 10_000 })

  // The pointer is on the stage but off the timeline: the caption is where it always is.
  await page.mouse.move(400, 300)
  const rest = await page.evaluate(measure)
  check(rest.box === null && rest.lines.length === 2, 'before the hover: two caption lines and no box')

  // The middle of the film's first minute, under the centred caption: a frame, and the caption above it.
  const d = await page.evaluate(() => document.querySelector('video').duration)
  await hoverAt(d / 2 > 55 ? 55 : d / 2)
  await page.waitForSelector('[data-testid="seek-preview"] .st-preview-frame', { timeout: 5_000 })
  const framed = await page.evaluate(measure)
  await shot('caption-above-frame')
  log(`framed ${JSON.stringify(framed)}`)
  check(framed.lines.length === 2 && framed.lines.every((l) => !overlaps(l, framed.box)), 'with a frame: no caption line touches the box')
  check(framed.lines.every((l) => l.bottom <= framed.box.top && l.top >= framed.stage.top), 'with a frame: the caption sits above the box, inside the stage')
  check(framed.lines[1].bottom < rest.lines[1].bottom, 'with a frame: the caption moved up')

  // Straight under the caption's centre, wherever a frame exists or not: still no line touches the box.
  await hoverAt(d / 2)
  await page.waitForFunction(() => document.querySelector('[data-testid="seek-preview"]') !== null, null, { timeout: 5_000 })
  const centre = await page.evaluate(measure)
  await shot('caption-above-centre')
  log(`centre ${JSON.stringify(centre)}`)
  check(centre.lines.every((l) => !overlaps(l, centre.box)), 'under the caption: no caption line touches the box')

  // Off the timeline: the box goes and the caption is back where it was.
  await page.mouse.move(400, 300)
  await page.waitForFunction(() => document.querySelector('[data-testid="seek-preview"]') === null, null, { timeout: 5_000 })
  const back = await page.evaluate(measure)
  check(Math.abs(back.lines[1].bottom - rest.lines[1].bottom) < 1, `after the hover: the caption is back (${back.lines[1].bottom} vs ${rest.lines[1].bottom})`)
  log('CAPTION PASS')
}

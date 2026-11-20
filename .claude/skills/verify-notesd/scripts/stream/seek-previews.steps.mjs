// Seek previews end to end (seek-preview-thumbnails phase 5): on a throwaway daemon with torrents on, the real
// page plays a film from the stream cache and a film from a torrent; the daemon makes their preview sheets with
// this machine's ffmpeg; the pointer rests on the timeline; the frame the page shows must be ffmpeg's frame of
// that time (within one preview interval), and the frame of a far-away time must not match it.
//   FIX=$(bash .claude/skills/verify-notesd/scripts/stream/make-preview-film.sh "$HOME/.local/state/notesd-verify/.preview-film")
//   NOTESD_STREAM_PREVIEWS=on TORRENT_FIXTURE_FILE="$FIX/film.mp4" verify.sh up --web --torrent   (note RUN and DIRECT=)
//   DIRECT=<that path> PREVIEW_FILM="$FIX" verify.sh ui RUN .claude/skills/verify-notesd/scripts/stream/seek-previews.steps.mjs
// PREVIEW_ONLY=cache or PREVIEW_ONLY=torrent runs one of the two journeys. Chromium here, never the owner's
// streaming Chrome; the stream host is the fixture host and the swarm the loopback seeder.
// Logs "SEEK PREVIEW CACHE 125 PASS", "SEEK PREVIEW CACHE 487 PASS", "SEEK PREVIEW TORRENT 125 PASS" and
// "SEEK PREVIEW TORRENT 487 PASS", each with the distances it judged; the first failed check throws.
import { spawnSync } from 'node:child_process'
import { existsSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DIRECT = process.env.DIRECT
const FIX = process.env.PREVIEW_FILM
const ONLY = process.env.PREVIEW_ONLY ?? ''
/** The size every picture is compared at, grey. */
const W = 128
const H = 72
const PX = W * H
/** The reference frames are ffmpeg's, one every GRID_S seconds of the film. */
const GRID_S = 2
/** Where the pointer rests: one time in each of the film's two sheets (0-360 s, 360-600 s). */
const AT = [125, 487]
/** How far the time the box shows may be from the time the pointer was put at (the thumb's inset, a pixel's worth). */
const POINTER_SLACK_S = 5
/** The cached film's title and the torrent film's: two titles the harness's fake TMDB knows (a position report of any other answers 404 unknown_title, and no sheet is made for a session that never reports). */
const CACHE_TITLE = 990001
const TORRENT_TITLE = 467905

function check(ok, what) {
  if (!ok) throw new Error(what)
}

async function until(page, cond, ms, what) {
  for (let waited = 0; waited < ms; waited += 1000) {
    if (await cond()) return
    await page.waitForTimeout(1000)
  }
  check(await cond(), what)
}

/** ffmpeg's output as W×H grey pictures, one after another. */
function grey(inputArgs, filters, input) {
  const vf = [...filters, `scale=${W}:${H}:flags=area`, 'format=gray'].join(',')
  const res = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', ...inputArgs, '-vf', vf, '-f', 'rawvideo', 'pipe:1'], {
    input,
    maxBuffer: 256 * 1024 * 1024,
  })
  check(res.status === 0, `ffmpeg failed: ${String(res.stderr ?? res.error)}`)
  return res.stdout
}

/** The film's own frames: frames[k] is the frame at k·GRID_S seconds. */
function filmFrames(film) {
  const raw = grey(['-i', film], [`fps=1/${GRID_S}`])
  const frames = []
  for (let at = 0; at + PX <= raw.length; at += PX) frames.push(raw.subarray(at, at + PX))
  return frames
}

/** A PNG screenshot as one W×H grey picture. */
const pictureOf = (png) => grey(['-i', 'pipe:0'], [], png).subarray(0, PX)

/** Mean absolute difference of two grey pictures, 0 to 255. */
function mad(a, b) {
  let sum = 0
  for (let i = 0; i < PX; i++) sum += Math.abs(a[i] - b[i])
  return sum / PX
}

/** "2:05" or "1:02:05" to seconds. */
function seconds(text) {
  const parts = text.trim().split(':').map(Number)
  check(parts.length >= 2 && parts.every(Number.isFinite), `the box's time reads "${text}"`)
  return parts.reduce((s, p) => s * 60 + p, 0)
}

/** Rests the pointer on the timeline at `t` and returns the time the box shows and a screenshot of its frame. */
async function hoverAt(page, t, duration) {
  const seek = await page.locator('.st-seek').boundingBox()
  check(seek !== null, 'the timeline is not on the page')
  const x = seek.x + (seek.width * t) / duration
  const y = seek.y + seek.height / 2
  await page.mouse.move(x - 40, y - 80)
  await page.mouse.move(x, y, { steps: 6 })
  const frame = page.locator('.st-preview .st-preview-frame')
  for (let waited = 0; !(await frame.isVisible()); waited += 400) {
    check(waited < 8_000, `no frame shows over the timeline at ${t} s (the box: "${await page.locator('.st-preview').innerText().catch(() => 'none')}")`)
    // The controls hide 2.5 s after the mouse last moved, and the box with them: a pixel's move keeps them up.
    await page.mouse.move(x + ((waited / 400) % 2), y)
    await page.waitForTimeout(400)
  }
  await page.waitForTimeout(250)
  const shown = seconds(await page.locator('.st-preview .st-preview-time').innerText())
  const png = await frame.screenshot()
  return { shown, png }
}

/** The frame on screen against ffmpeg's frames: the closest must be within one interval of `shown`, the far one must not match. */
function judge(label, frames, cues, duration, shown, png) {
  // The page's own list (phase 4's Previews): its cues are { startS, endS, url, x, y, w, h }.
  const cue = cues.find((c) => c.startS <= shown && shown < c.endS)
  check(cue !== undefined, `${label}: the session's previews hold no frame for ${shown} s`)
  const interval = cue.endS - cue.startS
  const pic = pictureOf(png)
  const dist = frames.map((f) => mad(pic, f))
  let best = 0
  for (let k = 1; k < dist.length; k++) if (dist[k] < dist[best]) best = k
  const bestS = best * GRID_S
  const near = Math.min(...dist.filter((_, k) => Math.abs(k * GRID_S - shown) <= interval + GRID_S))
  const farS = (shown + duration / 2) % duration
  const far = dist[Math.min(Math.round(farS / GRID_S), dist.length - 1)]
  check(
    Math.abs(bestS - shown) <= interval + GRID_S,
    `${label}: the frame shown at ${shown} s looks most like ${bestS} s of the film (difference ${dist[best].toFixed(1)}), more than ${interval} s away`,
  )
  check(
    far >= 3 * Math.max(near, 1) && far >= 8,
    `${label}: the control failed: the frame of ${Math.round(farS)} s (difference ${far.toFixed(1)}) is about as close as the frame of ${shown} s (${near.toFixed(1)})`,
  )
  return `closest ${bestS} s (difference ${dist[best].toFixed(1)}), within ${interval} s; control ${Math.round(farS)} s at ${far.toFixed(1)}`
}

/** Opens the session's page, waits for its whole previews from this machine, and judges two hovers. */
async function watch(page, base, sid, label, frames, shot, log, torrent) {
  await page.goto(`${base}/stream/${sid}`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 60_000 })
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !!v && !v.paused && v.currentTime > 2
  }, null, { timeout: 60_000 })
  if (torrent) {
    await until(page, () => page.evaluate(() => window.notesdStream?.torrent?.state === 'ready'), 300_000, `${label}: the torrent's download completes`)
  }
  // No reload: the page takes the new frames on the preview_rev of its position reports.
  await until(page, () => page.evaluate(() => window.notesdStream?.previews?.state === 'ready'), 300_000, `${label}: the page's previews reach "ready" (it holds ${JSON.stringify(await page.evaluate(() => window.notesdStream?.previews?.state ?? null))})`)
  const previews = await page.evaluate(() => JSON.parse(JSON.stringify(window.notesdStream.previews)))
  check(previews.source === 'local', `${label}: the previews' source is ${previews.source}, not local`)
  check(previews.cues.length > 0 && previews.cues.every((c) => c.url.startsWith(`/api/stream/sessions/${sid}/previews/`)), `${label}: a cue's picture is not one of this daemon's sheets: ${JSON.stringify(previews.cues[0])}`)
  const duration = await page.evaluate(() => document.querySelector('video').duration)
  check(Math.abs(duration - 600) < 2, `${label}: the film is ${duration} s long, not the fixture's 600 s`)
  for (const at of AT) {
    const { shown, png } = await hoverAt(page, at, duration)
    await shot(`preview-${label}-${at}`)
    check(Math.abs(shown - at) <= POINTER_SLACK_S, `${label}: the pointer at ${at} s shows ${shown} s`)
    const verdict = judge(label, frames, previews.cues, duration, shown, png)
    log(`SEEK PREVIEW ${label.toUpperCase()} ${at} PASS: the box shows ${shown} s; ${verdict}`)
  }
  await page.mouse.move(10, 10)
}

export default async ({ page, base, shot, log }) => {
  check(DIRECT && existsSync(path.join(DIRECT, 'upstream.json')), 'set DIRECT to the path `verify.sh up --web --torrent` printed')
  check(FIX && existsSync(path.join(FIX, 'film.mp4')) && existsSync(path.join(FIX, 'hls', 'master.m3u8')), 'set PREVIEW_FILM to the folder make-preview-film.sh printed')
  const origin = new URL(base).origin
  const frames = filmFrames(path.join(FIX, 'film.mp4'))
  check(frames.length >= 295, `ffmpeg gave ${frames.length} reference frames of the film, not 300`)

  const outside = []
  page.on('request', (req) => {
    if (new URL(req.url()).origin !== origin) outside.push(req.url())
  })

  if (ONLY !== 'torrent') {
    // The cloud film into this machine's stream cache: the fixture host serves it in mode hls_film.
    if (!existsSync(path.join(DIRECT, 'film'))) symlinkSync(path.join(FIX, 'hls'), path.join(DIRECT, 'film'))
    writeFileSync(path.join(DIRECT, 'token'), '1')
    writeFileSync(path.join(DIRECT, 'mode'), 'hls_film')
    const made = await page.request.post(`${base}/api/stream/cache`, { headers: { origin }, data: { kind: 'movie', tmdb_id: CACHE_TITLE }, timeout: 120_000 })
    check(made.ok(), `POST /api/stream/cache answered ${made.status()}: ${await made.text()}`)
    const cacheId = (await made.json()).cache.id
    const cacheState = async () => (await (await page.request.get(`${base}/api/stream/cache/${cacheId}`, { headers: { origin } })).json()).state
    await until(page, async () => (await cacheState()) === 'ready', 180_000, `the cache ${cacheId} is ready (it is ${await cacheState()})`)
    // Nothing resolves from here: the play is the cache's.
    writeFileSync(path.join(DIRECT, 'mode'), 'no_source')
    const played = await page.request.post(`${base}/api/stream/play`, { headers: { origin }, data: { kind: 'movie', tmdb_id: CACHE_TITLE }, timeout: 120_000 })
    check(played.ok(), `POST /api/stream/play answered ${played.status()}: ${await played.text()}`)
    const session = (await played.json()).session
    check(session?.cached?.state === 'ready', `the play is not from the ready cache: ${JSON.stringify(session?.cached)}`)
    await watch(page, base, session.session_id, 'cache', frames, shot, log, false)
  }

  if (ONLY !== 'cache') {
    // The same film as a torrent's file, seeded over loopback (TORRENT_FIXTURE_FILE); Chrome plays it as is.
    const played = await page.request.post(`${base}/api/stream/play`, { headers: { origin }, data: { kind: 'movie', tmdb_id: TORRENT_TITLE, provider: 'torrent' }, timeout: 150_000 })
    check(played.ok(), `POST /api/stream/play answered ${played.status()}: ${await played.text()}`)
    const session = (await played.json()).session
    check(typeof session?.torrent?.info_hash === 'string', `the play is not a torrent's: ${JSON.stringify(session?.torrent)}`)
    check(session.manifest_kind === 'mp4', `the torrent plays as ${session.manifest_kind}, not as its file: was TORRENT_FIXTURE_FILE set to film.mp4?`)
    await watch(page, base, session.session_id, 'torrent', frames, shot, log, true)
  }

  check(outside.length === 0, `the page asked another origin: ${outside.slice(0, 5).join(' ')}`)
}

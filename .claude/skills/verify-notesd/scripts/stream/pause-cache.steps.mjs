// A pause caches the film and the timeline shows it, end to end on a throwaway daemon
// (verify.sh up --web --direct-stream): the real player page and hls.js, the daemon's pass-through,
// stream cache and file route, the fake resolver (mode hls_film) and the fixture stream host
// serving a playable 300 s HLS film. Chromium here, never the owner's streaming Chrome; nothing
// leaves this machine.
//   FIX=$(bash .claude/skills/verify-notesd/scripts/stream/make-hls-film.sh "$HOME/.local/state/notesd-verify/.stream-fixture-hls-film")
//   DIRECT=<the DIRECT= path `up` printed> HLS_FILM="$FIX" verify.sh ui RUN <this file>
// Logs "BAR PASS", "PAUSE CACHE PASS", "CACHE BAR PASS", "CACHE PLAY PASS"; the first failed check
// throws and fails the run.
import { existsSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DIRECT = process.env.DIRECT
const FIX = process.env.HLS_FILM

function check(ok, what) {
  if (!ok) throw new Error(what)
}

/** How far the timeline's thick grey bar reaches, in percent of the film (0 without one). */
const loadedTo = (page) =>
  page.evaluate(() => {
    const bar = document.querySelector('.st-seek').style.getPropertyValue('--st-loaded-bar')
    const stops = [...bar.matchAll(/var\(--st-loaded\) ([\d.]+)%/g)].map((m) => Number(m[1]))
    return stops.length === 0 ? 0 : Math.max(...stops)
  })

export default async ({ page, base, shot, log }) => {
  check(DIRECT && existsSync(path.join(DIRECT, 'upstream.json')), 'set DIRECT to the path `verify.sh up --direct-stream` printed')
  check(FIX && existsSync(path.join(FIX, 'master.m3u8')), 'set HLS_FILM to the folder make-hls-film.sh printed')
  if (!existsSync(path.join(DIRECT, 'film'))) symlinkSync(FIX, path.join(DIRECT, 'film'))
  writeFileSync(path.join(DIRECT, 'token'), '1')
  writeFileSync(path.join(DIRECT, 'mode'), 'hls_film')
  const origin = new URL(base).origin
  const get = async (route) => (await page.request.get(`${base}${route}`, { headers: { origin } })).json()

  const played = await page.request.post(`${base}/api/stream/play`, { headers: { origin }, data: { kind: 'movie', tmdb_id: 550 } })
  check(played.ok(), `POST /api/stream/play answered ${played.status()}`)
  const sid = (await played.json()).session.session_id

  const seen = { through: 0, local: 0, asks: [] }
  page.on('request', (req) => {
    const u = new URL(req.url())
    if (/^\/api\/stream\/sessions\/[^/]+\/p$/.test(u.pathname)) seen.through += 1
    if (/^\/api\/stream\/cache\/[^/]+\/f\//.test(u.pathname)) seen.local += 1
    if (req.method() === 'POST' && u.pathname.endsWith(`/sessions/${sid}/cache`)) seen.asks.push(req.postData())
  })

  await page.goto(`${base}/stream/${sid}`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 30_000 })
  // Chromium refuses sound without a gesture: the page plays muted, which is still a play.
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !!v && !v.paused && v.currentTime > 4
  }, null, { timeout: 30_000 })
  await page.mouse.move(400, 400)
  const before = await loadedTo(page)
  check(before > 5 && before < 80, `while it streams the grey bar shows what the browser holds, not the whole film (to ${before}%)`)
  check(seen.asks.length === 0, 'nothing asks for a cache while the film plays')
  await shot('streaming-bar')
  log(`BAR PASS streaming: loaded to ${before}% of the film, no cache asked`)

  // The owner pauses, and waits.
  await page.getByRole('button', { name: 'Pause' }).click()
  const pausedAt = await page.evaluate(() => document.querySelector('video').currentTime)
  await page.waitForFunction(() => window.notesdStream?.cached != null && window.notesdStream.stage === 'ready', null, { timeout: 30_000 })
  // The picture comes back at the same place once the first local segment is in.
  await page.waitForFunction((at) => Math.abs(document.querySelector('video').currentTime - at) < 1 && document.querySelector('video').readyState >= 2, pausedAt, { timeout: 15_000 }).catch(() => {})
  const moved = await page.evaluate(() => ({ cached: window.notesdStream.cached, log: window.notesdStream.log, paused: document.querySelector('video').paused, t: document.querySelector('video').currentTime }))
  log(`PAUSE CACHE state ${JSON.stringify(moved)}`)
  check(JSON.parse(seen.asks[0] ?? '{}').start === true, 'two seconds into the pause the page asked the daemon to cache the film')
  check(moved.paused && Math.abs(moved.t - pausedAt) < 1, `the film is still paused where it was (${pausedAt} s, now ${moved.t} s)`)
  check(moved.log.some((line) => /^paused: caching on this machine/.test(line)) && moved.log.some((line) => /^from cache [0-9a-f]{8} \((downloading|ready)\) at /.test(line)), 'the page log says it cached and moved')
  const session = await get(`/api/stream/sessions/${sid}`)
  const cacheId = moved.cached.id
  check(session.cached?.id === cacheId && session.manifest_url === `/api/stream/cache/${cacheId}/f/master.m3u8`, 'the same session now names the cache and its local playlist')
  const cache = await get(`/api/stream/cache/${cacheId}`)
  check(cache.auto === true, 'the cache is marked auto: it clears itself')
  log(`PAUSE CACHE PASS session ${sid.slice(0, 6)} moved onto cache ${cacheId.slice(0, 8)} (auto), still paused at ${Math.round(moved.t)} s`)

  // The download goes on while it is paused; the bar follows it to the end.
  await page.waitForFunction(() => window.notesdStream?.cached?.state === 'ready', null, { timeout: 60_000 })
  await page.mouse.move(420, 420)
  await page.waitForFunction(() => /var\(--st-loaded\) 100%/.test(document.querySelector('.st-seek').style.getPropertyValue('--st-loaded-bar')), null, { timeout: 15_000 })
  const map = await get(`/api/stream/cache/${cacheId}/map`)
  const files = readdirSync(path.join(path.dirname(DIRECT), 'data', 'movies', 'stream-cache', cacheId)).filter((f) => /^v-\d+\.ts$/.test(f)).length
  check(map.ranges.length === 1 && map.ranges[0][0] === 0 && Math.abs(map.ranges[0][1] - 300) < 3, `the map says the whole film is on disk (got ${JSON.stringify(map)})`)
  check(files === 150, `150 segments are in the cache folder (got ${files})`)
  check(await page.locator('.st-top .st-cached').isVisible(), 'the cache mark shows beside the title')
  await shot('cached-bar')
  log(`CACHE BAR PASS the grey bar went from ${before}% to 100% while paused; ${files} segments on disk`)

  // Play: from the local files, and nothing more through the pass-through.
  const throughBefore = seen.through
  await page.getByRole('button', { name: 'Play' }).click()
  await page.waitForFunction((from) => {
    const v = document.querySelector('video')
    return !v.paused && v.currentTime > from + 3
  }, pausedAt, { timeout: 30_000 })
  check(seen.local > 0 && seen.through === throughBefore, `it plays from the cache's file route with no pass-through request (local ${seen.local}, through +${seen.through - throughBefore})`)
  check((await page.evaluate(() => window.notesdStream.errors)).length === 0, 'no error on the page')
  log(`CACHE PLAY PASS playing on from ${Math.round(pausedAt)} s from disk (${seen.local} local requests)`)
}

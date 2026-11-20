// A play survives a daemon restart, and a cached play that keeps stalling goes back to the live stream, in
// the real player page (hls.js) on a `verify.sh up --web --direct-stream` run. The film is make-hls-film.sh's
// (300 s, served by the fixture stream host under a token, handed out by the fake resolver in mode hls_film).
// The daemon is restarted with `verify.sh restart RUN --gap S`: same port, same database, sessions gone.
//   FIX=$(bash .claude/skills/verify-notesd/scripts/stream/make-hls-film.sh "$HOME/.local/state/notesd-verify/.stream-fixture-hls-film")
//   DIRECT=<run>/direct HLS_FILM="$FIX" verify.sh ui RUN .claude/skills/verify-notesd/scripts/stream/restart.steps.mjs
// Logs "RESTART PASS" (the page says "Reconnecting to notesd…" while the daemon is down, asks
// POST /api/stream/continue, moves to a new session id and plays on from where it was), "RELOAD PASS" (the
// tab left the page, the daemon restarted, the page's address opened again: it carries the play on from the
// tab's memory) and "CACHE LEAVE PASS" (a play moved onto its pause cache whose segments never arrive stalls
// three times, asks /source with leave_cache, and plays on through the pass-through). About three minutes.
import { spawn } from 'node:child_process'
import { existsSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIRECT = process.env.DIRECT
const FIX = process.env.HLS_FILM
const VERIFY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'verify.sh')

function check(ok, what) {
  if (!ok) throw new Error(what)
}

/** verify.sh restart RUN --gap S, without blocking the page's event loop; resolves with its output. */
function restart(gapS) {
  const run = path.basename(path.dirname(DIRECT))
  return new Promise((resolve, reject) => {
    const child = spawn(VERIFY, ['restart', run, '--gap', String(gapS)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`verify.sh restart exited ${code}: ${out}`))))
  })
}

const state = (page) =>
  page.evaluate(() => {
    const v = document.querySelector('video')
    return {
      path: location.pathname,
      stage: window.notesdStream?.stage ?? null,
      t: v?.currentTime ?? 0,
      paused: v?.paused ?? null,
      cached: window.notesdStream?.cached ?? null,
      errors: window.notesdStream?.errors ?? [],
      log: (window.notesdStream?.log ?? []).slice(-12),
    }
  })

const sidOf = (p) => p.replace(/^\/stream\//, '')

export default async ({ page, base, shot, log }) => {
  check(DIRECT && existsSync(path.join(DIRECT, 'upstream.json')), 'set DIRECT to the path `verify.sh up --direct-stream` printed')
  check(FIX && existsSync(path.join(FIX, 'master.m3u8')), 'set HLS_FILM to the folder make-hls-film.sh printed')
  if (!existsSync(path.join(DIRECT, 'film'))) symlinkSync(FIX, path.join(DIRECT, 'film'))
  writeFileSync(path.join(DIRECT, 'token'), '1')
  writeFileSync(path.join(DIRECT, 'mode'), 'hls_film')
  const origin = new URL(base).origin

  const seen = { continues: [], sources: [], through: 0, local: 0 }
  page.on('request', (req) => {
    const u = new URL(req.url())
    if (req.method() === 'POST' && u.pathname === '/api/stream/continue') seen.continues.push(req.postDataJSON())
    if (req.method() === 'POST' && /^\/api\/stream\/sessions\/[^/]+\/source$/.test(u.pathname)) seen.sources.push(req.postDataJSON())
    if (/^\/api\/stream\/sessions\/[^/]+\/p$/.test(u.pathname)) seen.through += 1
    if (/^\/api\/stream\/cache\/[^/]+\/f\/.+\.ts$/.test(u.pathname)) seen.local += 1
  })

  const played = await page.request.post(`${base}/api/stream/play`, { headers: { origin }, data: { kind: 'movie', tmdb_id: 550 } })
  check(played.ok(), `POST /api/stream/play answered ${played.status()}`)
  const sid1 = (await played.json()).session.session_id

  // RESTART: the film plays; the daemon goes away for 12 s and comes back with no sessions.
  await page.goto(`${base}/stream/${sid1}`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 30_000 })
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !!v && !v.paused && v.currentTime > 12
  }, null, { timeout: 40_000 })
  const before = await state(page)
  const restarting = restart(12)
  await page.getByText('Reconnecting to notesd…').waitFor({ timeout: 30_000 })
  const during = await state(page)
  await shot('reconnecting')
  log(`RESTART during the gap: ${JSON.stringify(during)}`)
  log(`RESTART ${await restarting}`)
  await page.waitForFunction((old) => location.pathname !== `/stream/${old}` && window.notesdStream?.stage === 'ready', sid1, { timeout: 60_000 })
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !!v && !v.paused && v.readyState >= 3
  }, null, { timeout: 30_000 })
  const after = await state(page)
  const sid2 = sidOf(after.path)
  log(`RESTART after: ${JSON.stringify(after)} continues ${JSON.stringify(seen.continues)}`)
  check(seen.continues.length >= 1, 'the page asked POST /api/stream/continue')
  const asked = seen.continues.at(-1)
  check(asked.session_id === sid1 && asked.tmdb_id === 550 && asked.position_s >= before.t, `the continue named the old session, the title and the position (${JSON.stringify(asked)})`)
  check(/^[A-Za-z0-9_-]{32}$/.test(sid2) && sid2 !== sid1, `the address moved to a new session id (${after.path})`)
  check(after.t >= before.t && after.t < asked.position_s + 15, `it plays on from where it was (before the restart ${before.t.toFixed(1)} s, asked at ${asked.position_s} s, now ${after.t.toFixed(1)} s)`)
  check(after.log.some((l) => /carried on in session/.test(l)), 'the page log says it carried on')
  const gone = await page.request.get(`${base}/api/stream/sessions/${sid1}`)
  check(gone.status() === 403, `the old session is gone from the restarted daemon (${gone.status()})`)
  await shot('carried-on')
  log(`RESTART PASS ${sid1.slice(0, 6)} -> ${sid2.slice(0, 6)}, "Reconnecting to notesd…" shown, playing on at ${after.t.toFixed(1)} s (was ${before.t.toFixed(1)} s)`)

  // RELOAD: the tab leaves the page, the daemon restarts, the tab opens the page's address again.
  await page.waitForFunction(() => document.querySelector('video').currentTime > 0 && window.notesdStream?.stage === 'ready', null, { timeout: 20_000 })
  await page.waitForTimeout(6_000) // one position report under the new session
  const left = await state(page)
  await page.goto('about:blank')
  log(`RELOAD ${await restart(0)}`)
  const continuesBefore = seen.continues.length
  await page.goto(`${base}/stream/${sid2}`)
  await page.waitForFunction((old) => location.pathname !== `/stream/${old}` && window.notesdStream?.stage === 'ready', sid2, { timeout: 60_000 })
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2, null, { timeout: 30_000 })
  const reloaded = await state(page)
  const sid3 = sidOf(reloaded.path)
  log(`RELOAD after: ${JSON.stringify(reloaded)} continue ${JSON.stringify(seen.continues.at(-1))}`)
  check(seen.continues.length > continuesBefore && seen.continues.at(-1).session_id === sid2, 'the reopened page asked POST /api/stream/continue for its old session')
  check(sid3 !== sid2 && Math.abs(reloaded.t - left.t) < 10, `the reopened page plays on near ${left.t.toFixed(1)} s in a new session (now ${reloaded.t.toFixed(1)} s)`)
  await shot('reloaded')
  log(`RELOAD PASS ${sid2.slice(0, 6)} -> ${sid3.slice(0, 6)} at ${reloaded.t.toFixed(1)} s (left at ${left.t.toFixed(1)} s)`)

  // CACHE LEAVE: the cache's segments never arrive; the page pauses, moves onto the cache, plays, stalls.
  await page.route(/\/api\/stream\/cache\/[^/]+\/f\/.+\.ts$/, () => {}) // held: never answered
  const pausedAt = await page.evaluate(() => document.querySelector('video').currentTime)
  await page.getByRole('button', { name: 'Pause' }).click()
  await page.waitForFunction(() => window.notesdStream?.cached != null, null, { timeout: 30_000 })
  const onCache = await state(page)
  log(`CACHE LEAVE on the cache: ${JSON.stringify(onCache)}`)
  const throughBefore = seen.through
  await page.getByRole('button', { name: 'Play' }).click()
  await page.waitForFunction(() => window.notesdStream?.cached == null && (window.notesdStream?.log ?? []).some((l) => /leaving the cache for the live stream/.test(l)), null, { timeout: 90_000 })
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !v.paused && v.readyState >= 3 && window.notesdStream?.stage === 'ready'
  }, null, { timeout: 30_000 })
  const left2 = await state(page)
  const session = await (await page.request.get(`${base}/api/stream/sessions/${sid3}`, { headers: { origin } })).json()
  log(`CACHE LEAVE after: ${JSON.stringify(left2)} sources ${JSON.stringify(seen.sources)} session.cached ${JSON.stringify(session.cached)}`)
  check(seen.sources.some((b) => b?.leave_cache === true), 'the page asked /source with leave_cache: true')
  check(session.cached === null && /\/p\?u=/.test(session.manifest_url), `the session is back on the live stream (${session.manifest_url})`)
  check(seen.through > throughBefore, 'the film loads through the pass-through again')
  check(left2.log.some((l) => /stalled at/.test(l)), 'the page counted its stalls on the cache')
  // Where it froze: the pause when no cache segment ever came in, else the end of what the page held.
  const stalledAt = Number(/stalled at ([\d.]+) s/.exec(left2.log.filter((l) => /stalled at/.test(l)).at(-1))[1]) || pausedAt
  check(Math.abs(left2.t - stalledAt) < 10, `it plays on from where it froze (paused at ${pausedAt.toFixed(1)} s, stalled at ${stalledAt} s, now ${left2.t.toFixed(1)} s)`)
  await shot('left-cache')
  log(`CACHE LEAVE PASS stalls on cache ${onCache.cached.id.slice(0, 8)} -> live stream at ${left2.t.toFixed(1)} s (${seen.through - throughBefore} pass-through loads, ${seen.local} cache segment asks held)`)
}

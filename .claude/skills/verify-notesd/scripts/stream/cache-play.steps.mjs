// Playing from the stream cache in the real player page, on a `verify.sh up --web --direct-stream` run
// (STREAM_CACHE_AND_BUG_REPORT phase 6). Needs a ready cache of TMDB movie 550: run
// `scripts/direct-stream/cache-play.sh RUN ready` first. The fake resolver is set to fail, a play starts
// from the cache, and the page is opened at its address (muted, as the playback checks are):
//   DIRECT=<run>/direct verify.sh ui RUN .claude/skills/verify-notesd/scripts/stream/cache-play.steps.mjs
// Logs "CACHE PAGE PASS" when the page names the cache on window.notesdStream, shows the cache mark beside
// the title, fetched the cache's playlist and at least one segment from the cache's file route, and made no
// request through the pass-through. The first failed check throws.
import { writeFileSync } from 'node:fs'
import path from 'node:path'

function check(ok, what) {
  if (!ok) throw new Error(what)
}

export default async ({ page, base, shot, log }) => {
  const direct = process.env.DIRECT
  check(direct, 'DIRECT=<run>/direct is not set')
  writeFileSync(path.join(direct, 'mode'), 'no_source\n')
  const res = await fetch(`${base}/api/stream/play`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ kind: 'movie', tmdb_id: 550 }),
  })
  const played = await res.json().catch(() => null)
  check(res.status === 200, `play answered ${res.status}: ${JSON.stringify(played)}`)
  const cached = played.session.cached
  check(cached !== null && cached.state === 'ready', `the play is not from a ready cache: ${JSON.stringify(cached)} (run cache-play.sh RUN ready first)`)
  const local = []
  const through = []
  page.on('request', (req) => {
    const u = new URL(req.url())
    if (u.pathname.startsWith(`/api/stream/cache/${cached.id}/f/`)) local.push(u.pathname)
    if (/^\/api\/stream\/sessions\/[^/]+\/p$/.test(u.pathname)) through.push(u.pathname + u.search)
  })
  await page.goto(`${base}/stream/${played.session.session_id}?muted=1`)
  await page.waitForFunction(() => window.notesdStream?.cached != null, null, { timeout: 15_000 })
  const state = await page.evaluate(() => window.notesdStream.cached)
  check(state.id === cached.id && state.state === 'ready', `window.notesdStream.cached is ${JSON.stringify(state)}`)
  const mark = page.locator('.st-top .st-cached')
  await mark.waitFor({ timeout: 15_000 })
  const label = await mark.getAttribute('aria-label')
  check(label !== null && label.startsWith("Playing from this machine's cache") && !label.includes('while it downloads'), `the mark reads "${label}"`)
  const until = Date.now() + 15_000
  const segment = () => local.some((p) => !p.endsWith('.m3u8') && !p.endsWith('.vtt'))
  while (!segment() && Date.now() < until) await page.waitForTimeout(250)
  check(local.some((p) => p.endsWith('.m3u8')), `the page fetched no playlist from the cache: ${local.join(' ')}`)
  check(segment(), `the page fetched no segment from the cache: ${local.join(' ')}`)
  check(through.length === 0, `the page went through the pass-through: ${through.join(' ')}`)
  await page.locator('.st-stage').hover()
  await shot('cache-play-page')
  log(`CACHE PAGE PASS: cache ${cached.id} on window.notesdStream, mark "${label}", ${local.length} requests to the cache's file route, none through the pass-through`)
}

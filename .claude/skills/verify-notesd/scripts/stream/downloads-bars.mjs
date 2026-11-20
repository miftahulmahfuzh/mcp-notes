// downloads-bars.mjs: shared by downloads-title.steps.mjs and downloads-season.steps.mjs
// (stream-downloads-season-story phase 9). Not a steps file: it has no default export.
//
// A download's bar is role="progressbar" with aria-valuenow from 0 to 100 (phases 5 and 8). The page asks
// GET /api/stream/downloads every 2.5 s while something of the title is queued, running or paused and the page is
// visible (phase 8); R3.1 allows at most 3 s between two reads.
// Times are read from the monotonic clock (performance.now), never Date.now: under WSL the wall clock is stepped
// forward by a second or two every half minute, which a wall-clock gap would count as the page not asking.
import { performance } from 'node:perf_hooks'

/** Records when the page asks GET /api/stream/downloads. Call it before page.goto. */
export function recordAsks(page) {
  const at = []
  page.on('request', (r) => {
    if (r.method() === 'GET' && new URL(r.url()).pathname === '/api/stream/downloads') at.push(performance.now())
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
  const from = performance.now()
  await page.waitForTimeout(watchMs)
  const to = performance.now()
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
  if (worst > maxGapMs) {
    throw new Error(`the page went ${Math.round(worst)} ms without asking GET /api/stream/downloads (at most ${maxGapMs}); it asked at ${JSON.stringify(asks.map((t) => Math.round(t - from)))} ms from the start of the watch`)
  }
  for (const name of Object.keys(bars)) log(`bar on ${name}: ${first[name]} -> ${last[name]}`)
  log(`asked GET /api/stream/downloads ${inside.length} times in ${Math.round(to - from)} ms, longest gap ${Math.round(worst)} ms`)
  return { first, last, worst: Math.round(worst) }
}

// downloads-season.steps.mjs: J2 of stream-downloads-season-story phase 9 (R3.1), run by
// `direct-stream/downloads.sh RUN season` once MobLand season 1 downloads from the fixture pack.
// On the Stream-side title page the season row and the rows of S01E01 and S01E02 each show a bar; the season's
// bar rises, so does at least one episode's, and the page reads GET /api/stream/downloads at most 3 s apart.
// Env: SERIES_ID (default tv-247718, the fixture library's MobLand).
import { recordAsks, watchBars } from './downloads-bars.mjs'

const SERIES_ID = process.env.SERIES_ID ?? 'tv-247718'
const BAR = '[role="progressbar"]'

export default async ({ page, base, shot, log }) => {
  const asks = recordAsks(page)
  await page.goto(`${base}/movies/${SERIES_ID}?side=stream`)
  const season = page.locator('.mv-season[data-season="1"]')
  await season.waitFor({ timeout: 20000 })
  if ((await season.getAttribute('data-folded')) === 'true') {
    await season.getByRole('button', { name: 'Show the episodes of season 1' }).click()
  }
  const bars = {
    'the season row': season.locator(`.mv-season-head ${BAR}`).first(),
    S01E01: season.locator(`li[data-episode="S01E01"] ${BAR}`).first(),
    S01E02: season.locator(`li[data-episode="S01E02"] ${BAR}`).first(),
  }
  const r = await watchBars(page, asks, bars, { rising: ['the season row'], log })
  if (!(r.last.S01E01 > r.first.S01E01 || r.last.S01E02 > r.first.S01E02)) {
    throw new Error(`neither episode's bar moved: S01E01 ${r.first.S01E01} -> ${r.last.S01E01}, S01E02 ${r.first.S01E02} -> ${r.last.S01E02}`)
  }
  await season.scrollIntoViewIfNeeded()
  await shot('season-downloading')
  log(`J2 PASS: season 1 ${r.first['the season row']} -> ${r.last['the season row']}, bars on S01E01 and S01E02, read at most ${r.worst} ms apart`)
}

// downloads-title.steps.mjs: J1 of stream-downloads-season-story phase 9 (R3.1), run by
// `direct-stream/downloads.sh RUN title` once the film's torrent download runs.
// The film's Stream-side title page shows a bar under the Download button at the page's head (.mv-actions), the
// bar rises, and the page reads GET /api/stream/downloads at most 3 s apart while it does.
// Env: TITLE_ID (default movie-467905, the fixture library's "How to Make a Killing").
import { recordAsks, watchBars } from './downloads-bars.mjs'

const TITLE_ID = process.env.TITLE_ID ?? 'movie-467905'
const HEAD_BAR = '.mv-actions [role="progressbar"]'

export default async ({ page, base, shot, log }) => {
  const asks = recordAsks(page)
  await page.goto(`${base}/movies/${TITLE_ID}?side=stream`)
  const bar = page.locator(HEAD_BAR).first()
  const r = await watchBars(page, asks, { 'the title page': bar }, { rising: ['the title page'], log })
  await shot('title-downloading')
  log(`J1 PASS: ${TITLE_ID}'s head bar ${r.first['the title page']} -> ${r.last['the title page']}, read at most ${r.worst} ms apart`)
}

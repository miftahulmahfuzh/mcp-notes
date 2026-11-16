// TORRENT_STREAM_SOURCE phase 6: the real player page turns a torrent session's subtitle on by default
// and shows its line. SESSION_ID: a live session; WANT_LINE: a line its subtitle shows between 1 s and 30 s.
export default async ({ page, base, shot, log }) => {
  const id = process.env.SESSION_ID
  const want = process.env.WANT_LINE
  if (!id || !want) throw new Error('SESSION_ID and WANT_LINE are required')
  await page.goto(`${base}/stream/${id}?muted=1`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 60_000 })
  const chosen = await page.evaluate(() => ({ subtitle: window.notesdStream.subtitle, options: window.notesdStream.subtitles }))
  if (chosen.subtitle === null) throw new Error(`no subtitle is on by default: ${JSON.stringify(chosen.options)}`)
  await page.evaluate(() => document.querySelector('video')?.play())
  await page.waitForFunction((line) => (window.notesdStream?.caption ?? '').includes(line), want, { timeout: 45_000 })
  await shot('torrent-subtitle')
  log(`SUBTITLE PAGE PASS: ${chosen.subtitle} is on by default and shows "${want}"`)
}

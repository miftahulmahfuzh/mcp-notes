// WYZIE_SYNCED_BRIEF: the open player page takes the subtitle Wyzie Synced re-timed, without loading the film again.
// SESSION_ID: a live session whose subtitle came from outside the stream (the fake Wyzie's "Wyzie subtitle line");
// SYNC_GO: the file whose existence lets the fake Wyzie Synced answer (scripts/torrent/fake-subs.mjs).
import { writeFileSync } from 'node:fs'

export default async ({ page, base, shot, log }) => {
  const id = process.env.SESSION_ID
  const go = process.env.SYNC_GO
  if (!id || !go) throw new Error('SESSION_ID and SYNC_GO are required')
  await page.goto(`${base}/stream/${id}?muted=1`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 60_000 })
  await page.evaluate(() => document.querySelector('video')?.play())
  await page.waitForFunction(() => (window.notesdStream?.caption ?? '').includes('Wyzie subtitle line'), null, { timeout: 45_000 })
  // The owner moved the old file by hand: H twice.
  await page.keyboard.press('h')
  await page.keyboard.press('h')
  const before = await page.evaluate(() => ({
    labels: window.notesdStream.subtitles.map((s) => s.label),
    subtitle: window.notesdStream.subtitle,
    delay: window.notesdStream.subtitleDelayMs,
    time: document.querySelector('video').currentTime,
    src: document.querySelector('video').currentSrc,
  }))
  if (before.delay !== 100) throw new Error(`the delay is ${before.delay} ms after H twice, not 100`)
  await shot('before-sync')
  log(`before: ${JSON.stringify(before)}`)
  writeFileSync(go, '')
  await page.waitForFunction(() => [...document.querySelectorAll('.st-notice')].some((n) => n.textContent === 'Subtitles synced'), null, { timeout: 60_000 })
  await shot('synced-notice')
  await page.waitForFunction(() => (window.notesdStream?.caption ?? '').includes('Synced subtitle line'), null, { timeout: 30_000 })
  const after = await page.evaluate(() => ({
    labels: window.notesdStream.subtitles.map((s) => s.label),
    subtitle: window.notesdStream.subtitle,
    delay: window.notesdStream.subtitleDelayMs,
    syncs: window.notesdStream.subtitleSyncs,
    stage: window.notesdStream.stage,
    refreshes: window.notesdStream.refreshes,
    time: document.querySelector('video').currentTime,
    paused: document.querySelector('video').paused,
    src: document.querySelector('video').currentSrc,
    log: window.notesdStream.log.slice(-3),
  }))
  log(`after: ${JSON.stringify(after)}`)
  if (JSON.stringify(after.labels) !== JSON.stringify(['English (Wyzie, synced)'])) throw new Error(`the subtitle list is ${JSON.stringify(after.labels)}`)
  if (after.subtitle === null) throw new Error('the subtitle was turned off by the reload')
  if (after.delay !== 0) throw new Error(`the delay is still ${after.delay} ms`)
  if (after.syncs !== 1 || after.stage !== 'ready' || after.refreshes !== 0) throw new Error(`state: ${JSON.stringify(after)}`)
  if (after.src !== before.src || after.paused || !(after.time > before.time)) throw new Error(`the film was loaded again or stopped: ${before.time} -> ${after.time}`)
  await page.waitForFunction(() => ![...document.querySelectorAll('.st-notice')].some((n) => n.textContent === 'Subtitles synced'), null, { timeout: 15_000 })
  await shot('synced-caption')
  log(`SYNCED PAGE PASS: the page took "${after.labels[0]}" at ${after.time.toFixed(1)} s, said "Subtitles synced" once, the delay went from 100 to 0 ms, the film played on`)
}

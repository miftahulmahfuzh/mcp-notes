// The English text track inside a torrent's file, shown in the real page as it is extracted
// (torrent-stream-source phase 7, R3.4). Runs on a throwaway daemon seeded with the fixture film:
//   FX=$(bash .claude/skills/verify-notesd/scripts/stream/make-torrent-sub-fixtures.sh "$HOME/.local/state/notesd-verify/.torrent-sub-fixture")
//   TORRENT_FIXTURE_FILE="$FX/sub-text.mp4" verify.sh up --web --direct-stream --torrent
//   verify.sh ui RUN .claude/skills/verify-notesd/scripts/stream/embedded-subtitle.steps.mjs
// Logs "EMBEDDED SESSION PASS", "EMBEDDED FEED PASS", "EMBEDDED CAPTION PASS", "EMBEDDED SEEK PASS";
// the first failed check throws and fails the run. Nothing leaves this machine.
function check(ok, what) {
  if (!ok) throw new Error(what)
}

const captionHas = (needle) => (document.querySelector('[data-testid="caption"]')?.textContent ?? '').includes(needle)

export default async ({ page, base, shot, log }) => {
  const origin = new URL(base).origin
  const feedReads = []
  page.on('request', (r) => {
    if (/\/cues\/embedded-\d+-\d+\?after=\d+$/.test(r.url())) feedReads.push(r.url())
  })

  // Play the fixture title from the torrent, as direct_stream_play with provider "torrent" does.
  const played = await page.request.post(`${base}/api/stream/play`, { headers: { origin }, data: { kind: 'movie', tmdb_id: 467905, provider: 'torrent' } })
  check(played.ok(), `play answered ${played.status()}: ${await played.text()}`)
  const { session } = await played.json()
  log(`session subtitles ${JSON.stringify(session.subtitles)}`)
  const growing = (session.subtitles ?? []).filter((s) => s.growing === true)
  check(
    growing.length === 1 && /^\/api\/stream\/torrent\/[0-9a-f]{40}\/cues\/embedded-0-2$/.test(growing[0].url) && growing[0].lang === 'en' && growing[0].format === 'cues' && growing[0].english === true,
    'the session names one growing English subtitle: the cue feed of file 0, stream 2',
  )
  log('EMBEDDED SESSION PASS')

  // The feed fills as ffmpeg reads the file, and ends complete with the fixture's 20 cues at the file's own times.
  let feed = null
  for (let i = 0; i < 120; i++) {
    const res = await page.request.get(`${base}${growing[0].url}?after=0`)
    check(res.ok(), `the feed answered ${res.status()}`)
    feed = await res.json()
    if (feed.complete) break
    await page.waitForTimeout(500)
  }
  log(`feed ${JSON.stringify(feed).slice(0, 300)}`)
  check(feed?.complete === true && feed.cues.length === 20 && feed.next === 20, 'the feed completes with 20 cues')
  check(JSON.stringify(feed.cues[0]) === JSON.stringify({ start_s: 1, end_s: 3, text: 'Line 1' }), 'the first cue is Line 1 from 1 s to 3 s')
  check(feed.cues[16].text === 'Line 17' && feed.cues[16].start_s === 49 && feed.cues[16].end_s === 51, 'cue 17 is Line 17 from 49 s to 51 s')
  log('EMBEDDED FEED PASS')

  // The page shows the lines over the picture, English on by default.
  await page.goto(`${base}/stream/${session.session_id}`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 30_000 })
  await page.waitForFunction(captionHas, 'Line ', { timeout: 20_000 })
  await shot('embedded-caption')
  const state = await page.evaluate(() => ({ subtitle: window.notesdStream.subtitle, hidden: [...document.querySelector('video').textTracks].filter((t) => t.mode === 'hidden').map((t) => [t.language, t.cues?.length ?? 0]) }))
  log(`page ${JSON.stringify(state)} feed reads ${feedReads.join(' ')}`)
  check(state.subtitle !== null, 'an English subtitle is on by default')
  check(state.hidden.length === 1 && state.hidden[0][0] === 'en' && state.hidden[0][1] === 20, 'the one running track is English and holds the 20 cues read from the feed')
  check(feedReads.length >= 1 && feedReads[0].endsWith('?after=0'), 'the page read the feed from the start')
  log('EMBEDDED CAPTION PASS')

  // A line far into the film, after a seek.
  await page.evaluate(() => {
    const v = document.querySelector('video')
    v.pause()
    v.currentTime = 49.5
  })
  await page.waitForFunction(captionHas, 'Line 17', { timeout: 10_000 })
  await shot('embedded-seek')
  log('EMBEDDED SEEK PASS')
}

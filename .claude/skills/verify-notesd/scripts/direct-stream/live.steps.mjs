// The stream on screen, end to end on a `verify.sh up --web --direct-stream` run: a stream starts
// through POST /api/stream/play (the fake resolver and the fixture stream host), position reports go
// in exactly as the player page sends them, and the Movies page shows "playing" (pulsing frame) and
// "paused" on the poster, on the title's page and beside Play, then nothing once the page closes.
//   verify.sh ui RUN .claude/skills/verify-notesd/scripts/direct-stream/live.steps.mjs
// Logs "PLAYING PASS", "PAUSED PASS", "PAGE PASS", "CLOSED PASS"; the first failed check throws.
const TMDB_ID = 467905 // "How to Make a Killing" in the fake TMDB

function check(ok, what) {
  if (!ok) throw new Error(what)
}

export default async ({ page, base, shot, log }) => {
  const post = async (path, body) => {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) })
    return { status: res.status, json: await res.json().catch(() => null) }
  }
  const played = await post('/api/stream/play', { kind: 'movie', tmdb_id: TMDB_ID })
  check(played.status === 200, `play answered ${played.status}: ${JSON.stringify(played.json)}`)
  const sid = played.json.session.session_id
  const report = (body) => post(`/api/stream/sessions/${sid}/position`, { duration_s: 6720, ...body })
  const player = async () => (await (await fetch(`${base}/api/movies/player`)).json()).stream

  check((await report({ position_s: 754, paused: false })).status === 200, 'the first report was refused')
  const on = await player()
  check(on !== null && on.state === 'playing' && on.position === 754, `the player route says ${JSON.stringify(on)}`)

  await page.goto(`${base}/movies?side=stream`)
  const tile = page.locator('.mv-tile.now.playing')
  await tile.waitFor({ timeout: 15_000 })
  check((await tile.locator('.mv-now').textContent()) === 'playing', 'the poster chip does not read playing')
  const pulse = await tile.locator('.mv-art').evaluate((el) => getComputedStyle(el, '::after').animationName)
  check(pulse === 'repo-pulse', `the playing frame does not pulse (animation ${pulse})`)
  await shot('stream-grid-playing')
  log('PLAYING PASS: the poster has a pulsing frame and reads "playing"')

  // Paused: the pause, then beats. The page picks it up with its 5 s poll.
  await report({ position_s: 760, paused: true })
  const paused = page.locator('.mv-tile.now.paused')
  await paused.waitFor({ timeout: 15_000 })
  check((await paused.locator('.mv-now').textContent()) === 'paused', 'the poster chip does not read paused')
  const still = await paused.locator('.mv-art').evaluate((el) => getComputedStyle(el, '::after').animationName)
  check(still === 'none', `the paused frame still pulses (animation ${still})`)
  await shot('stream-grid-paused')
  const beat = await report({ position_s: 760, paused: true, beat: true })
  check(beat.json.play_id === null, `a beat wrote a play row: ${JSON.stringify(beat.json)}`)
  log('PAUSED PASS: the poster has a steady frame and reads "paused"; a beat writes nothing')

  // The title's page: the same on its poster, and the line beside Play.
  await paused.click()
  const line = page.locator('.mv-live')
  await line.waitFor({ timeout: 15_000 })
  await report({ position_s: 760, paused: true, beat: true })
  check((await line.textContent()) === 'paused in the stream player · 12:40 / 1:52:00', `the line reads "${await line.textContent()}"`)
  check(await page.locator('.mv-detail-art.now.paused').count() === 1, 'the title page poster is not framed as paused')
  await shot('stream-title-paused')
  await report({ position_s: 771, paused: false })
  await page.locator('.mv-detail-art.now.playing').waitFor({ timeout: 15_000 })
  await page.waitForFunction(() => document.querySelector('.mv-live')?.textContent?.startsWith('playing in the stream player · 12:51'), null, { timeout: 15_000 })
  await shot('stream-title-playing')
  log('PAGE PASS: the title page follows the stream, paused then playing, with the position')

  // The player page closes: its last word takes the mark away.
  await report({ position_s: 775, paused: false, closed: true })
  check((await player()) === null, 'the stream is still on screen after closed')
  await page.locator('.mv-detail-art.now').waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {})
  await page.waitForFunction(() => document.querySelector('.mv-detail-art.now') === null && document.querySelector('.mv-live') === null, null, { timeout: 15_000 })
  await shot('stream-title-closed')
  log('CLOSED PASS: the mark and the line are gone once the page closed')
}

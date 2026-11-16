// The player's previous and next episode buttons, end to end on a throwaway daemon
// (verify.sh up --web --discovery): the real page, the daemon's episode route and neighbours, the
// fake resolver (mode dash_film: a playable film from the fixture stream host) and the fake
// TMDB's One Piece. Chromium here, never the owner's streaming Chrome.
//   FIX=$(bash .claude/skills/verify-notesd/scripts/stream/make-dash-fixture.sh "$HOME/.local/state/notesd-verify/.stream-fixture-dash")
//   DIRECT=<the DIRECT= path `up` printed> DASH_FIXTURE="$FIX" verify.sh ui RUN <this file>
// Logs "BUTTONS PASS", "NEXT PASS", "PREV PASS", "FILM PASS"; the first failed check throws and fails the run.
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DIRECT = process.env.DIRECT
const FIX = process.env.DASH_FIXTURE

function check(ok, what) {
  if (!ok) throw new Error(what)
}

const resolves = () =>
  readFileSync(path.join(DIRECT, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).args).filter((a) => a[0] === 'resolve').map((a) => a.slice(1, 5).join(' '))

export default async ({ page, base, shot, log }) => {
  check(DIRECT && existsSync(path.join(DIRECT, 'upstream.json')), 'set DIRECT to the path `verify.sh up --discovery` printed')
  check(FIX && existsSync(path.join(FIX, 'manifest.mpd')), 'set DASH_FIXTURE to the folder make-dash-fixture.sh printed')
  if (!existsSync(path.join(DIRECT, 'film'))) symlinkSync(FIX, path.join(DIRECT, 'film'))
  writeFileSync(path.join(DIRECT, 'token'), '1')
  writeFileSync(path.join(DIRECT, 'mode'), 'dash_film')
  const origin = new URL(base).origin
  const play = async (body) => {
    const res = await page.request.post(`${base}/api/stream/play`, { headers: { origin }, data: body })
    check(res.ok(), `POST /api/stream/play answered ${res.status()} ${await res.text()}`)
    return (await res.json()).session
  }
  const playing = (after) =>
    page.waitForFunction((t) => {
      const v = document.querySelector('video')
      return window.notesdStream?.stage === 'ready' && !!v && !v.paused && v.currentTime > t
    }, after, { timeout: 40_000 })
  const wake = async () => {
    await page.mouse.move(600, 400)
    await page.mouse.move(620, 420)
  }

  // One Piece episode 730 in the fake TMDB is season 16, between 729 and 731.
  const first = await play({ kind: 'tv', tmdb_id: 37854, season: 16, episode: 730 })
  check(first.prev_episode?.episode === 729 && first.next_episode?.episode === 731, `the session names its neighbours (got ${JSON.stringify([first.prev_episode, first.next_episode])})`)
  await page.goto(`${base}/stream/${first.session_id}`)
  await playing(2)
  await wake()
  const next = page.getByRole('button', { name: 'Next episode (S16E731)', exact: true })
  const prev = page.getByRole('button', { name: 'Previous episode (S16E729)', exact: true })
  check((await next.isEnabled()) && (await prev.isEnabled()), 'both buttons are there and enabled')
  await shot('episode-buttons')
  log('BUTTONS PASS the player of One Piece S16E730 shows Previous episode (S16E729) and Next episode (S16E731)')

  await next.click()
  await page.waitForFunction(() => document.title === 'One Piece S16E731', null, { timeout: 40_000 })
  await playing(1)
  const afterNext = await page.evaluate(() => ({ title: document.title, path: location.pathname, t: document.querySelector('video').currentTime, stage: window.notesdStream.stage, errors: window.notesdStream.errors }))
  log(`NEXT state ${JSON.stringify(afterNext)}`)
  check(afterNext.path !== `/stream/${first.session_id}` && afterNext.path.startsWith('/stream/'), 'the address names the new session')
  check(afterNext.t < 30 && afterNext.errors.length === 0, `episode 731 plays from its start (at ${afterNext.t})`)
  check(JSON.stringify(resolves()) === JSON.stringify(['tv 37854 16 730', 'tv 37854 16 731']), `the daemon resolved 730, then 731 (got ${JSON.stringify(resolves())})`)
  // The new session's first position report (within 5 s) opens its play and closes the one of episode 730.
  let plays = []
  for (let waited = 0; waited < 15_000; waited += 500) {
    plays = (await (await page.request.get(`${base}/api/movies/tv-37854`)).json()).plays ?? []
    if (plays.some((p) => p.episode === 731) && plays.some((p) => p.episode === 730 && p.ended_at !== null)) break
    await page.waitForTimeout(500)
  }
  check(plays.some((p) => p.episode === 731), 'episode 731 has a play of its own')
  check(plays.some((p) => p.episode === 730 && p.ended_at !== null), 'the play of episode 730 was closed once the page left it')
  await shot('after-next')
  log('NEXT PASS one click resolved S16E731 and the page plays it under a new session; the play of S16E730 was closed')

  await wake()
  await page.keyboard.press('Shift+P')
  await page.waitForFunction(() => document.title === 'One Piece S16E730', null, { timeout: 40_000 })
  await playing(1)
  log('PREV PASS Shift+P went back to S16E730')

  // A film's player has no episode buttons.
  const film = await play({ kind: 'movie', tmdb_id: 990004 })
  check(film.prev_episode === null && film.next_episode === null, 'a film names no neighbour')
  await page.goto(`${base}/stream/${film.session_id}`)
  await playing(1)
  await wake()
  check((await page.getByRole('button', { name: /episode/i }).count()) === 0, 'a film shows no episode button')
  log('FILM PASS a film shows neither button')
}

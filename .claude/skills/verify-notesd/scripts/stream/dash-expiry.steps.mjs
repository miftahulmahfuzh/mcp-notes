// A DASH stream whose token expires mid-film, end to end on a throwaway daemon
// (verify.sh up --web --direct-stream): the real player page and dash.js, the daemon's real
// pass-through and DASH rewriting, the fake resolver (mode dash_film) and the fixture stream host
// serving a playable DASH film from <run>/direct/film. Raising <run>/direct/token makes the host
// refuse every address handed out before, as a stream host does when a signed address is too old.
// Chromium here, never the owner's streaming Chrome; nothing leaves this machine.
//   FIX=$(bash .claude/skills/verify-notesd/scripts/stream/make-dash-fixture.sh "$HOME/.local/state/notesd-verify/.stream-fixture-dash")
//   DIRECT=<the DIRECT= path `up` printed> DASH_FIXTURE="$FIX" verify.sh ui RUN <this file>
// Logs "DASH PLAY PASS", "DASH EXPIRY PASS", "DASH OVER PASS", "DASH EVIDENCE PASS"; the first failed check throws and fails the run.
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DIRECT = process.env.DIRECT
const FIX = process.env.DASH_FIXTURE

function check(ok, what) {
  if (!ok) throw new Error(what)
}

/** The fixture host's request log: one {path, status, referer, ...} per request it got. */
function upstreamLog() {
  const file = path.join(DIRECT, 'upstream.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
}

const segmentNumber = (p) => Number(/seg-\d+-(\d+)\.m4s$/.exec(p)?.[1] ?? 0)

export default async ({ page, base, shot, log }) => {
  check(DIRECT && existsSync(path.join(DIRECT, 'upstream.json')), 'set DIRECT to the path `verify.sh up --direct-stream` printed')
  check(FIX && existsSync(path.join(FIX, 'manifest.mpd')), 'set DASH_FIXTURE to the folder make-dash-fixture.sh printed')
  if (!existsSync(path.join(DIRECT, 'film'))) symlinkSync(FIX, path.join(DIRECT, 'film'))
  writeFileSync(path.join(DIRECT, 'token'), '1')
  writeFileSync(path.join(DIRECT, 'mode'), 'dash_film')

  // A play as the Movies page asks for one: the fake resolver answers the film's address under token 1.
  const played = await page.request.post(`${base}/api/stream/play`, { headers: { origin: new URL(base).origin }, data: { kind: 'movie', tmdb_id: 550 } })
  check(played.ok(), `POST /api/stream/play answered ${played.status()} ${await played.text()}`)
  const sid = (await played.json()).session.session_id
  check(typeof sid === 'string' && sid.length === 32, 'the play answered a session id')

  await page.goto(`${base}/stream/${sid}`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 30_000 })
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !!v && !v.paused && v.currentTime > 2
  }, null, { timeout: 30_000 })
  const first = await page.evaluate(() => ({ kind: window.notesdStream.kind, levels: window.notesdStream.levels, refreshes: window.notesdStream.refreshes, height: document.querySelector('video').videoHeight }))
  log(`DASH PLAY state ${JSON.stringify(first)}`)
  check(first.kind === 'dash' && first.refreshes === 0 && first.height === 360, `the DASH film plays through the pass-through (got ${JSON.stringify(first)})`)
  check(upstreamLog().some((r) => r.path === '/film/t1/manifest.mpd' && r.status === 200 && r.referer === 'https://embed.fixture/'), 'the host served the manifest under token 1 to the captured Referer')
  await shot('dash-playing')
  log('DASH PLAY PASS dash.js plays the ffmpeg-made DASH film through the daemon pass-through')

  // The token expires: every address under t1 is refused from now on. Seek past the buffer.
  writeFileSync(path.join(DIRECT, 'token'), '2')
  const before = upstreamLog().length
  await page.evaluate(() => {
    document.querySelector('video').currentTime = 100
  })
  await page.waitForFunction(() => window.notesdStream?.refreshes === 1 && window.notesdStream.stage === 'ready', null, { timeout: 30_000 })
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !v.paused && v.currentTime > 102
  }, null, { timeout: 30_000 })
  const after = await page.evaluate(() => ({ t: document.querySelector('video').currentTime, refreshes: window.notesdStream.refreshes, errors: window.notesdStream.errors, log: window.notesdStream.log }))
  log(`DASH EXPIRY state ${JSON.stringify(after)}`)
  const since = upstreamLog().slice(before)
  const refused = since.filter((r) => r.path.startsWith('/film/t1/') && r.status === 403)
  const fresh = since.filter((r) => r.path.startsWith('/film/t2/') && (r.status === 200 || r.status === 206))
  check(refused.length > 0, 'the host refused a request under the expired token with 403')
  check(fresh.some((r) => r.path === '/film/t2/manifest.mpd'), 'after the refresh the manifest was read under the new token')
  check(fresh.some((r) => segmentNumber(r.path) >= 50), 'segments around 100 s were read under the new token')
  check(after.refreshes === 1 && after.errors.length === 0, `exactly one refresh and no error (got ${JSON.stringify({ refreshes: after.refreshes, errors: after.errors })})`)
  check(after.t >= 100 && after.t < 119, `playing on from 100 s, not from 0 (at ${after.t})`)
  const resolves = readFileSync(path.join(DIRECT, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.args[0] === 'resolve').length
  check(resolves === 2, `the daemon resolved twice: the play and the refresh (got ${resolves})`)
  await shot('dash-after-refresh')
  log(`DASH EXPIRY PASS ${refused.length} request(s) refused with 403 under the old token; one refresh; playback continued from 100 s under the new token`)

  // notesd's own refusal (no X-Notesd-Upstream) is not an expiry: the page stops and does not refresh.
  await page.route(`**/api/stream/sessions/${sid}/p**`, (route) => route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"unknown_session"}' }))
  await page.evaluate(() => {
    document.querySelector('video').currentTime = 40
  })
  await page.waitForFunction(() => window.notesdStream?.stage === 'error', null, { timeout: 30_000 })
  const over = await page.evaluate(() => ({ error: window.notesdStream.error, refreshes: window.notesdStream.refreshes }))
  check(over.error === 'session_over' && over.refreshes === 1, `a 403 without X-Notesd-Upstream ends the session without a refresh (got ${JSON.stringify(over)})`)
  log('DASH OVER PASS a 403 without X-Notesd-Upstream stopped the page with session_over and no further refresh')

  // Stream evidence: the daemon kept the pass-through's answers and the page's own lines for this session.
  let evidence = []
  for (let i = 0; i < 20; i++) {
    const res = await page.request.get(`${base}/api/stream/evidence?session=${sid}&limit=2000`)
    check(res.ok(), `GET /api/stream/evidence answered ${res.status()}`)
    evidence = (await res.json()).records
    const said = evidence.filter((r) => r.type === 'player').map((r) => r.text)
    if (said.some((t) => t.startsWith('refresh after 403')) && said.includes('error: session_over')) break
    await page.waitForTimeout(250)
  }
  const said = evidence.filter((r) => r.type === 'player').map((r) => r.text)
  const reqs = evidence.filter((r) => r.type === 'request')
  log(`DASH EVIDENCE ${reqs.length} request record(s); page lines ${JSON.stringify(said)}`)
  check(reqs.some((r) => (r.path ?? '').startsWith('/film/t1/') && r.status === 403 && r.answer === 403), 'the evidence log holds a 403 from the stream host under the old token')
  check(reqs.some((r) => r.path === '/film/t2/manifest.mpd' && r.status === 200 && r.kind === 'dash'), 'the evidence log holds the manifest read under the new token')
  check(reqs.some((r) => r.kind === 'media' && r.bytes > 0 && typeof r.kbps === 'number' && typeof r.ttfb_ms === 'number'), 'segments carry bytes, time to first byte and throughput')
  check(said.some((t) => t.startsWith('refresh after 403')), "the page's refresh line reached the daemon")
  check(said.includes('error: session_over'), "the page's error line reached the daemon")
  check(evidence.some((r) => r.type === 'session' && r.event === 'refreshed'), 'the refresh is a session record')
  log('DASH EVIDENCE PASS the daemon recorded each answer of the play and the page posted its refresh and error lines')
}

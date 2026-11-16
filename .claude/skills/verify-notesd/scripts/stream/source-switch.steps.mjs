// A film that keeps stalling moves to another provider, end to end on a throwaway daemon
// (verify.sh up --web --direct-stream): the real player page and dash.js, the daemon's real
// pass-through, evidence log and delivery verdict, the fake resolver (mode dash_film) and the
// fixture stream host. The stall is real for the page: from a mark on, every segment load is
// failed in the browser, then the film is moved past its buffer. Once the page has asked the
// daemon for another source the loads answer again. Chromium here, never the owner's streaming
// Chrome; nothing leaves this machine.
//   FIX=$(bash .claude/skills/verify-notesd/scripts/stream/make-dash-fixture.sh "$HOME/.local/state/notesd-verify/.stream-fixture-dash")
//   DIRECT=<the DIRECT= path `up` printed> DASH_FIXTURE="$FIX" verify.sh ui RUN <this file>
// Logs "SWITCH PLAY PASS", "SWITCH PASS", "SWITCH SESSION PASS", "DELIVERY PASS", "ORDER PASS"; the
// first failed check throws and fails the run. About one minute.
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DIRECT = process.env.DIRECT
const FIX = process.env.DASH_FIXTURE

function check(ok, what) {
  if (!ok) throw new Error(what)
}

const resolveCalls = () =>
  readFileSync(path.join(DIRECT, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.args[0] === 'resolve')

export default async ({ page, base, shot, log }) => {
  check(DIRECT && existsSync(path.join(DIRECT, 'upstream.json')), 'set DIRECT to the path `verify.sh up --direct-stream` printed')
  check(FIX && existsSync(path.join(FIX, 'manifest.mpd')), 'set DASH_FIXTURE to the folder make-dash-fixture.sh printed')
  if (!existsSync(path.join(DIRECT, 'film'))) symlinkSync(FIX, path.join(DIRECT, 'film'))
  writeFileSync(path.join(DIRECT, 'token'), '1')
  writeFileSync(path.join(DIRECT, 'mode'), 'dash_film')
  const origin = new URL(base).origin
  const api = async (method, route, data) => {
    const res = await page.request.fetch(`${base}${route}`, { method, headers: { origin }, ...(data === undefined ? {} : { data }) })
    return { status: res.status(), body: await res.json().catch(() => null) }
  }

  const played = await api('POST', '/api/stream/play', { kind: 'movie', tmdb_id: 550 })
  check(played.status === 200, `POST /api/stream/play answered ${played.status}`)
  const sid = played.body.session.session_id
  const first = played.body.session.provider

  // The host "stalls": while `failing`, every segment the page asks the pass-through for fails.
  const net = { failing: false, failed: 0, asked: 0 }
  await page.route('**/api/stream/sessions/**', async (route) => {
    const url = new URL(route.request().url())
    if (route.request().method() === 'POST' && url.pathname.endsWith('/source')) {
      net.asked += 1
      net.failing = false
      return route.continue()
    }
    if (net.failing && url.pathname.endsWith('/p') && /\.m4s/.test(url.searchParams.get('u') ?? '')) {
      net.failed += 1
      return route.abort('failed')
    }
    return route.continue()
  })

  await page.goto(`${base}/stream/${sid}`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 30_000 })
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !!v && !v.paused && v.currentTime > 2
  }, null, { timeout: 30_000 })
  log(`SWITCH PLAY PASS the film plays from ${first}`)

  net.failing = true
  await page.evaluate(() => {
    document.querySelector('video').currentTime = 100
  })
  await page.waitForFunction(() => window.notesdStream?.log.some((line) => line.startsWith('source: ')), null, { timeout: 90_000 })
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return window.notesdStream.stage === 'ready' && !v.paused && v.currentTime > 102
  }, null, { timeout: 30_000 })
  const after = await page.evaluate(() => ({ t: document.querySelector('video').currentTime, errors: window.notesdStream.errors, log: window.notesdStream.log }))
  log(`SWITCH state ${JSON.stringify(after)}`)
  const info = await api('GET', `/api/stream/sessions/${sid}`)
  const second = info.body.provider
  check(net.failed > 0 && net.asked === 1, `segment loads failed and the page asked for another source once (failed ${net.failed}, asked ${net.asked})`)
  check(after.log.some((line) => /stalls in 120 s: asking for another source/.test(line)), 'the page said why it asked')
  check(after.log.includes(`source: ${first} -> ${second} at 100 s`) && second !== first, `the page moved from ${first} to another provider at 100 s (session now on ${second})`)
  check(after.errors.length === 0 && after.t >= 100 && after.t < 130, `the film plays on from 100 s with no error (at ${after.t}, errors ${JSON.stringify(after.errors)})`)
  await shot('after-source-switch')
  log(`SWITCH PASS ${net.failed} segment loads failed; the page asked once and plays on from 100 s on ${second}`)

  const calls = resolveCalls()
  const skip = calls.at(-1).args[calls.at(-1).args.indexOf('--skip') + 1]
  check(calls.length === 2 && calls.at(-1).args.includes('--skip') && skip === first, `the daemon resolved twice, the second time without ${first} (got --skip ${skip})`)
  const evidence = await api('GET', `/api/stream/evidence?session=${sid}&limit=2000`)
  const events = evidence.body.records.filter((r) => r.type === 'session').map((r) => `${r.event}:${r.provider}`)
  check(events.join(' ') === `created:${first} switched:${second}`, `the evidence log holds the session created on ${first} and switched to ${second} (got ${events.join(' ')})`)
  log(`SWITCH SESSION PASS same session id, --skip ${first}, evidence ${events.join(' ')}`)

  // The stalls are in the evidence log, so the provider it left has a bad delivery on this machine.
  const sources = await page.request.post(`${base}/mcp`, {
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'direct_stream_sources', arguments: {} } },
  })
  const text = await sources.text()
  const payload = JSON.parse(/"text":"((?:[^"\\]|\\.)*)"/.exec(text)?.[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') ?? '{}')
  const left = (payload.providers ?? []).find((p) => p.name === first)
  log(`DELIVERY ${first} ${JSON.stringify(left?.delivery ?? null)}`)
  check(left?.delivery?.verdict === 'bad' && left.delivery.stalls >= 3, `direct_stream_sources shows ${first} with a bad delivery and its stalls`)
  log(`DELIVERY PASS ${first}: bad (${left.delivery.stalls} stalls, ${left.delivery.failed}/${left.delivery.requests} requests failed)`)

  // The next resolve is told so: the health file marks the provider, and the resolver's order puts it last.
  const again = await api('POST', '/api/stream/cache', { kind: 'movie', tmdb_id: 551 })
  check(again.status === 202 || again.status === 200, `a second title was asked for (cache start answered ${again.status})`)
  for (let i = 0; i < 40 && resolveCalls().length < 3; i++) await page.waitForTimeout(250)
  const third = resolveCalls().at(-1)
  check(resolveCalls().length === 3 && (third.bad_delivery ?? []).includes(first), `the next resolve's health file marks ${first} with a bad delivery (got ${JSON.stringify(third.bad_delivery)})`)
  log(`ORDER PASS the next resolve was handed delivery "bad" for ${first}`)
}

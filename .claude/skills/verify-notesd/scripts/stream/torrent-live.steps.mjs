// The player page on a real torrent session (torrent-stream-source phase 4) in a throwaway daemon
// with torrents on: verify.sh up --web --direct-stream --torrent (phase 1's loopback-seeded fixture
// torrent, phase 3's fake index). The real play, the real torrent routes, the real page; Chromium
// here, never the owner's streaming Chrome, and no swarm beyond loopback.
//   verify.sh ui RUN .claude/skills/verify-notesd/scripts/stream/torrent-live.steps.mjs
// TORRENT_PLAY overrides the play's JSON body (default {"kind":"movie","tmdb_id":467905,"provider":"torrent"}).
// Logs "TORRENT LIVE PASS", "TORRENT DISK PASS"; the first failed check throws and fails the run.
const PLAY = process.env.TORRENT_PLAY ? JSON.parse(process.env.TORRENT_PLAY) : { kind: 'movie', tmdb_id: 467905, provider: 'torrent' }

function check(ok, what) {
  if (!ok) throw new Error(what)
}

async function until(page, cond, ms, what) {
  for (let waited = 0; waited < ms; waited += 250) {
    if (await cond()) return
    await page.waitForTimeout(250)
  }
  check(await cond(), what)
}

const loadedTo = (page) =>
  page.evaluate(() => {
    const bar = document.querySelector('.st-seek').style.getPropertyValue('--st-loaded-bar')
    const stops = [...bar.matchAll(/var\(--st-loaded\) ([\d.]+)%/g)].map((m) => Number(m[1]))
    return stops.length === 0 ? 0 : Math.max(...stops)
  })

const streamState = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.notesdStream ?? null)))

export default async ({ page, base, shot, log }) => {
  const origin = new URL(base).origin
  const played = await page.request.post(`${base}/api/stream/play`, { headers: { origin }, data: PLAY })
  check(played.ok(), `POST /api/stream/play answered ${played.status()}: ${await played.text()}`)
  const session = (await played.json()).session
  const hash = session?.torrent?.info_hash
  check(typeof hash === 'string' && /^[0-9a-f]{40}$/.test(hash), `the session names a torrent (${JSON.stringify(session?.torrent)})`)

  const statuses = []
  page.on('response', async (res) => {
    if (new URL(res.url()).pathname !== `/api/stream/torrent/${hash}`) return
    statuses.push({ status: res.status(), body: await res.json().catch(() => null) })
  })

  await page.goto(`${base}/stream/${session.session_id}`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 60_000 })
  await page.mouse.move(400, 400)
  const mark = page.locator('.st-top .st-torrent')
  await mark.waitFor({ state: 'attached', timeout: 10_000 })
  await until(
    page,
    async () => statuses.some((s) => s.status === 200 && typeof s.body?.peers === 'number' && typeof s.body?.down_kbps === 'number'),
    15_000,
    "the page read the torrent's peers and speed from the daemon",
  )
  const live = await streamState(page)
  check(live.torrent?.infoHash === hash && typeof live.torrent.peers === 'number' && typeof live.torrent.downKbps === 'number', `window.notesdStream.torrent is ${JSON.stringify(live.torrent)}`)
  const label = (await mark.getAttribute('aria-label')) ?? ''
  check(/^Playing (from a torrent|a torrent download)/.test(label), `the mark says "${label}"`)
  await shot('torrent-live')
  log('TORRENT LIVE PASS')

  await until(page, async () => (await streamState(page)).torrent?.state === 'ready', 180_000, 'the download completes')
  await until(page, async () => (await loadedTo(page)) === 100, 10_000, 'the grey bar covers the whole film once it is on disk')
  const map = await (await page.request.get(`${base}/api/stream/torrent/${hash}/map`, { headers: { origin } })).json()
  check(Array.isArray(map.ranges) && map.ranges.length >= 1, `the daemon's map is ${JSON.stringify(map)}`)
  const asked = statuses.length
  await page.waitForTimeout(7_000)
  check(statuses.length === asked, `the page kept asking after the download was complete (${statuses.length - asked} more)`)
  await shot('torrent-on-disk')
  log('TORRENT DISK PASS')
}

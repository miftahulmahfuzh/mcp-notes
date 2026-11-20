// Download buttons on the Stream-side title page (stream-downloads-season-story phase 8), end to end on a throwaway
// daemon (verify.sh up --web --torrent): the real wall, the real /api/stream/downloads routes and download engine, the
// loopback seeder's fixture film (the fake index lists it for every film), the fake TMDB. Chromium here, never the
// owner's streaming Chrome.
//   TORRENT=<the TORRENT= path `up` printed> verify.sh ui RUN .claude/skills/verify-notesd/scripts/stream/download-buttons.steps.mjs
// Logs "J1 PASS" .. "J7 PASS" and "NEIGHBOR PASS"; the first failed check throws and fails the run.
// J4 needs the seeded film to take longer than ~12 s to download (8 MB at the seeder's 200 kB/s does); with a faster
// fixture it fails saying so: rerun with TORRENT_FIXTURE_FILE=<a bigger video> on `up`.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const T = process.env.TORRENT

function check(ok, what) {
  if (!ok) throw new Error(what)
}
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x))

export default async ({ page, base, shot, log }) => {
  check(T && existsSync(path.join(T, 'fixture.json')), 'set TORRENT to the path `verify.sh up --torrent` printed')
  const FILM_HASH = JSON.parse(readFileSync(path.join(T, 'fixture.json'), 'utf8')).info_hash
  const origin = new URL(base).origin
  const seen = []
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (u.pathname.startsWith('/api/')) seen.push({ at: Date.now(), method: r.method(), path: u.pathname, search: u.search })
  })
  const gets = (pathname, since, until = Date.now()) => seen.filter((s) => s.method === 'GET' && s.path === pathname && s.at >= since && s.at <= until)
  const gaps = (list) => list.slice(1).map((s, i) => s.at - list[i].at)
  const ensure = async (kind, tmdb_id) => {
    const res = await page.request.post(`${base}/api/movies/ensure`, { headers: { origin }, data: { kind, tmdb_id } })
    check(res.ok(), `POST /api/movies/ensure ${kind} ${tmdb_id} answered ${res.status()} ${await res.text()}`)
  }
  const rows = async (title) => {
    const res = await page.request.get(`${base}/api/stream/downloads?title=${title}`)
    check(res.ok(), `GET /api/stream/downloads?title=${title} answered ${res.status()}`)
    return (await res.json()).downloads
  }
  const cancelAll = async (title) => {
    for (const r of await rows(title)) {
      if (['queued', 'running', 'paused'].includes(r.state)) await page.request.delete(`${base}/api/stream/downloads/${r.id}`, { headers: { origin } })
    }
  }
  const open = async (title, name) => {
    await page.goto(`${base}/movies/${title}?side=stream`)
    await page.getByRole('article', { name }).waitFor({ timeout: 20_000 })
  }
  /** Clicks, and answers the POST /api/stream/downloads it sent: its body, its status and how long the answer took from the click. */
  const posted = async (click) => {
    const t0 = Date.now()
    const [req] = await Promise.all([page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/stream/downloads'), click()])
    const res = await req.response()
    const ms = Date.now() - t0
    return { body: JSON.parse(req.postData() ?? 'null'), status: res?.status() ?? 0, ms, answer: res === null ? null : await res.json().catch(() => null) }
  }

  // J1 (R3.3): a title with nothing downloading asks GET /api/stream/downloads only with the page's own refresh of the title.
  await ensure('movie', 990004)
  const j1 = Date.now()
  await open('movie-990004', 'Oldboy')
  await page.waitForTimeout(15_000)
  const j1Downloads = gets('/api/stream/downloads', j1)
  const j1Detail = gets('/api/movies/movie-990004', j1)
  check(j1Downloads.length >= 1, 'the page asked its downloads once when it opened')
  check(j1Downloads.length <= j1Detail.length, `idle: ${j1Downloads.length} downloads asks but only ${j1Detail.length} reads of the title in 15 s`)
  await shot('j1-idle')
  log(`J1 PASS idle title page: ${j1Downloads.length} GET /api/stream/downloads vs ${j1Detail.length} GET /api/movies/movie-990004 in 15 s`)

  // J2 (R1.1): the film's Download button queues it through POST /api/stream/downloads, answered at once.
  await ensure('movie', 990001)
  await open('movie-990001', 'The Rivals of Amziah King')
  const j2 = await posted(() => page.getByRole('button', { name: 'Download The Rivals of Amziah King', exact: true }).click())
  check(JSON.stringify(j2.body) === JSON.stringify({ kind: 'movie', tmdb_id: 990001, via: 'auto' }), `the click sent ${JSON.stringify(j2.body)}`)
  check(j2.status === 202 || j2.status === 200, `POST answered ${j2.status}`)
  check(j2.ms < 2000, `POST took ${j2.ms} ms to answer`)
  const j2Rows = await rows('movie-990001')
  check(j2Rows.some((r) => r.kind === 'movie' && r.tmdb_id === 990001 && r.via === 'auto'), `GET lists no download of 990001: ${JSON.stringify(j2Rows)}`)
  const cancel = page.getByRole('button', { name: 'Cancel the download of The Rivals of Amziah King' })
  if (await cancel.isVisible({ timeout: 4000 }).catch(() => false)) {
    const [del] = await Promise.all([page.waitForRequest((r) => r.method() === 'DELETE' && new URL(r.url()).pathname.startsWith('/api/stream/downloads/')), cancel.click()])
    log(`J2 cancel sent ${del.method()} ${new URL(del.url()).pathname}`)
  }
  await cancelAll('movie-990001')
  log(`J2 PASS click -> POST ${JSON.stringify(j2.body)} answered ${j2.status} in ${j2.ms} ms; GET lists the row`)

  // J3 (R1.3): the caret's menu "Choose how to download <name>" offers three choices, and each sends only its source.
  const menuOf = async (name) => {
    await page.getByRole('button', { name: `Choose how to download ${name}`, exact: true }).click()
    const menu = page.getByRole('menu', { name: `Choose how to download ${name}` })
    await menu.waitFor()
    return menu
  }
  await ensure('movie', 467905)
  await open('movie-467905', 'How to Make a Killing')
  let menu = await menuOf('How to Make a Killing')
  check((await menu.locator('.mv-menu-head').textContent()) === 'Choose how to download How to Make a Killing', 'the menu is titled "Choose how to download How to Make a Killing"')
  const offered = await menu.locator('.mv-menu-label').allTextContents()
  check(JSON.stringify(offered) === JSON.stringify(['Best torrent (1080p)', 'Cloud', 'Pick a torrent…']), `the menu offers ${JSON.stringify(offered)}`)
  await shot('j3-menu')
  const best = await posted(() => menu.getByRole('menuitem', { name: /^Best torrent/ }).click())
  check(JSON.stringify(best.body) === JSON.stringify({ kind: 'movie', tmdb_id: 467905, via: 'torrent' }), `Best torrent sent ${JSON.stringify(best.body)}`)
  check((await rows('movie-467905')).every((r) => r.via === 'torrent' && r.source !== 'cloud'), 'a Best torrent download never names a cloud source')
  await cancelAll('movie-467905')

  await ensure('movie', 990002)
  await open('movie-990002', 'The Dog Stars')
  menu = await menuOf('The Dog Stars')
  const cloud = await posted(() => menu.getByRole('menuitem', { name: /^Cloud/ }).click())
  check(JSON.stringify(cloud.body) === JSON.stringify({ kind: 'movie', tmdb_id: 990002, via: 'cloud' }), `Cloud sent ${JSON.stringify(cloud.body)}`)
  check((await rows('movie-990002')).every((r) => r.via === 'cloud' && r.source !== 'torrent'), 'a Cloud download never names a torrent source')
  await cancelAll('movie-990002')

  await ensure('movie', 990003)
  await open('movie-990003', 'Bad Apples')
  menu = await menuOf('Bad Apples')
  await menu.getByRole('menuitem', { name: /^Pick a torrent/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Torrents of Bad Apples' })
  const pickRow = dialog.locator(`[data-hash="${FILM_HASH}"]`)
  await pickRow.waitFor({ timeout: 30_000 })
  check((await dialog.getByRole('button', { name: /^Play / }).count()) === 0, 'the pick list offers no Play')
  await shot('j3-pick')
  const pick = await posted(() => pickRow.locator('button[aria-label^="Download "]').click())
  check(JSON.stringify(pick.body) === JSON.stringify({ kind: 'movie', tmdb_id: 990003, via: 'torrent', info_hash: FILM_HASH }), `the pick sent ${JSON.stringify(pick.body)}`)
  const pickRows = await rows('movie-990003')
  check(pickRows.length >= 1 && pickRows.every((r) => r.via === 'torrent' && r.source !== 'cloud'), `the picked download is a torrent one: ${JSON.stringify(pickRows)}`)
  log('J3 PASS "Choose how to download …" offers Best torrent (1080p), Cloud, Pick a torrent…; each sent its own via (torrent / cloud / torrent + the picked info_hash) and no row named the other source')

  // J4 (R3.1, R3.3): while Bad Apples downloads, its bar shows and the page reads again at most 3 s apart; once whole, it stops asking.
  const bar = page.getByRole('progressbar', { name: 'Download of Bad Apples' })
  await bar.waitFor({ timeout: 20_000 })
  const v0 = Number(await bar.getAttribute('aria-valuenow'))
  const j4 = Date.now()
  await page.waitForTimeout(9_000)
  const live = gets('/api/stream/downloads', j4)
  check(live.length >= 3, `only ${live.length} reads in 9 s while downloading: the download ended too fast to watch (rerun with TORRENT_FIXTURE_FILE=<a bigger video>), or the page did not poll`)
  check(gaps(live).every((g) => g <= 3000), `reads were ${JSON.stringify(gaps(live))} ms apart`)
  const v1 = Number((await bar.getAttribute('aria-valuenow').catch(() => '100')) ?? '100')
  check(v1 >= v0, `the bar went back from ${v0} to ${v1}`)
  const tip = await page.getByRole('button', { name: 'Download Bad Apples', exact: true }).getAttribute('data-tip')
  await shot('j4-downloading')
  log(`J4 bar ${v0}% -> ${v1}%, tip "${tip}", reads ${JSON.stringify(gaps(live))} ms apart`)
  let state = ''
  for (let waited = 0; waited < 240_000; waited += 2000) {
    state = (await rows('movie-990003')).find((r) => r.tmdb_id === 990003)?.state ?? 'gone'
    if (state === 'done' || state === 'failed') break
    await page.waitForTimeout(2000)
  }
  check(state === 'done', `the picked torrent download ended ${state}`)
  await page.waitForTimeout(4000)
  const j4After = Date.now()
  await page.waitForTimeout(8000)
  check(gets('/api/stream/downloads', j4After).length === 0, 'the page kept asking after the download finished')
  check((await bar.count()) === 0, 'the bar is gone once the download is whole')
  await shot('j4-done')
  log(`J4 PASS bar shown, reads <= 3 s apart while downloading, none in 8 s once whole; button data-download=${await page.locator('.mv-dl.page').getAttribute('data-download')}`)

  // J5 (R2.2): an episode row's Download queues that episode only.
  await ensure('tv', 247718)
  await open('tv-247718', 'MobLand')
  const j5 = await posted(() => page.getByRole('button', { name: 'Download MobLand S01E02', exact: true }).click())
  check(JSON.stringify(j5.body) === JSON.stringify({ kind: 'tv', tmdb_id: 247718, season: 1, episode: 2, via: 'auto' }), `the row sent ${JSON.stringify(j5.body)}`)
  check(j5.status === 202 || j5.status === 200, `POST answered ${j5.status}`)
  const j5Rows = (await rows('tv-247718')).filter((r) => r.season === 1)
  check(j5Rows.length >= 1 && j5Rows.every((r) => r.episode === 2), `the episode click made rows for ${JSON.stringify(j5Rows.map((r) => r.episode))}`)
  log('J5 PASS S01E02 row -> POST {season:1, episode:2}; GET lists season 1 episode 2 only')

  // J6 (R2.1): the season head's Download queues every aired episode of the season that is not whole here.
  const j6 = await posted(() => page.getByRole('button', { name: 'Download MobLand season 1', exact: true }).click())
  check(JSON.stringify(j6.body) === JSON.stringify({ kind: 'tv', tmdb_id: 247718, season: 1, via: 'auto' }) && !('episode' in j6.body), `the season sent ${JSON.stringify(j6.body)}`)
  check(j6.status === 202 || j6.status === 200, `POST answered ${j6.status}`)
  const j6Eps = [...new Set((await rows('tv-247718')).filter((r) => r.season === 1).map((r) => r.episode))]
  check(j6Eps.includes(1) && j6Eps.includes(3), `season 1 rows are for episodes ${JSON.stringify(j6Eps)}`)
  check(sameSet([...new Set([...j6Eps, 2])].sort(), [1, 2, 3]), `season 1 rows name an episode the season does not have: ${JSON.stringify(j6Eps)}`)
  await shot('j6-season')
  log(`J6 PASS season 1 head -> POST {season:1}, no episode; rows for episodes ${JSON.stringify(j6Eps.sort())} (MobLand season 1 has 3 aired)`)
  await cancelAll('tv-247718')

  // J7 (R3.1): the season row's and the episode row's bars, with GET /api/stream/downloads answered by a running S01E03
  // (the fixture pack downloads in a few seconds, too fast to watch); the page still reads every <= 3 s.
  let n = 0
  const stub = (url) => url.pathname === '/api/stream/downloads'
  await page.route(stub, (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    n += 1
    const progress = Math.min(0.9, 0.2 + 0.1 * n)
    return route.fulfill({
      json: { host: 'verify', active: true, downloads: [{ id: 900001, title_id: 'tv-247718', kind: 'tv', tmdb_id: 247718, season: 1, episode: 3, state: 'running', via: 'auto', source: 'torrent', progress, bytes_done: Math.round(progress * 1e9), bytes_total: 1e9, peers: 3, down_kbps: 900, error: null, batch: 'verify' }] },
    })
  })
  await open('tv-247718', 'MobLand')
  const seasonBar = page.getByRole('progressbar', { name: 'Download of MobLand season 1' })
  const episodeBar = page.locator('[data-episode="S01E03"]').getByRole('progressbar', { name: 'Download of MobLand S01E03' })
  await seasonBar.waitFor({ timeout: 10_000 })
  await episodeBar.waitFor({ timeout: 10_000 })
  check((await page.locator('[data-episode="S01E01"]').getByRole('progressbar').count()) === 0, 'S01E01 shows no bar')
  const j7 = Date.now()
  const s0 = Number(await seasonBar.getAttribute('aria-valuenow'))
  await page.waitForTimeout(8000)
  const s1 = Number(await seasonBar.getAttribute('aria-valuenow'))
  const e1 = Number(await episodeBar.getAttribute('aria-valuenow'))
  const j7Reads = gets('/api/stream/downloads', j7)
  check(j7Reads.length >= 3 && gaps(j7Reads).every((g) => g <= 3000), `reads were ${JSON.stringify(gaps(j7Reads))} ms apart`)
  check(s1 > s0 && s1 === e1, `season bar ${s0} -> ${s1}, episode bar ${e1}`)
  await shot('j7-series-bars')
  await page.unroute(stub)
  log(`J7 PASS season 1 bar and S01E03 bar move together (${s0}% -> ${s1}%), reads ${JSON.stringify(gaps(j7Reads))} ms apart`)

  // Neighbor: the Library side of a title has no Download button and never asks the downloads. The Dog Stars, not
  // Oldboy: a title no machine holds a file of is shown as the Stream page whatever the address says (detailSide), and
  // the fixture library has a file record of The Dog Stars only (movies/make-fixtures.sh, VLC's recents).
  const nb = Date.now()
  await page.goto(`${base}/movies/movie-990002`)
  await page.getByRole('article', { name: 'The Dog Stars' }).waitFor({ timeout: 20_000 })
  await page.waitForTimeout(3000)
  check((await page.getByRole('button', { name: /^Download / }).count()) === 0, 'the Library side shows a Download button')
  check(gets('/api/stream/downloads', nb).length === 0, 'the Library side asked GET /api/stream/downloads')
  log('NEIGHBOR PASS the Library side shows no Download button and asks no downloads')
}

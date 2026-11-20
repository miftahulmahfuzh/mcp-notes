// downloads-cache.steps.mjs: J3 of stream-downloads-season-story phase 9 (R4.2), run by
// `direct-stream/downloads.sh RUN cache` while MobLand season 1 downloads and the film has a ready cloud cache.
// Default view: both titles. Downloading filter on: the film is gone, MobLand stays, and every episode row listed
// carries a bar (only what downloads now is listed). Filter off again: the film is back.
// Env: FILM_ID (default movie-467905), SERIES_ID (default tv-247718).
const FILM_ID = process.env.FILM_ID ?? 'movie-467905'
const SERIES_ID = process.env.SERIES_ID ?? 'tv-247718'
const FILTER = /^Downloading/

export default async ({ page, base, shot, log }) => {
  await page.goto(`${base}/movies/cache`)
  const list = page.getByRole('list', { name: 'Titles on disk' })
  const film = list.locator(`li.cp-title[data-title="${FILM_ID}"]`)
  const series = list.locator(`li.cp-title[data-title="${SERIES_ID}"]`)
  await film.waitFor({ timeout: 20000 })
  await series.waitFor({ timeout: 20000 })
  await shot('default-view')
  log('default view: the film (on disk, not downloading) and MobLand (downloading) are both listed')

  const filter = page.getByRole('button', { name: FILTER })
  if ((await filter.getAttribute('aria-pressed')) !== 'false') throw new Error('the Downloading filter is on before it was clicked')
  await filter.click()
  await film.waitFor({ state: 'detached', timeout: 10000 })
  if ((await filter.getAttribute('aria-pressed')) !== 'true') throw new Error('the Downloading filter does not say it is on')
  await series.waitFor()
  const titles = await list.locator('li.cp-title').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-title')))
  if (titles.length !== 1 || titles[0] !== SERIES_ID) throw new Error(`the Downloading view lists ${JSON.stringify(titles)}, not only ${SERIES_ID}`)
  const season = series.locator('li.cp-season[data-season="1"]')
  await season.waitFor({ timeout: 10000 })
  const episodes = season.locator('li.cp-episode')
  await episodes.first().waitFor({ timeout: 10000 })
  const n = await episodes.count()
  for (let i = 0; i < n; i++) {
    const row = episodes.nth(i)
    if ((await row.locator(':scope > .cp-row [role="progressbar"]').count()) === 0) {
      throw new Error(`episode ${await row.getAttribute('data-episode')} is listed in the Downloading view with no bar`)
    }
  }
  await shot('downloading-view')
  log(`Downloading view: only ${SERIES_ID}, season 1 unfolded, ${n} episode row(s), each with a bar`)

  await filter.click()
  await film.waitFor({ timeout: 10000 })
  await series.waitFor()
  if ((await filter.getAttribute('aria-pressed')) !== 'false') throw new Error('the Downloading filter still says it is on')
  await shot('default-again')
  log('J3 PASS: the second click is back on the default view, the film listed again')
}

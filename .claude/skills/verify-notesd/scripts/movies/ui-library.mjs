// ui-library.mjs: journey.sh stage 12, run by `verify.sh ui RUN`. Grid of loaded TMDB posters,
// then the MobLand page and its trailer buttons. Expects journey stages 1-8 first (S01E01/E02 finished, S01E03 deleted).
export default async ({ page, base, shot, log }) => {
  await page.goto(base + '/')
  await page.getByRole('button', { name: 'Movies' }).first().click()
  await page.waitForURL((url) => url.pathname === '/movies')
  await page.locator('img[src*="/t/p/"]').first().waitFor()
  await page.waitForFunction(
    () => {
      const imgs = [...document.querySelectorAll('img[src*="/t/p/"]')]
      return imgs.length >= 4 && imgs.every((img) => img.complete && img.naturalWidth > 0)
    },
    null,
    { timeout: 15000 },
  )
  log(`grid: ${await page.locator('img[src*="/t/p/"]').count()} posters, all loaded`)
  await shot('grid')

  await page.getByRole('img', { name: 'MobLand' }).first().click()
  // A poster opens the title under its movie id (/movies/M-23T4).
  await page.waitForURL((url) => /^\/movies\/M-[0-9A-Z]{4}$/.test(url.pathname))
  for (const text of ['Stick or Twist', 'Eye for an Eye', 'Lie Down with Dogs', 'Tom Hardy', 'Harry Da Souza']) {
    await page.getByText(text).first().waitFor()
  }
  log('detail: three episodes, cast with character')
  const deleted = page.locator('[data-testid="movie-file"][data-deleted="true"]')
  const count = await deleted.count()
  if (count !== 1) throw new Error(`expected exactly one deleted episode row, found ${count}`)
  const row = (await deleted.first().innerText()).replace(/\s+/g, ' ')
  if (!/Lie Down with Dogs|E0?3\b/.test(row)) throw new Error(`the deleted row is not S01E03: "${row}"`)
  log(`deleted flag on: ${row.slice(0, 80)}`)
  await shot('detail')

  // Trailers. YouTube is never loaded: the player's address answers a blank page here.
  await page.route(/youtube(-nocookie)?\.com/, (r) => r.fulfill({ contentType: 'text/html', body: '<body style="background:#000">' }))
  const [search] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByRole('button', { name: 'Find the trailer on YouTube' }).click(),
  ])
  const searched = new URL(search.url())
  if (searched.pathname !== '/results' || searched.searchParams.get('search_query') !== 'MobLand 2025 trailer') {
    throw new Error(`a series without a trailer should search YouTube, opened ${search.url()}`)
  }
  await search.close()
  log(`no trailer of its own: a new tab searches "${searched.searchParams.get('search_query')}"`)
  await page.getByRole('button', { name: 'Watch the season 1 trailer' }).click()
  const dialog = page.getByRole('dialog', { name: 'Trailer of MobLand, season 1' })
  const src = await dialog.locator('iframe').getAttribute('src')
  if (src !== 'https://www.youtube-nocookie.com/embed/fxMobS1trlr?autoplay=1&rel=0') throw new Error(`the season trailer plays ${src}`)
  log(`season 1 trailer plays in the pop-up: ${src}`)
  await shot('trailer')
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  log('Esc closes the trailer and the page stays')
}

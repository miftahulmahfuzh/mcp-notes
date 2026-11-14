// ui-library.mjs: journey.sh stage 12, run by `verify.sh ui RUN`. Grid of loaded TMDB posters,
// then the MobLand page. Expects journey stages 1-8 first (S01E01/E02 finished, S01E03 deleted).
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
  await page.waitForURL((url) => url.pathname === '/movies/tv-247718')
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
}

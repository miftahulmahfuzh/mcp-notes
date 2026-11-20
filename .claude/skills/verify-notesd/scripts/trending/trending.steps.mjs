// The Stream side's Trending section on a `verify.sh up --web --trending` run after journey.sh built the list.
export default async ({ page, base, shot, log }) => {
  await page.goto(`${base}/movies?side=stream`)
  const section = page.getByRole('region', { name: 'Trending' })
  await section.getByRole('heading', { name: 'Trending on torrents' }).waitFor({ timeout: 15000 })
  await section.getByRole('list', { name: 'Trending posters' }).waitFor()
  const lines = await section.locator('.mv-q').allTextContents()
  log(`quality lines: ${JSON.stringify(lines)}`)
  const need = (cond, what) => {
    if (!cond) throw new Error(what)
  }
  need(lines.length === 3, `3 trending posters expected, got ${lines.length}`)
  need(lines.some((l) => /9,000 seeds/.test(l)), 'the 9,000-seed film should show its seeds')
  need(lines.some((l) => /5,000 seeds/.test(l)), 'the 5,000-seed film should show its seeds')
  need(!lines.some((l) => /confirmed|no peer/.test(l)), 'no swarm state may be shown')
  await shot('trending-section')
  // A poster's crossed-eye icon: the poster leaves at the click, without a reload.
  const cell = section.getByRole('listitem').filter({ hasText: 'The Rivals of Amziah King' })
  await cell.hover()
  await cell.getByRole('button', { name: /Not interested in The Rivals of Amziah King/ }).click()
  await page.waitForFunction(() => ![...document.querySelectorAll('[aria-label="Trending posters"] [role=listitem]')].some((n) => /The Rivals of Amziah King/.test(n.textContent ?? '')), null, { timeout: 5000 })
  log('The Rivals of Amziah King left the section at the click')
  await shot('after-not-interested')
}

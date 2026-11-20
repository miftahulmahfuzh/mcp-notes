// season-story.steps.mjs: J4 of stream-downloads-season-story phase 9 (R6.1), run by
// `direct-stream/downloads.sh RUN story` after it seeded movie_stories with MobLand season 1's story (three
// sections, the third with no recap found, one source). The season row's book icon opens the pop-up with one
// section per episode under its code and name. No model is asked: the run pins NOTESD_MOVIES_STORY_MODEL=off,
// so only a stored story can open.
// Env: SERIES_ID (default tv-247718).
const SERIES_ID = process.env.SERIES_ID ?? 'tv-247718'
const EPISODES = [
  ['S01E01', 'Stick or Twist', 'Harry Da Souza is called in'],
  ['S01E02', 'Eye for an Eye', 'The Harrigans answer the killing'],
  ['S01E03', 'Lie Down with Dogs', null],
]
const NOT_FOUND = 'No published recap was found for this episode.'
const SOURCE = 'https://en.wikipedia.org/wiki/MobLand'

export default async ({ page, base, shot, log }) => {
  await page.goto(`${base}/movies/${SERIES_ID}?side=stream`)
  const head = page.locator('.mv-season[data-season="1"] .mv-season-head')
  await head.waitFor({ timeout: 20000 })
  await head.getByRole('button', { name: /story of S01$/ }).click()
  const dialog = page.getByRole('dialog', { name: /^Story of / })
  await dialog.waitFor({ timeout: 10000 })
  for (const [code, name, text] of EPISODES) {
    await dialog.getByRole('heading', { name: `${code} · ${name}` }).waitFor({ timeout: 10000 })
    if (text !== null) await dialog.getByText(text).first().waitFor()
  }
  const sections = await dialog.getByRole('heading', { name: /^S01E\d\d · / }).count()
  if (sections !== EPISODES.length) throw new Error(`the pop-up has ${sections} episode sections, not ${EPISODES.length}`)
  await dialog.getByText(NOT_FOUND, { exact: true }).waitFor()
  const hrefs = await dialog.getByRole('link').evaluateAll((links) => links.map((a) => a.getAttribute('href')))
  if (!hrefs.includes(SOURCE)) throw new Error(`the pop-up does not link its source; links: ${JSON.stringify(hrefs)}`)
  await shot('season-story')
  log(`J4 PASS: ${sections} sections under S01E01..S01E03, S01E03 says no recap was found, the source is a link`)
}

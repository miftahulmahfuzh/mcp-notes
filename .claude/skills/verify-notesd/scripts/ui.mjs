// node ui.mjs <base-url> <steps.mjs> <evidence-dir>
// Steps module: `export default async ({ page, base, shot, log }) => { ... }`.
//   shot(name)  full-page screenshot into evidence
//   log(text)   line into the run's ui transcript
// Records a video of the whole drive and a final screenshot, pass or fail.
// Run from an mcp-notes checkout (resolves playwright from its node_modules).
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { appendFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'

const [base, stepsPath, evidence] = process.argv.slice(2)
if (!base || !stepsPath || !evidence) {
  console.error('usage: node ui.mjs <base-url> <steps.mjs> <evidence-dir>')
  process.exit(2)
}

const require = createRequire(path.join(process.cwd(), 'package.json'))
const { chromium } = require('playwright')

const n = readdirSync(evidence).filter((f) => /^\d\d-/.test(f)).length
const tag = `${String(n + 1).padStart(2, '0')}-ui-${path.basename(stepsPath, '.mjs')}`
const transcript = path.join(evidence, `${tag}.txt`)
const log = (text) => {
  appendFileSync(transcript, `${text}\n`)
  console.log(text)
}

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 1400, height: 900 },
  recordVideo: { dir: path.join(evidence, '.video') },
})
const page = await context.newPage()
page.on('console', (m) => m.type() === 'error' && log(`console.error: ${m.text()}`))
page.on('pageerror', (e) => log(`pageerror: ${e.message}`))
let shots = 0
const shot = async (name) => {
  const file = path.join(evidence, `${tag}-${++shots}-${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  log(`screenshot: ${file}`)
}

let failed = null
try {
  log(`steps: ${stepsPath}`)
  const { default: steps } = await import(pathToFileURL(stepsPath).href)
  await steps({ page, base, shot, log })
  log('result: PASS')
} catch (err) {
  failed = err
  log(`result: FAIL ${err?.stack ?? err}`)
} finally {
  await shot(failed ? 'failure' : 'final').catch(() => {})
  const video = page.video()
  await context.close()
  await browser.close()
  if (video) {
    const file = path.join(evidence, `${tag}.webm`)
    renameSync(await video.path(), file)
    rmSync(path.join(evidence, '.video'), { recursive: true, force: true })
    log(`video: ${file}`)
  }
  console.error(`[evidence: ${transcript}]`)
}
process.exit(failed ? 1 : 0)

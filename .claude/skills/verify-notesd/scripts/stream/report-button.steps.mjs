// The player's report button, end to end on a throwaway daemon (verify.sh up --web --direct-stream):
// the real page in its error stage, the daemon's report route, phase 1's snapshot, and the fake
// tmux every run uses (scripts/stream/fake-tmux.sh). Chromium here; no real tmux, no claude starts.
//   verify.sh up --web --direct-stream                   (note TMUX_FAKE=)
//   TMUX_FAKE=<that path> verify.sh ui RUN <this file>
// Logs "BUTTON PASS", "REPORT PASS", "ALREADY PASS", "NO_TMUX PASS", "SPAWN_FAILED PASS"; the first
// failed check throws and fails the run.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const TMUX = process.env.TMUX_FAKE

function check(ok, what) {
  if (!ok) throw new Error(what)
}

const tmuxCalls = () => {
  const file = path.join(TMUX, 'calls.log')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t')) : []
}
const newWindows = () => tmuxCalls().filter((a) => (a[0] === '-S' ? a[2] : a[0]) === 'new-window')
const marker = (dir) => JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8'))

export default async ({ page, base, shot, log }) => {
  check(TMUX && existsSync(TMUX), 'set TMUX_FAKE to the path `verify.sh up` printed')
  for (const f of ['down', 'fail-new-window']) rmSync(path.join(TMUX, f), { force: true })
  const origin = new URL(base).origin
  const play = async () => {
    const res = await page.request.post(`${base}/api/stream/play`, { headers: { origin }, data: { kind: 'movie', tmdb_id: 550 } })
    check(res.ok(), `POST /api/stream/play answered ${res.status()} ${await res.text()}`)
    return (await res.json()).session.session_id
  }
  // The error stage at once: the page's read of its session answers what it cannot play
  // (bad_session). Only that GET is faked; the session stays live in the daemon.
  const failingPage = async (sid) => {
    await page.route(`${base}/api/stream/sessions/${sid}`, (route) =>
      route.request().method() === 'GET' ? route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }) : route.continue(),
    )
    await page.goto(`${base}/stream/${sid}?muted=1`)
    await page.waitForFunction(() => window.notesdStream?.stage === 'error', null, { timeout: 20_000 })
  }
  const answer = async () => {
    await page.waitForFunction(
      () => {
        const s = window.notesdStream?.bugReport?.status
        return s !== undefined && s !== 'idle' && s !== 'sending'
      },
      null,
      { timeout: 20_000 },
    )
    return page.evaluate(() => window.notesdStream.bugReport)
  }

  // J1: the icon-only button beside the error; a click snapshots and opens one window.
  const sid = await play()
  await failingPage(sid)
  const alert = page.getByRole('alert')
  const report = alert.getByRole('button', { name: 'Report this stream bug', exact: true })
  await report.waitFor()
  check((await report.innerText()).trim() === '', 'the report button is icon only')
  await shot('report-button')
  log('BUTTON PASS the error stage shows an icon-only "Report this stream bug" button')
  await report.click()
  const first = await answer()
  check(first.status === 'opened', `the report opened a window (got ${JSON.stringify(first)})`)
  check(existsSync(path.join(first.dir, 'session.json')), `phase 1's snapshot is in ${first.dir}`)
  const m = marker(first.dir)
  check(m.session_id === sid && m.result.outcome === 'opened' && m.page?.stage === 'error', `report.json names the session and the window (got ${JSON.stringify(m)})`)
  const windows = newWindows()
  check(windows.length === 1, `one new-window call (got ${windows.length})`)
  const argv = windows[0]
  check(argv.includes(`/report-stream-bug ${first.dir}`), `the window runs /report-stream-bug ${first.dir} (got ${argv.join(' ')})`)
  check(argv[argv.indexOf('--permission-mode') + 1] === 'auto', 'claude runs in auto permission mode')
  check(argv.includes(`stream-bug-${sid.slice(0, 6)}`), 'the window is named after the session')
  await alert.getByRole('status').filter({ hasText: 'Report opened in tmux' }).waitFor()
  await shot('report-opened')
  log(`REPORT PASS one window: ${argv.join(' ')}`)

  // J2: the same session again opens nothing.
  const again = await page.request.post(`${base}/api/stream/sessions/${sid}/report`, { headers: { origin }, data: {} })
  const againBody = await again.json()
  check(again.status() === 409 && againBody.error === 'already_reported' && againBody.dir === first.dir, `already_reported with the first folder (got ${again.status()} ${JSON.stringify(againBody)})`)
  check(newWindows().length === 1, 'still one new-window call')
  check(await alert.getByRole('button', { name: 'Report opened in tmux', exact: true }).isDisabled(), 'the spent button is disabled')
  log(`ALREADY PASS 409 already_reported ${first.dir}, no second window`)

  // J3: no tmux server: the snapshot is kept and the page says so.
  writeFileSync(path.join(TMUX, 'down'), '')
  const sid2 = await play()
  await failingPage(sid2)
  await page.getByRole('alert').getByRole('button', { name: 'Report this stream bug', exact: true }).click()
  const second = await answer()
  check(second.status === 'saved' && second.reason === 'no_tmux', `saved but not opened, no_tmux (got ${JSON.stringify(second)})`)
  check(existsSync(path.join(second.dir, 'session.json')) && marker(second.dir).result.outcome === 'no_tmux', `the snapshot is kept in ${second.dir}`)
  await page.getByRole('alert').getByRole('status').filter({ hasText: 'Report saved but not opened' }).waitFor()
  check(newWindows().length === 1, 'no window was opened')
  await shot('report-saved')
  log(`NO_TMUX PASS saved but not opened: ${second.dir}`)
  rmSync(path.join(TMUX, 'down'), { force: true })

  // J3: tmux refuses the window: spawn_failed, the snapshot kept.
  writeFileSync(path.join(TMUX, 'fail-new-window'), '')
  const sid3 = await play()
  const failed = await page.request.post(`${base}/api/stream/sessions/${sid3}/report`, { headers: { origin }, data: {} })
  const failedBody = await failed.json()
  rmSync(path.join(TMUX, 'fail-new-window'), { force: true })
  check(failed.status() === 500 && failedBody.error === 'spawn_failed' && existsSync(path.join(failedBody.dir, 'session.json')), `spawn_failed with the kept folder (got ${failed.status()} ${JSON.stringify(failedBody)})`)
  log(`SPAWN_FAILED PASS 500 spawn_failed (${failedBody.message}), folder kept: ${failedBody.dir}`)
}

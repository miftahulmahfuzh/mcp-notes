// The real player page on a torrent session (torrent phase 3), on a `verify.sh up --web --torrent` run after
// `torrent.sh RUN named`:
//   SID=$(cat <run>/torrent-journey/sid) verify.sh ui RUN .claude/skills/verify-notesd/scripts/stream/torrent-play.steps.mjs
// Logs "TORRENT PAGE PASS" when the page plays (the video's time passes 2 s) from the torrent's file route
// (/api/stream/torrent/<hash>/f/<index>, answered 206) and fetched nothing through the pass-through. The first
// failed check throws.
function check(ok, what) {
  if (!ok) throw new Error(what)
}

export default async ({ page, base, shot, log }) => {
  const sid = process.env.SID
  check(sid, 'SID=<session id> is not set (torrent.sh RUN named writes it to <run>/torrent-journey/sid)')
  const res = await fetch(`${base}/api/stream/sessions/${sid}`)
  const info = await res.json().catch(() => null)
  check(res.status === 200 && info?.torrent, `the session answered ${res.status}: ${JSON.stringify(info)}`)
  check(info.manifest_url.startsWith(`/api/stream/torrent/${info.torrent.info_hash}/f/`), `manifest_url is ${info.manifest_url}`)
  const local = []
  const through = []
  page.on('response', (r) => {
    const u = new URL(r.url())
    if (u.pathname === info.manifest_url) local.push(r.status())
    if (/^\/api\/stream\/sessions\/[^/]+\/p$/.test(u.pathname)) through.push(u.pathname + u.search)
  })
  await page.goto(`${base}/stream/${sid}?muted=1`)
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return v !== null && v.currentTime > 2
  }, null, { timeout: 60_000 })
  check(local.includes(206), `the file route answered ${local.join(', ') || 'nothing'}`)
  check(through.length === 0, `the page went through the pass-through: ${through.join(' ')}`)
  await page.locator('.st-stage').hover()
  await shot('torrent-page')
  log(`TORRENT PAGE PASS: ${info.torrent.name} plays from ${info.manifest_url} (${local.length} answers, ${local.filter((s) => s === 206).length} of them 206), none through the pass-through`)
}

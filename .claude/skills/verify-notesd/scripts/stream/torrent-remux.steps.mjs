// The remux for a torrent file Chrome cannot play as is (torrent phase 5), end to end on a throwaway daemon: phase 1's
// loopback seeder serves an MKV with H.264 video and two AC3 5.1 tracks (Spanish, then English), phase 3's fake index
// hands it out for every film, and the real player page plays it through ffmpeg's HLS remux. Chromium here, never the
// owner's streaming Chrome; nothing leaves this machine.
//   FIX=$(bash .claude/skills/verify-notesd/scripts/stream/make-mkv-fixture.sh "$HOME/.local/state/notesd-verify/.stream-fixture-mkv")
//   $V up --web --torrent                       (note RUN), then .claude/skills/verify-notesd/scripts/torrent/offer-remux.sh RUN
//   RUN_DIR=$HOME/.local/state/notesd-verify/<RUN> $V ui RUN .claude/skills/verify-notesd/scripts/stream/torrent-remux.steps.mjs
// Logs "REMUX PLAY PASS" (J1), "REMUX TRACKS PASS" (J2), "REMUX SEEK PASS" (J3), "REMUX REPLAY PASS" (J4),
// "REMUX GROWING PASS" (J5) and "REMUX ONE COPY PASS" (J6); the first failed check throws and fails the run.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const RUN_DIR = process.env.RUN_DIR
// An English film of the fake TMDB (scripts/movies/tmdb.json): the remux keeps the English track.
const TMDB_ID = Number(process.env.TMDB_ID ?? 467905)
const REMUX_URL = /^\/api\/stream\/torrent\/([0-9a-f]{40})\/hls\/(\d+)\/index\.m3u8\?remux=1&total_s=([\d.]+)$/

function check(ok, what) {
  if (!ok) throw new Error(what)
}

async function play(page, base) {
  const res = await page.request.post(`${base}/api/stream/play`, { headers: { origin: new URL(base).origin }, data: { kind: 'movie', tmdb_id: TMDB_ID, provider: 'torrent' } })
  check(res.ok(), `POST /api/stream/play answered ${res.status()} ${await res.text()}`)
  return (await res.json()).session
}

/** The playlist as it was when only its first `n` segments were remuxed: no EXT-X-ENDLIST. */
function firstSegments(text, n) {
  const lines = text.split('\n')
  const out = []
  let kept = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('#EXT-X-ENDLIST')) continue
    if (line.startsWith('#EXTINF')) {
      if (kept === n) break
      kept += 1
      out.push(line, lines[i + 1])
      i += 1
      continue
    }
    out.push(line)
  }
  return `${out.join('\n')}\n`
}

function ffmpegOn(dir) {
  try {
    return execFileSync('pgrep', ['-f', dir], { encoding: 'utf8' }).trim() !== ''
  } catch {
    return false
  }
}

const mtimes = (dir) => JSON.stringify(Object.fromEntries(readdirSync(dir).sort().map((name) => [name, statSync(path.join(dir, name)).mtimeMs])))

export default async ({ page, base, shot, log }) => {
  check(RUN_DIR && existsSync(path.join(RUN_DIR, 'daemon.log')), 'set RUN_DIR to the run folder (~/.local/state/notesd-verify/<RUN>)')
  const tor = path.join(RUN_DIR, 'torrent')
  check(existsSync(path.join(tor, 'seeded', 'remux.json')) && existsSync(path.join(tor, 'candidates.json')), 'run scripts/torrent/offer-remux.sh RUN first (it seeds the MKV and lists it in the fake index)')
  const torrentsDir = process.env.TORRENT_DIR ?? path.join(RUN_DIR, 'data', 'movies', 'torrents')

  // J1: the play answers the remux playlist, and the page plays it, with sound.
  const first = await play(page, base)
  const m = REMUX_URL.exec(first.manifest_url ?? '')
  check(first.manifest_kind === 'hls' && m !== null, `the session plays the remux playlist (got ${first.manifest_kind} ${first.manifest_url})`)
  const [, hash, index, total] = m
  check(Math.abs(Number(total) - 120) < 1, `total_s is the film's length from the probe (got ${total})`)
  await page.goto(`${base}/stream/${first.session_id}`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 60_000 })
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !!v && !v.paused && v.currentTime > 2 && v.webkitAudioDecodedByteCount > 0
  }, null, { timeout: 60_000 })
  const playing = await page.evaluate(() => {
    const v = document.querySelector('video')
    return { kind: window.notesdStream.kind, height: v.videoHeight, duration: v.duration, audioBytes: v.webkitAudioDecodedByteCount, errors: window.notesdStream.errors }
  })
  log(`REMUX PLAY state ${JSON.stringify(playing)}`)
  check(playing.kind === 'hls' && playing.height === 360 && Math.abs(playing.duration - 120) < 1 && playing.errors.length === 0, `hls.js plays the remux: 360p, 120 s long, no error (got ${JSON.stringify(playing)})`)
  await shot('remux-playing')
  log('REMUX PLAY PASS the MKV (H.264 + AC3) plays in the player page from the remux playlist, with sound')

  // J2: the finished remux is H.264 copied and the English track as AAC stereo, in a closed EVENT playlist.
  const dir = path.join(torrentsDir, hash, 'notesd-remux', index)
  // The loopback seeder is capped (200 kB/s in verify.sh), so the 16 MB film takes about 80 s to arrive: wait up to 180 s.
  for (let i = 0; i < 360 && !existsSync(path.join(dir, 'done.json')); i++) await page.waitForTimeout(500)
  check(existsSync(path.join(dir, 'done.json')), `the remux finished: ${dir}/done.json`)
  const playlist = await (await page.request.get(`${base}${first.manifest_url}`)).text()
  check(playlist.includes('#EXT-X-PLAYLIST-TYPE:EVENT') && playlist.trimEnd().endsWith('#EXT-X-ENDLIST'), 'the finished playlist is an EVENT playlist closed with EXT-X-ENDLIST')
  const streams = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,channels:stream_tags=language', '-of', 'json', path.join(dir, 'index.m3u8')], { encoding: 'utf8' })).streams
  log(`REMUX TRACKS ${JSON.stringify(streams)}`)
  const video = streams.filter((s) => s.codec_type === 'video')
  const audio = streams.filter((s) => s.codec_type === 'audio')
  check(video.length === 1 && video[0].codec_name === 'h264', 'the video is the H.264 stream, copied')
  check(audio.length === 1 && audio[0].codec_name === 'aac' && audio[0].channels === 2 && audio[0].tags?.language === 'eng', 'one audio track: the English one (not the first, Spanish), as AAC stereo')
  log('REMUX TRACKS PASS H.264 copied, the English AC3 5.1 track as AAC stereo, EVENT playlist closed once whole')

  // J3: a seek inside what is remuxed plays from there; the map says how far that is.
  const map = await (await page.request.get(`${base}/api/stream/torrent/${hash}/map`)).json()
  log(`REMUX MAP ${JSON.stringify(map)}`)
  check(map.ranges.length === 1 && map.ranges[0][0] === 0 && map.ranges[0][1] > 110 && Math.abs(map.duration_s - 120) < 1, 'the map answers the remuxed stretch from 0 and the film length')
  await page.evaluate(() => {
    document.querySelector('video').currentTime = 90
  })
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !v.paused && v.currentTime > 91
  }, null, { timeout: 30_000 })
  const at = await page.evaluate(() => document.querySelector('video').currentTime)
  check(at > 91 && at < 110, `plays on from 90 s (at ${at})`)
  log('REMUX SEEK PASS a seek to 90 s inside the remuxed stretch plays from there')

  // J4: a second play of the title replays the finished remux from disk: no ffmpeg, no file written again.
  const before = mtimes(dir)
  const second = await play(page, base)
  check(second.manifest_url === first.manifest_url && second.manifest_kind === 'hls', `the second play names the same playlist (got ${second.manifest_url})`)
  check(!ffmpegOn(dir), 'no ffmpeg runs for the finished remux')
  const replayed = await (await page.request.get(`${base}${second.manifest_url}`)).text()
  check(replayed.trimEnd().endsWith('#EXT-X-ENDLIST'), 'the replayed playlist is whole from the first read')
  check(mtimes(dir) === before, 'no file of the remux was written again')
  check(readFileSync(path.join(RUN_DIR, 'daemon.log'), 'utf8').includes(`torrent remux: ${hash} file ${index} plays from disk`), "the daemon's log says the remux plays from disk")
  log('REMUX REPLAY PASS the second play reads the finished remux from disk: same playlist, no ffmpeg, files untouched')

  // J5: the real page on a playlist that is still growing (Playwright hands it the first 3 segments, no EXT-X-ENDLIST,
  // for 15 s): the timeline is the whole film, a seek past the remuxed part waits there, and plays once it is there.
  let loadedAt = 0
  await page.route(`**/api/stream/torrent/${hash}/hls/${index}/index.m3u8*`, async (route) => {
    const res = await route.fetch()
    const text = await res.text()
    const grown = loadedAt !== 0 && Date.now() - loadedAt > 15_000
    await route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', headers: { 'cache-control': 'no-store' }, body: grown ? text : firstSegments(text, 3) })
  })
  loadedAt = Date.now()
  await page.goto(`${base}/stream/${second.session_id}`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 30_000 })
  await page.evaluate(() => {
    document.querySelector('video').currentTime = 60
  })
  await page.waitForTimeout(5_000)
  const held = await page.evaluate(() => {
    const v = document.querySelector('video')
    return { t: v.currentTime, d: v.duration }
  })
  log(`REMUX GROWING held ${JSON.stringify(held)} at ${Date.now() - loadedAt} ms`)
  check(Date.now() - loadedAt < 15_000, 'the hold was read while the playlist was still cut (raise the 15 s window if this machine is slow)')
  check(held.t >= 60 && held.t < 60.5 && Math.abs(held.d - 120) < 1, `a seek to 60 s past the 18 s remuxed waits at 60 s (not pulled back to a live edge) on a 120 s timeline (got ${JSON.stringify(held)})`)
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !v.paused && v.currentTime > 62
  }, null, { timeout: 30_000 })
  const errors = await page.evaluate(() => window.notesdStream.errors)
  check(errors.length === 0, `no error (got ${JSON.stringify(errors)})`)
  await shot('remux-growing')
  log('REMUX GROWING PASS on a growing playlist the page shows 120 s, holds a seek past the edge at 60 s, and plays on from there once the remux reaches it')
  await page.unroute(`**/api/stream/torrent/${hash}/hls/${index}/index.m3u8*`)

  // J6: one copy on disk. Both pages close: the finished torrent leaves the swarm and its original goes, the remux stays;
  // the next play is from disk on the remux alone (no swarm), and the file route says the file lives as its remux.
  await page.goto('about:blank')
  for (const s of [first, second]) {
    await page.request.post(`${base}/api/stream/sessions/${s.session_id}/position`, { headers: { origin: new URL(base).origin }, data: { position_s: 70, closed: true } })
  }
  const videoFiles = () => {
    const found = []
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) {
          if (!e.name.startsWith('notesd-')) walk(path.join(d, e.name))
        } else if (/\.(mkv|mp4)$/i.test(e.name)) found.push(path.join(d, e.name))
      }
    }
    walk(path.join(torrentsDir, hash))
    return found
  }
  for (let i = 0; i < 60 && videoFiles().length > 0; i++) await page.waitForTimeout(500)
  const daemonLog = readFileSync(path.join(RUN_DIR, 'daemon.log'), 'utf8')
  const deleted = daemonLog.split('\n').filter((l) => l.includes('torrent: deleted the original of'))
  log(`REMUX ONE COPY ${JSON.stringify({ videos: videoFiles(), deleted })}`)
  check(videoFiles().length === 0, `the original video file is gone from ${torrentsDir}/${hash} once the torrent left the swarm`)
  check(existsSync(path.join(dir, 'done.json')) && existsSync(path.join(dir, 'probe.json')), 'the remux and the probe kept beside it stay')
  check(deleted.length === 1 && /\(.+\.mkv, \d+ MB\)/.test(deleted[0]), 'one log line names the original deleted, with its size')
  const route = await page.request.get(`${base}/api/stream/torrent/${hash}/f/${index}`)
  check(route.status() === 410 && (await route.json()).error === 'remuxed', `the file route answers 410 remuxed (got ${route.status()})`)
  const third = await play(page, base)
  check(third.manifest_url === first.manifest_url && third.manifest_kind === 'hls' && third.torrent?.state === 'ready', `the replay plays the remux from disk (got ${third.manifest_kind} ${third.manifest_url} ${third.torrent?.state})`)
  const swarm = await (await page.request.get(`${base}/api/stream/torrent`)).json()
  check(swarm.swarm.length === 0, `no swarm is joined for the replay (got ${JSON.stringify(swarm.swarm)})`)
  await page.goto(`${base}/stream/${third.session_id}`)
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !!v && !v.paused && v.currentTime > 2 && v.webkitAudioDecodedByteCount > 0
  }, null, { timeout: 60_000 })
  log('REMUX ONE COPY PASS the original went once the torrent left the swarm; the replay plays the remux alone, from disk, with no swarm')
}

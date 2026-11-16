// fake-index.mjs: a Torrentio stand-in for `verify.sh up --torrent` (torrent phase 3). It lists the loopback fixture
// torrents phase 1's --torrent mode seeds, so a throwaway daemon never asks a real index.
//   node fake-index.mjs --fixtures DIR --titles TMDB_JSON --port-file FILE --log FILE
// Every release it answers is named `<Title>.<Year>.<tail>` after the asked title (TMDB_JSON is the fake TMDB's
// tmdb.json; the fake TMDB answers an IMDb id `tt` + the TMDB id padded to 7 digits, or a title's own `imdb_id`), so
// the finder's title check keeps it.
// GET /stream/movie/<imdb id>.json answers DIR/fixture.json's torrent (a single film, fileIdx of its video), tail
// `720p.WEB-DL.x264.AAC-NOTESD`.
// GET /stream/series/<imdb id>:<season>:<episode>.json answers DIR/pack.json's torrent (a season pack, tail
// `S01.720p.WEB-DL.x264.AAC-NOTESD`) with no fileIdx, so the daemon picks the episode's file itself.
// DIR/candidates.json, when present, replaces both answers for every query: [{info_hash, name, seeds?, size_bytes?}],
// each `name` a release tail (phases 5, 6 and 8 hand out the torrents they seed under DIR/seed/ this way).
// DIR/index-mode picks the answer: ok (default) | empty ({"streams": []}) | error (HTTP 500).
// Every request is one JSON line in the log: {at, path, mode}.
import http from 'node:http'
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const opts = {}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 2) opts[argv[i].replace(/^--/, '')] = argv[i + 1]
if (!opts.fixtures || !opts.titles || !opts['port-file'] || !opts.log) {
  console.error('usage: node fake-index.mjs --fixtures DIR --titles TMDB_JSON --port-file FILE --log FILE')
  process.exit(2)
}

const read = (name) => {
  const file = path.join(opts.fixtures, name)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}
const mode = () => {
  const file = path.join(opts.fixtures, 'index-mode')
  return (existsSync(file) ? readFileSync(file, 'utf8').trim() : '') || 'ok'
}
const size = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(2)} MB`)

// The fake TMDB's titles by the IMDb id it hands out for them.
const tmdb = JSON.parse(readFileSync(opts.titles, 'utf8'))
const imdbOf = (x) => x.imdb_id ?? `tt${String(x.id).padStart(7, '0')}`
const titleOf = (imdb) => {
  for (const m of tmdb.movies ?? []) if (imdbOf(m) === imdb) return { name: m.title, year: (m.release_date ?? '').slice(0, 4) }
  for (const t of tmdb.tv ?? []) if (imdbOf(t) === imdb) return { name: t.name, year: (t.first_air_date ?? '').slice(0, 4) }
  return { name: 'Unknown Title', year: '2026' }
}
const dotted = (title) => `${title.name.replace(/[^A-Za-z0-9]+/g, '.').replace(/^\.|\.$/g, '')}${title.year ? `.${title.year}` : ''}`

// One Torrentio stream in its real shape: the release on the first title line, the file on the second for a pack,
// then seeds, size and the source index.
function stream(fixture, release, { fileIdx, fileName, seeds = 25 }) {
  const total = fixture.size_bytes ?? (fixture.files ?? []).reduce((n, f) => n + (f.length ?? 0), 0)
  const lines = [release, ...(fileIdx === undefined ? [] : [fileName]), `👤 ${seeds} 💾 ${size(total)} ⚙️ VerifyFixture`]
  return {
    name: 'Torrentio\n720p',
    title: lines.join('\n'),
    infoHash: fixture.info_hash,
    ...(fileIdx === undefined ? {} : { fileIdx }),
    behaviorHints: { bingeGroup: `torrentio|${fixture.info_hash}`, ...(fileName === undefined ? {} : { filename: fileName }) },
    sources: [...(fixture.trackers ?? []).map((t) => `tracker:${t}`), `dht:${fixture.info_hash}`],
  }
}

function answer(pathname) {
  if (mode() === 'empty') return [200, { streams: [] }]
  let m
  const listed = read('candidates.json')
  if ((m = pathname.match(/^\/stream\/(?:movie|series)\/(tt\d+)(?::\d+:\d+)?\.json$/)) && Array.isArray(listed)) {
    const title = dotted(titleOf(m[1]))
    return [200, { streams: listed.map((c) => stream(c, `${title}.${c.name}`, { seeds: c.seeds ?? 25 })) }]
  }
  if ((m = pathname.match(/^\/stream\/movie\/(tt\d+)\.json$/))) {
    const film = read('fixture.json')
    if (film === null) return [200, { streams: [] }]
    const video = (film.files ?? []).find((f) => /\.(mp4|mkv|webm)$/i.test(f.path)) ?? film.files?.[0]
    return [200, { streams: [stream(film, `${dotted(titleOf(m[1]))}.720p.WEB-DL.x264.AAC-NOTESD`, { fileIdx: video?.index ?? 0, fileName: video?.path.split('/').pop() })] }]
  }
  if ((m = pathname.match(/^\/stream\/series\/(tt\d+):(\d+):(\d+)\.json$/))) {
    const pack = read('pack.json')
    if (pack === null) return [200, { streams: [] }]
    return [200, { streams: [stream(pack, `${dotted({ ...titleOf(m[1]), year: '' })}.S01.720p.WEB-DL.x264.AAC-NOTESD`, {})] }]
  }
  return [404, { error: 'not found' }]
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const now = mode()
  appendFileSync(opts.log, `${JSON.stringify({ at: new Date().toISOString(), path: url.pathname, mode: now })}\n`)
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
    return
  }
  if (now === 'error') {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('fake index: mode error')
    return
  }
  const [status, body] = answer(url.pathname)
  res.writeHead(status, { 'content-type': 'application/json;charset=utf-8' })
  res.end(JSON.stringify(body))
})
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address()
  writeFileSync(`${opts['port-file']}.tmp`, String(port))
  renameSync(`${opts['port-file']}.tmp`, opts['port-file'])
  console.log(`fake torrent index on http://127.0.0.1:${port}`)
})
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => process.exit(0))

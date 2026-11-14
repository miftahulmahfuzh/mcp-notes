// fake-tmdb.mjs: a TMDB v3 stand-in for `verify.sh up --movies`. Serves tmdb.json (search, details
// with credits, seasons, people) and solid-colour PNG posters on 127.0.0.1, on any free port.
//   node fake-tmdb.mjs --data tmdb.json --port-file FILE --log FILE
// The daemon reaches it through TMDB_API_BASE=http://127.0.0.1:<port>/3 and
// TMDB_IMAGE_BASE=http://127.0.0.1:<port>/t/p. Every request is appended to the log, with
// `api_key` taken out of the query and no header values.
import http from 'node:http'
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import zlib from 'node:zlib'

const opts = {}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 2) opts[argv[i].replace(/^--/, '')] = argv[i + 1]
if (!opts.data || !opts['port-file'] || !opts.log) {
  console.error('usage: node fake-tmdb.mjs --data tmdb.json --port-file FILE --log FILE')
  process.exit(2)
}
const data = JSON.parse(readFileSync(opts.data, 'utf8'))
const movies = data.movies
const tvs = data.tv
const people = data.people
let origin = ''

const norm = (s) =>
  String(s ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')

// Exact normalized name first, then containment (both sides at least 4 characters), then the year filter.
function search(list, query, nameKeys, dateKey, year) {
  const q = norm(query)
  if (!q) return []
  const hits = []
  for (const item of list) {
    const names = nameKeys.map((k) => norm(item[k])).filter(Boolean)
    const score = names.includes(q)
      ? 2
      : q.length >= 4 && names.some((n) => n.length >= 4 && (n.includes(q) || q.includes(n)))
        ? 1
        : 0
    if (score === 0) continue
    if (year && dateKey && String(item[dateKey] ?? '').slice(0, 4) !== String(year)) continue
    hits.push({ score, item })
  }
  return hits.sort((a, b) => b.score - a.score).map((h) => h.item)
}

const movieSummary = (m) => ({
  adult: false,
  backdrop_path: m.backdrop_path,
  genre_ids: m.genres.map((g) => g.id),
  id: m.id,
  original_language: m.original_language,
  original_title: m.original_title,
  overview: m.overview,
  popularity: m.popularity,
  poster_path: m.poster_path,
  release_date: m.release_date,
  title: m.title,
  video: false,
  vote_average: m.vote_average,
  vote_count: m.vote_count,
})
const tvSummary = (t) => ({
  adult: false,
  backdrop_path: t.backdrop_path,
  genre_ids: t.genres.map((g) => g.id),
  id: t.id,
  origin_country: t.origin_country,
  original_language: t.original_language,
  original_name: t.original_name,
  overview: t.overview,
  popularity: t.popularity,
  poster_path: t.poster_path,
  first_air_date: t.first_air_date,
  name: t.name,
  vote_average: t.vote_average,
  vote_count: t.vote_count,
})
const personSummary = (p) => ({
  adult: false,
  id: p.id,
  name: p.name,
  known_for_department: p.known_for_department,
  profile_path: p.profile_path,
  popularity: p.popularity,
  known_for: [],
})
const page = (results) => ({ page: 1, results, total_pages: 1, total_results: results.length })
const byId = (list, id) => list.find((x) => String(x.id) === String(id))
const notFound = () => [404, { success: false, status_code: 34, status_message: 'The resource you requested could not be found.' }]

function searchMovies(s) {
  return search(movies, s.get('query'), ['title', 'original_title'], 'release_date', s.get('primary_release_year') ?? s.get('year'))
}
function searchTv(s) {
  return search(tvs, s.get('query'), ['name', 'original_name'], 'first_air_date', s.get('first_air_date_year') ?? s.get('year'))
}

function route(url) {
  const p = url.pathname.replace(/^\/3(?=\/)/, '')
  const s = url.searchParams
  let m
  if (p === '/configuration') {
    return [200, {
      images: {
        base_url: `${origin}/t/p/`,
        secure_base_url: `${origin}/t/p/`,
        poster_sizes: ['w92', 'w154', 'w185', 'w342', 'w500', 'w780', 'original'],
        profile_sizes: ['w45', 'w185', 'h632', 'original'],
        still_sizes: ['w92', 'w185', 'w300', 'original'],
        backdrop_sizes: ['w300', 'w780', 'w1280', 'original'],
        logo_sizes: ['w45', 'w92', 'w154', 'w185', 'w300', 'w500', 'original'],
      },
    }]
  }
  if (p === '/search/movie') return [200, page(searchMovies(s).map(movieSummary))]
  if (p === '/search/tv') return [200, page(searchTv(s).map(tvSummary))]
  if (p === '/search/multi') {
    return [200, page([
      ...searchMovies(s).map((x) => ({ ...movieSummary(x), media_type: 'movie' })),
      ...searchTv(s).map((x) => ({ ...tvSummary(x), media_type: 'tv' })),
    ])]
  }
  if (p === '/search/person') return [200, page(search(people, s.get('query'), ['name'], null, null).map(personSummary))]
  if ((m = p.match(/^\/movie\/(\d+)$/))) {
    const x = byId(movies, m[1])
    return x ? [200, x] : notFound()
  }
  if ((m = p.match(/^\/movie\/(\d+)\/credits$/))) {
    const x = byId(movies, m[1])
    return x ? [200, { id: x.id, ...x.credits }] : notFound()
  }
  if ((m = p.match(/^\/tv\/(\d+)$/))) {
    const x = byId(tvs, m[1])
    if (!x) return notFound()
    const { seasons_detail: _seasons, ...details } = x
    return [200, details]
  }
  if ((m = p.match(/^\/tv\/(\d+)\/(aggregate_credits|credits)$/))) {
    const x = byId(tvs, m[1])
    return x ? [200, { id: x.id, ...x[m[2]] }] : notFound()
  }
  if ((m = p.match(/^\/tv\/(\d+)\/season\/(\d+)$/))) {
    const season = byId(tvs, m[1])?.seasons_detail?.[String(Number(m[2]))]
    return season ? [200, season] : notFound()
  }
  if ((m = p.match(/^\/person\/(\d+)$/))) {
    const x = byId(people, m[1])
    if (!x) return notFound()
    const { combined_credits: _credits, ...person } = x
    return [200, person]
  }
  if ((m = p.match(/^\/person\/(\d+)\/(combined_credits|movie_credits|tv_credits)$/))) {
    const x = byId(people, m[1])
    if (!x) return notFound()
    const want = m[2] === 'movie_credits' ? 'movie' : m[2] === 'tv_credits' ? 'tv' : null
    const keep = (list) => (want ? list.filter((c) => c.media_type === want) : list)
    return [200, { id: x.id, cast: keep(x.combined_credits.cast), crew: keep(x.combined_credits.crew) }]
  }
  return notFound()
}

// Minimal PNG encoder: one solid colour per poster path, so the grid shows distinct tiles.
function crc32(buf) {
  let crc = 0xffffffff
  for (const byte of buf) {
    crc ^= byte
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, body) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(body.length)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([len, typed, crc])
}
function png(width, height, [r, g, b]) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = r
    row[2 + x * 3] = g
    row[3 + x * 3] = b
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const posters = new Map()
function poster(name) {
  if (!posters.has(name)) {
    let h = 0
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
    posters.set(name, png(120, 180, [40 + (h & 0x7f), 40 + ((h >> 8) & 0x7f), 40 + ((h >> 16) & 0x7f)]))
  }
  return posters.get(name)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const logged = new URL(url)
  logged.searchParams.delete('api_key')
  const auth = req.headers.authorization ? 'bearer' : url.searchParams.has('api_key') ? 'api_key' : 'none'
  appendFileSync(opts.log, `${new Date().toISOString()} ${req.method} ${logged.pathname}${logged.search} auth=${auth}\n`)
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
    return
  }
  const img = url.pathname.match(/^\/t\/p\/[^/]+\/(.+)$/)
  if (img) {
    const body = poster(img[1])
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': body.length, 'cache-control': 'max-age=3600' })
    res.end(body)
    return
  }
  const [status, body] = req.method === 'GET' ? route(url) : [405, { success: false, status_message: 'GET only' }]
  res.writeHead(status, { 'content-type': 'application/json;charset=utf-8' })
  res.end(JSON.stringify(body))
})
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address()
  origin = `http://127.0.0.1:${port}`
  writeFileSync(`${opts['port-file']}.tmp`, String(port))
  renameSync(`${opts['port-file']}.tmp`, opts['port-file'])
  console.log(`fake TMDB on ${origin}`)
})
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => process.exit(0))

// fake-tmdb.mjs: a TMDB v3 stand-in for `verify.sh up --movies`. Serves tmdb.json (search, details
// with credits and videos, seasons, people, the prober's lists) and generated PNG posters on 127.0.0.1, on any free port.
//   node fake-tmdb.mjs --data tmdb.json --port-file FILE --log FILE [--extra tmdb-discovery.json]
// --extra adds the titles, people, companies and streaming services of `verify.sh up --discovery`
// (a compact file, expanded by expandExtra below), and with them company search, the watch-provider
// list and discover's date, language, company and service filters. The same file gives TMDB's two
// genre lists (films and series differ) and a few keywords, for discover's genre and keyword
// filters and /search/keyword.
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
const companies = new Map()
const watchProviders = []
// --extra: TMDB's own genre lists per kind, and its keywords. Without it a kind's genres are those its titles carry.
const genreLists = { movie: null, tv: null }
const keywords = []
for (const x of [...movies, ...tvs]) for (const c of x.production_companies ?? []) companies.set(c.id, c)
if (opts.extra) expandExtra(JSON.parse(readFileSync(opts.extra, 'utf8')))

// The compact discovery file -> full TMDB objects. A title names its companies and services by id,
// its genres (`genre_ids`, of its kind's list; Drama without them) and keywords (`keywords`) by id,
// its cast as [person id, character] and its director by person id; a series gives each season as
// {season, from, to, air_date} (episode numbers from..to, a week apart). People get their
// combined_credits from the titles that name them.
function expandExtra(extra) {
  for (const c of extra.companies ?? []) companies.set(c.id, { logo_path: null, ...c })
  genreLists.movie = extra.genres?.movie ?? null
  genreLists.tv = extra.genres?.tv ?? null
  keywords.push(...(extra.keywords ?? []))
  const genresFor = (kind, ids) => (ids ?? [18]).map((id) => (genreLists[kind] ?? []).find((g) => g.id === id) ?? { id, name: id === 18 ? 'Drama' : `Genre ${id}` })
  watchProviders.push(...(extra.watch_providers ?? []))
  const persons = new Map((extra.people ?? []).map((p) => [p.id, { profile_path: null, biography: 'Verify fixture.', combined_credits: { cast: [], crew: [] }, ...p }]))
  const companyRefs = (ids) => (ids ?? []).map((id) => companies.get(id))
  const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10)
  const credit = (list, personId, entry) => persons.get(personId)?.combined_credits[list].push(entry)
  for (const m of extra.movies ?? []) {
    const cast = (m.cast ?? []).map(([id, character], order) => ({ id, name: persons.get(id).name, character, order, profile_path: null, known_for_department: 'Acting' }))
    const crew = m.director ? [{ id: m.director, name: persons.get(m.director).name, job: 'Director', department: 'Directing', profile_path: null }] : []
    const full = {
      original_title: m.title, vote_average: 7, vote_count: 300, runtime: 110, poster_path: null, backdrop_path: null,
      overview: `Verify fixture. ${m.title}.`, videos: { results: [] }, ...m, genres: genresFor('movie', m.genre_ids), keywords: m.keywords ?? [],
      production_companies: companyRefs(m.companies), watch_providers: m.providers ?? [], credits: { cast, crew },
    }
    movies.push(full)
    const summary = { id: m.id, media_type: 'movie', title: full.title, original_title: full.original_title, original_language: full.original_language, release_date: full.release_date, poster_path: null, popularity: full.popularity, vote_count: full.vote_count, genre_ids: full.genres.map((g) => g.id) }
    for (const [id, character] of m.cast ?? []) credit('cast', id, { ...summary, character, credit_id: `fxd-c-${m.id}-${id}` })
    if (m.director) credit('crew', m.director, { ...summary, job: 'Director', department: 'Directing', credit_id: `fxd-d-${m.id}` })
  }
  for (const t of extra.tv ?? []) {
    const seasons_detail = {}
    const seasons = []
    for (const s of t.seasons) {
      const episodes = []
      for (let n = s.from; n <= s.to; n++) {
        episodes.push({ id: t.id * 10000 + n + s.season * 1000000, season_number: s.season, episode_number: n, name: `Episode ${n}`, air_date: addDays(s.air_date, (n - s.from) * 7), runtime: 45, overview: `Verify fixture episode ${n}.`, still_path: null })
      }
      seasons_detail[String(s.season)] = { id: t.id * 100 + s.season, season_number: s.season, name: `Season ${s.season}`, air_date: s.air_date, overview: '', poster_path: null, episodes, videos: { results: [] } }
      seasons.push({ id: t.id * 100 + s.season, season_number: s.season, episode_count: episodes.length, air_date: s.air_date, name: `Season ${s.season}`, poster_path: null, overview: '' })
    }
    const cast = (t.cast ?? []).map(([id, character], order) => ({ id, name: persons.get(id).name, profile_path: null, order, total_episode_count: 1, roles: [{ credit_id: `fxd-${t.id}-${id}`, character, episode_count: 1 }] }))
    const full = {
      original_name: t.name, origin_country: [], episode_run_time: [45], vote_average: 7.5, vote_count: 300, poster_path: null, backdrop_path: null,
      overview: `Verify fixture. ${t.name}.`, created_by: [], videos: { results: [] }, ...t, genres: genresFor('tv', t.genre_ids), keywords: t.keywords ?? [],
      number_of_seasons: seasons.length, number_of_episodes: seasons.reduce((n, s) => n + s.episode_count, 0),
      production_companies: companyRefs(t.companies), watch_providers: t.providers ?? [], seasons, seasons_detail,
      aggregate_credits: { cast, crew: [] }, credits: { cast: [], crew: [] },
    }
    tvs.push(full)
    for (const [id, character] of t.cast ?? []) {
      credit('cast', id, { id: t.id, media_type: 'tv', name: full.name, original_name: full.original_name, original_language: full.original_language, first_air_date: full.first_air_date, poster_path: null, popularity: full.popularity, vote_count: full.vote_count, genre_ids: full.genres.map((g) => g.id), character, episode_count: 1, credit_id: `fxd-c-${t.id}-${id}` })
    }
  }
  people.push(...persons.values())
}
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
const byPopularity = (list) => [...list].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
// Every list has one page: page 2 and later are empty.
const firstPageOnly = (s, results) => (Number(s.get('page') ?? 1) > 1 ? [] : results)
function listOf(kind, keep = () => true) {
  return kind === 'movie' ? byPopularity(movies.filter(keep)).map(movieSummary) : byPopularity(tvs.filter(keep)).map(tvSummary)
}
function genresOf(kind) {
  if (genreLists[kind]) return genreLists[kind]
  const seen = new Map()
  for (const x of kind === 'movie' ? movies : tvs) for (const g of x.genres) seen.set(g.id, g.name)
  return [...seen].map(([id, name]) => ({ id, name }))
}

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
  // The stream prober's lists: trending and popular are every title of the kind by popularity,
  // discover keeps one genre, recommendations are the kind's other titles.
  if ((m = p.match(/^\/trending\/(movie|tv)\/(?:day|week)$/))) return [200, page(firstPageOnly(s, listOf(m[1])))]
  if ((m = p.match(/^\/(movie|tv)\/popular$/))) return [200, page(firstPageOnly(s, listOf(m[1])))]
  if ((m = p.match(/^\/genre\/(movie|tv)\/list$/))) return [200, { genres: genresOf(m[1]) }]
  if ((m = p.match(/^\/discover\/(movie|tv)$/))) {
    // Like TMDB: ids joined by `,` must all fit, ids joined by `|` any one.
    const idsOf = (name) => {
      const raw = s.get(name)
      return raw ? { all: !raw.includes('|'), ids: raw.split(/[,|]/) } : null
    }
    const fits = (want, has) => !want || (want.all ? want.ids.every((id) => has.includes(id)) : want.ids.some((id) => has.includes(id)))
    const want = idsOf('with_genres')
    const wantKeywords = idsOf('with_keywords')
    const dateKey = m[1] === 'movie' ? 'release_date' : 'first_air_date'
    const dateParam = m[1] === 'movie' ? 'primary_release_date' : 'first_air_date'
    const from = s.get(`${dateParam}.gte`)
    const to = s.get(`${dateParam}.lte`)
    const language = s.get('with_original_language')?.split('|') ?? null
    const company = s.get('with_companies')?.split('|') ?? null
    const provider = s.get('with_watch_providers')
    // Like TMDB: a service filter without a region filters nothing out.
    const region = s.get('watch_region')
    const keep = (x) =>
      fits(want, x.genres.map((g) => String(g.id))) &&
      fits(wantKeywords, (x.keywords ?? []).map(String)) &&
      (!from || String(x[dateKey] ?? '') >= from) &&
      (!to || (x[dateKey] && String(x[dateKey]) <= to)) &&
      (!language || language.includes(x.original_language)) &&
      (!company || (x.production_companies ?? []).some((c) => company.includes(String(c.id)))) &&
      (!provider || !region || (x.watch_providers ?? []).some((id) => String(id) === provider))
    const listed = listOf(m[1], keep)
    if ((s.get('sort_by') ?? '').endsWith('_date.desc')) listed.sort((a, b) => String(b[dateKey] ?? '').localeCompare(String(a[dateKey] ?? '')))
    return [200, page(firstPageOnly(s, listed))]
  }
  if (p === '/search/keyword') {
    const q = String(s.get('query') ?? '').trim().toLowerCase()
    return [200, page(q ? keywords.filter((k) => k.name.includes(q)) : [])]
  }
  if (p === '/search/company') {
    const q = norm(s.get('query'))
    return [200, page(q ? [...companies.values()].filter((c) => norm(c.name).includes(q)).map((c) => ({ id: c.id, name: c.name, logo_path: null, origin_country: c.origin_country ?? '' })) : [])]
  }
  if ((m = p.match(/^\/watch\/providers\/(movie|tv)$/))) {
    return [200, { results: watchProviders.map((w) => ({ logo_path: null, display_priorities: {}, ...w })) }]
  }
  if ((m = p.match(/^\/(movie|tv)\/(\d+)\/recommendations$/))) {
    const x = byId(m[1] === 'movie' ? movies : tvs, m[2])
    if (!x) return notFound()
    return [200, page(firstPageOnly(s, listOf(m[1], (y) => y.id !== x.id)))]
  }
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
  // Torrent phase 3: the IMDb id the torrent indexes are asked by. A title may name its own imdb_id; else tt + the TMDB id.
  if ((m = p.match(/^\/(movie|tv)\/(\d+)\/external_ids$/))) {
    const x = byId(m[1] === 'movie' ? movies : tvs, m[2])
    return x ? [200, { id: x.id, imdb_id: x.imdb_id ?? `tt${String(x.id).padStart(7, '0')}` }] : notFound()
  }
  // Trailers: How to Make a Killing has one, MobLand none of its own and one for season 1.
  if ((m = p.match(/^\/(movie|tv)\/(\d+)\/videos$/))) {
    const x = byId(m[1] === 'movie' ? movies : tvs, m[2])
    return x ? [200, { id: x.id, results: x.videos?.results ?? [] }] : notFound()
  }
  if ((m = p.match(/^\/tv\/(\d+)\/season\/(\d+)\/videos$/))) {
    const season = byId(tvs, m[1])?.seasons_detail?.[String(Number(m[2]))]
    return season ? [200, { id: season.id, results: season.videos?.results ?? [] }] : notFound()
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

// Minimal PNG encoder: one solid colour per image path (the fallback, and what profiles and stills get).
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
    posters.set(name, png(120, 180, tint(name)))
  }
  return posters.get(name)
}
function hash(name) {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h
}
function tint(name) {
  const h = hash(name)
  return [40 + (h & 0x7f), 40 + ((h >> 8) & 0x7f), 40 + ((h >> 16) & 0x7f)]
}

// Drawn art for the paths tmdb.json names: a poster with the title and year on it, a backdrop
// without text. Needs sharp (the repo's own dependency); without it, and for any other path
// (profiles, stills), the solid-colour PNG above is served. Always image/png.
const art = new Map()
for (const item of [...movies, ...tvs]) {
  const title = item.title ?? item.name
  const year = String(item.release_date ?? item.first_air_date ?? '').slice(0, 4)
  if (item.poster_path) art.set(item.poster_path.replace(/^\//, ''), { kind: 'poster', title, year })
  if (item.backdrop_path) art.set(item.backdrop_path.replace(/^\//, ''), { kind: 'backdrop', title, year })
}
const sharpLib = import('sharp').then(
  (m) => m.default,
  () => null,
)
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** Words packed into lines of at most `max` characters. */
function wrap(text, max) {
  const lines = []
  for (const word of String(text).split(/\s+/)) {
    const last = lines[lines.length - 1]
    if (last !== undefined && `${last} ${word}`.length <= max) lines[lines.length - 1] = `${last} ${word}`
    else lines.push(word)
  }
  return lines
}
/** A small seeded generator (mulberry32 over an FNV-1a hash), so each title gets its own steady art. */
function seeded(name) {
  let a = 0x811c9dc5
  for (const ch of name) a = Math.imul(a ^ ch.charCodeAt(0), 0x01000193) >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function artSvg(name, { kind, title, year }, width) {
  const rnd = seeded(`${title}poster`)
  const hue = Math.floor(rnd() * 360)
  const hue2 = (hue + 30 + Math.floor(rnd() * 60)) % 360
  const height = kind === 'poster' ? Math.round(width * 1.5) : Math.round((width * 9) / 16)
  const u = width / 100
  const field = kind === 'poster' ? height * 0.6 : height
  const shapes = []
  for (let i = 0; i < 6; i++) {
    const cx = rnd() * width
    const cy = rnd() * field
    const r = (8 + rnd() * 26) * u
    shapes.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="hsl(${(hue2 + i * 12) % 360} 72% ${50 + i * 5}%)" opacity="${(0.1 + rnd() * 0.2).toFixed(2)}"/>`)
  }
  const base = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 48% 32%)"/><stop offset="1" stop-color="hsl(${hue2} 52% 11%)"/></linearGradient>`,
    `<linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0.45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.62"/></linearGradient></defs>`,
    `<rect width="100%" height="100%" fill="url(#g)"/>`,
    ...shapes,
    `<rect width="100%" height="100%" fill="url(#f)"/>`,
  ]
  if (kind === 'poster') {
    const lines = wrap(title.toUpperCase(), 10)
    const longest = Math.max(...lines.map((l) => l.length))
    const size = Math.min(13, 100 / longest) * u
    const top = height - 17 * u - (lines.length - 1) * size * 1.1
    lines.forEach((line, i) => {
      base.push(
        `<text x="${8 * u}" y="${(top + i * size * 1.1).toFixed(1)}" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700" font-size="${size.toFixed(1)}" fill="#f5f1e8">${esc(line)}</text>`,
      )
    })
    base.push(`<rect x="${8 * u}" y="${(height - 12.5 * u).toFixed(1)}" width="${12 * u}" height="${(0.8 * u).toFixed(1)}" fill="hsl(${hue2} 80% 68%)"/>`)
    if (year) {
      base.push(
        `<text x="${8 * u}" y="${(height - 5.5 * u).toFixed(1)}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${(5.4 * u).toFixed(1)}" letter-spacing="${(0.6 * u).toFixed(1)}" fill="#f5f1e8" opacity="0.78">${esc(year)}</text>`,
      )
    }
  }
  base.push('</svg>')
  return base.join('')
}
const drawn = new Map()
/** The PNG for one image URL (`/t/p/<size>/<name>`). */
function image(size, name) {
  const spec = art.get(name)
  if (!spec) return Promise.resolve(poster(name))
  const key = `${size}/${name}`
  if (!drawn.has(key)) {
    const asked = Number(/^w(\d+)$/.exec(size)?.[1] ?? 500)
    const width = Math.min(Math.max(asked, 92), spec.kind === 'poster' ? 500 : 1280)
    drawn.set(
      key,
      sharpLib
        .then((sharp) => (sharp ? sharp(Buffer.from(artSvg(name, spec, width))).png({ compressionLevel: 9 }).toBuffer() : poster(name)))
        .catch(() => poster(name)),
    )
  }
  return drawn.get(key)
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
  const img = url.pathname.match(/^\/t\/p\/([^/]+)\/(.+)$/)
  if (img) {
    image(img[1], img[2]).then((body) => {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': body.length, 'cache-control': 'max-age=3600' })
      res.end(body)
    })
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

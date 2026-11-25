import { Hono } from 'hono'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import type { AppDeps } from '../../src/deps.js'
import { moviesGuideRoutes } from '../../src/http/moviesGuideApi.js'
import { GenreGuides, type EntityGuide, type GuideWriter } from '../../src/movies/guides.js'
import { getTitle } from '../../src/movies/read.js'
import { MoviesRepo } from '../../src/movies/repo.js'
import { MovieEvents, type MoviesService } from '../../src/movies/service.js'
import { MovieStreams } from '../../src/movies/streams.js'
import type { TmdbClient, TmdbDiscovery, TmdbPersonCredit, TmdbProfiles, TmdbSearchHit } from '../../src/movies/tmdb.js'
import { movieMeta, tvMeta } from './helpers/movieMeta.js'
import { fakeTmdb, MOVIES_TEST_CONFIG } from './helpers/moviesSeed.js'
import { closeTestDb, openTestDb, truncateAll } from './setup.js'

const HOST = 'host-a'
const CTX = { host: HOST, imageBase: MOVIES_TEST_CONFIG.tmdb.imageBase }
const HEADERS = { origin: 'http://localhost', 'content-type': 'application/json' }
const T0 = new Date('2026-11-18T12:00:00.000Z')
const FILM = { kind: 'movie' as const, tmdbId: 550 }
const SERIES = { kind: 'tv' as const, tmdbId: 247718 }

const credit = (over: Partial<TmdbPersonCredit>): TmdbPersonCredit => ({
  kind: 'movie', tmdbId: 1, title: 'A', releaseDate: '2020-01-01', year: 2020, posterPath: '/a.jpg', popularity: 1, credit: 'cast', character: null, job: null, department: null, episodeCount: null, ...over,
})
const hit = (over: Partial<TmdbSearchHit>): TmdbSearchHit => ({ kind: 'movie', tmdbId: 1, title: 'A', originalTitle: 'A', releaseDate: '2020-01-01', year: 2020, overview: '', posterPath: '/a.jpg', popularity: 1, ...over })

describe('what the names and the play menu of a title page ask for', () => {
  let db: Db
  let repo: MoviesRepo
  let clock: Date
  let written: number
  let siteRuns: Array<[string, string[]]>
  let siteAnswer: (args: string[]) => unknown

  const tmdb: TmdbClient & TmdbProfiles & Pick<TmdbDiscovery, 'discover'> = {
    ...fakeTmdb(),
    movieDetails: (id: number) => Promise.resolve(movieMeta(id)),
    tvDetails: (id: number) => Promise.resolve(tvMeta(id)),
    personProfile: (id: number) =>
      Promise.resolve(id === 4 ? { personId: 4, name: 'Mara Example', biography: 'An actor.', knownFor: 'Acting', birthday: '1990-02-03', deathday: null, placeOfBirth: 'Bandung', profilePath: '/mara.jpg' } : null),
    personCredits: () =>
      Promise.resolve([
        credit({ tmdbId: 550, title: 'Film 550', releaseDate: '2026-02-20', character: 'Julia' }),
        credit({ tmdbId: 551, title: 'Film 551', releaseDate: '2024-05-01', character: 'Ann' }),
        credit({ tmdbId: 551, title: 'Film 551', releaseDate: '2024-05-01', credit: 'crew', job: 'Producer' }),
        credit({ tmdbId: 552, title: 'Film 552', releaseDate: '2022-01-01' }),
        credit({ tmdbId: 553, title: 'Undated', releaseDate: null }),
        credit({ kind: 'tv', tmdbId: 900, title: 'Talk', releaseDate: '2027-01-01', genreIds: [10767] }),
      ]),
    companyProfile: (id: number) => Promise.resolve(id === 3172 ? { id, name: 'Blumhouse Productions', description: '', headquarters: 'Los Angeles', country: 'US', homepage: null, logoPath: '/b.png', parent: 'Universal' } : null),
    discover: (kind, filter) =>
      Promise.resolve(filter.page === 1 && kind === 'movie' ? [hit({ tmdbId: 550, title: 'Film 550', releaseDate: '2026-02-20' }), hit({ tmdbId: 700, title: 'Old One', releaseDate: '2011-01-01' })] : []),
    searchMovie: (q: string) => Promise.resolve(q === 'Kind Hearts' ? [hit({ tmdbId: 800, title: 'Kind Hearts', releaseDate: '1949-06-13', year: 1949 })] : q === 'Film 550' ? [hit({ tmdbId: 550, title: 'Film 550' })] : []),
    searchTv: () => Promise.resolve([]),
  } as TmdbClient & TmdbProfiles & Pick<TmdbDiscovery, 'discover'>

  const writer: GuideWriter = {
    model: 'fake-model',
    write: (input) => {
      written++
      return Promise.resolve({
        description: `What ${input.genre} is in ${input.title}.`,
        titles: [
          { title: 'Kind Hearts', year: 1949, kind: 'movie', why: 'the same cold humour' },
          { title: 'Film 550', year: 2026, kind: 'movie', why: 'itself' },
          { title: 'Not On TMDB', year: null, kind: 'movie', why: 'unknown' },
        ],
      })
    },
  }

  beforeAll(() => {
    db = openTestDb()
    repo = new MoviesRepo(db)
  })
  afterAll(async () => {
    await closeTestDb(db)
  })
  beforeEach(async () => {
    await truncateAll(db)
    clock = T0
    written = 0
    siteRuns = []
    siteAnswer = () => ({ play: { playing: true, url: 'https://lk21.example/film-550' } })
  })

  const movies = () => ({ repo, tmdb, events: new MovieEvents(), host: HOST }) as unknown as MoviesService
  const streams = () => new MovieStreams(movies(), { now: () => clock, log: () => undefined })
  function app(over: { pahe?: (title: string, year: number | null) => Promise<unknown>; noWriter?: boolean; currentSince?: Date } = {}): Hono {
    const m = movies()
    const deps = {
      config: { movies: MOVIES_TEST_CONFIG },
      db,
      movies: m,
      genreGuides: new GenreGuides({ db, repo, tmdb, writer: over.noWriter ? null : writer, now: () => clock, currentSince: over.currentSince ?? new Date(0), log: () => undefined }),
      streaming: async (site: string, args: string[]) => {
        siteRuns.push([site, args])
        return siteAnswer(args)
      },
    } as unknown as Pick<AppDeps, 'config' | 'db' | 'movies' | 'genreGuides' | 'streaming'>
    const a = new Hono()
    a.route('/', moviesGuideRoutes(deps, { pahe: over.pahe ?? (() => Promise.resolve({ ok: true, matches: [], search_url: 'https://pahe.ink/?s=x' })) }))
    return a
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const get = async (a: Hono, url: string): Promise<{ status: number; json: any }> => {
    const res = await a.request(url)
    return { status: res.status, json: await res.json() }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const post = async (a: Hono, url: string, body: unknown, headers: Record<string, string> = HEADERS): Promise<{ status: number; json: any }> => {
    const res = await a.request(url, { method: 'POST', headers, body: JSON.stringify(body) })
    return { status: res.status, json: await res.json() }
  }

  describe('what last played a title through each method (movie_title_methods)', () => {
    it('keeps the torrent that played after a cloud provider played the title later, and one row per site', async () => {
      const s = streams()
      await s.recordPosition({ id: 's1', ref: FILM, source: { provider: 'Torrent' }, torrent: { infoHash: 'ab'.repeat(20) } }, { positionS: 1, durationS: 6000, ended: false })
      clock = new Date(T0.getTime() + 60_000)
      await s.recordPosition({ id: 's2', ref: FILM, source: { provider: 'VidRock' } }, { positionS: 1, durationS: 6000, ended: false })
      clock = new Date(T0.getTime() + 120_000)
      await s.recordSitePlay(FILM, 'lk21', 'https://lk21.example/film-550')
      const known = await s.channel(FILM)
      expect(known).toMatchObject({ channel: 'site', provider: 'lk21', infoHash: null })
      expect(known?.methods).toMatchObject({
        torrent: { infoHash: 'ab'.repeat(20), provider: null, season: null, playedAt: T0 },
        cloud: { provider: 'VidRock', infoHash: null },
        lk21: { siteUrl: 'https://lk21.example/film-550' },
      })
      // The same method again replaces its row; the others stay.
      clock = new Date(T0.getTime() + 180_000)
      await s.recordPosition({ id: 's3', ref: FILM, source: { provider: 'Torrent' }, torrent: { infoHash: 'cd'.repeat(20) } }, { positionS: 1, durationS: 6000, ended: false })
      expect((await s.channel(FILM))?.methods?.torrent?.infoHash).toBe('cd'.repeat(20))
      expect((await repo.methodsOf('movie-550', HOST)).map((m) => m.method).sort()).toEqual(['cloud', 'lk21', 'torrent'])
      const detail = await getTitle(db, 'movie-550', CTX)
      expect(detail?.played_methods.map((m) => [m.method, m.provider])).toEqual([
        ['torrent', null],
        ['lk21', null],
        ['cloud', 'VidRock'],
      ])
      // Another machine keeps its own.
      expect(await repo.methodsOf('movie-550', 'host-b')).toEqual([])
    })

    it("a series' row carries the episode that method last played", async () => {
      await streams().recordPosition({ id: 's1', ref: { ...SERIES, season: 1, episode: 2 }, source: { provider: 'Torrent' }, torrent: { infoHash: 'ab'.repeat(20) } }, { positionS: 1, durationS: 3000, ended: false })
      expect((await streams().channel({ ...SERIES, season: 1, episode: 3 }))?.methods?.torrent).toMatchObject({ season: 1, episode: 2 })
    })
  })

  describe('GET /api/movies/people/:id and /companies/:id', () => {
    it("a person's films newest first, each with the owner's mark read now; talk shows left out", async () => {
      const s = streams()
      await s.ensureTitle(FILM)
      await s.ensureTitle({ kind: 'movie', tmdbId: 551 })
      await s.ensureTitle({ kind: 'movie', tmdbId: 552 })
      await repo.setTitleUser('movie-551', { watched: true })
      await repo.setTitleUser('movie-552', { notInterested: true })
      await s.recordPosition({ id: 's1', ref: FILM, source: { provider: 'VidRock' } }, { positionS: 60, durationS: 6000, ended: false })
      const { status, json } = await get(app(), '/api/movies/people/4')
      expect(status).toBe(200)
      const guide = json as EntityGuide
      expect(guide.entity).toMatchObject({ kind: 'person', name: 'Mara Example', description: 'An actor.', facts: ['Acting', 'born 1990-02-03 in Bandung'], link: 'https://www.themoviedb.org/person/4' })
      expect(guide.entity.image_url).toMatch(/\/mara\.jpg$/)
      expect(guide.titles.map((t) => [t.title_id, t.mark, t.note, t.movie_id !== null])).toEqual([
        ['movie-550', 'started', 'as Julia', true],
        ['movie-551', 'watched', 'as Ann, Producer', true],
        ['movie-552', 'not_interested', 'cast', true],
        ['movie-553', null, 'cast', false],
      ])
      // A mark set now shows at the next read: nothing is kept with the list.
      await repo.setTitleUser('movie-551', { watched: false })
      expect(((await get(app(), '/api/movies/people/4')).json as EntityGuide).titles[1]?.mark).toBeNull()
      expect((await get(app(), '/api/movies/people/5')).status).toBe(404)
    })

    it("a studio's titles, with its logo, where it is and its parent; an empty description stays empty", async () => {
      const { json } = await get(app(), '/api/movies/companies/3172')
      const guide = json as EntityGuide
      expect(guide.entity).toMatchObject({ kind: 'company', name: 'Blumhouse Productions', description: '', facts: ['Los Angeles', 'part of Universal'] })
      expect(guide.titles.map((t) => [t.title_id, t.year, t.movie_id])).toEqual([
        ['movie-550', 2026, null],
        ['movie-700', 2011, null],
      ])
      expect((await get(app(), '/api/movies/companies/1')).status).toBe(404)
    })
  })

  describe('POST /api/movies/ensure', () => {
    it('stores a title the library does not hold and answers its movie id; same-origin only', async () => {
      const a = app()
      expect(await repo.titleById('movie-777')).toBeNull()
      const { status, json } = await post(a, '/api/movies/ensure', { kind: 'movie', tmdb_id: 777 })
      expect(status).toBe(200)
      expect(json.title_id).toBe('movie-777')
      expect(json.movie_id).toMatch(/^M-[0-9A-Z]{4}$/)
      expect((await post(a, '/api/movies/ensure', { kind: 'movie', tmdb_id: 777 })).json.movie_id).toBe(json.movie_id)
      expect((await post(a, '/api/movies/ensure', { kind: 'film', tmdb_id: 1 })).status).toBe(400)
      expect((await post(a, '/api/movies/ensure', { kind: 'movie', tmdb_id: 778 }, { origin: 'https://evil.example', 'content-type': 'application/json' })).status).toBe(403)
    })
  })

  describe('a genre, for one title', () => {
    it('is collated once, kept, and read from the store after; the title itself and a title TMDB does not list are left out', async () => {
      await streams().ensureTitle(FILM)
      const a = app()
      expect((await get(a, '/api/movies/movie-550/genres/Thriller')).json).toEqual({ guide: null, cached: true })
      const first = await post(a, '/api/movies/movie-550/genres/thriller', {})
      expect(first.status).toBe(200)
      expect(first.json.cached).toBe(false)
      expect(first.json.guide.entity).toMatchObject({ kind: 'genre', name: 'Thriller', description: 'What Thriller is in Film 550 (2026).' })
      expect(first.json.guide.titles.map((t: { title_id: string; note: string }) => [t.title_id, t.note])).toEqual([['movie-800', 'the same cold humour']])
      expect(first.json.guide.model).toBe('fake-model')
      const again = await post(a, '/api/movies/movie-550/genres/Thriller', {})
      expect(again.json.cached).toBe(true)
      expect(written).toBe(1)
      expect((await get(a, '/api/movies/movie-550/genres/THRILLER')).json.guide.titles).toHaveLength(1)
      await post(a, '/api/movies/movie-550/genres/Thriller', { refresh: true })
      expect(written).toBe(2)
      // The marks are today's, not the day it was written.
      await streams().ensureTitle({ kind: 'movie', tmdbId: 800 })
      await repo.setTitleUser('movie-800', { watched: true })
      expect((await get(a, '/api/movies/movie-550/genres/Thriller')).json.guide.titles[0].mark).toBe('watched')
    })

    it('a guide from before the lists grew is written again on its next click, and shown as it is when that fails', async () => {
      await streams().ensureTitle(FILM)
      await post(app(), '/api/movies/movie-550/genres/Thriller', {})
      expect(written).toBe(1)
      const later = new Date(clock.getTime() + 1000)
      expect((await get(app({ currentSince: later }), '/api/movies/movie-550/genres/Thriller')).json).toEqual({ guide: null, cached: true })
      const off = await post(app({ currentSince: later, noWriter: true }), '/api/movies/movie-550/genres/Thriller', {})
      expect([off.status, off.json.cached, off.json.guide.titles.length]).toEqual([200, true, 1])
      clock = new Date(later.getTime() + 1000)
      const anew = await post(app({ currentSince: later }), '/api/movies/movie-550/genres/Thriller', {})
      expect([anew.json.cached, written]).toEqual([false, 2])
      expect((await get(app({ currentSince: later }), '/api/movies/movie-550/genres/Thriller')).json.guide).not.toBeNull()
    })

    it('answers why not: a genre the title does not have, an unknown title, the model off', async () => {
      await streams().ensureTitle(FILM)
      expect((await post(app(), '/api/movies/movie-550/genres/Comedy', {})).json.error).toBe('not_a_genre')
      expect((await post(app(), '/api/movies/movie-999/genres/Comedy', {})).status).toBe(404)
      const off = await post(app({ noWriter: true }), '/api/movies/movie-550/genres/Thriller', {})
      expect([off.status, off.json.error]).toEqual([503, 'guide_off'])
      expect(written).toBe(0)
    })
  })

  describe('POST /api/movies/:id/site-play', () => {
    it("searches the site by the title's name and year the first time, and plays from the remembered page after", async () => {
      await streams().ensureTitle(FILM)
      const a = app()
      const first = await post(a, '/api/movies/movie-550/site-play', { site: 'lk21' })
      expect(first.status).toBe(200)
      expect(siteRuns).toEqual([['lk21', ['--play', 'Film 550', '2026']]])
      // The command reports a searched play itself; here the page is remembered as that report would leave it.
      await streams().recordSitePlay(FILM, 'lk21', 'https://lk21.example/film-550')
      siteRuns = []
      const again = await post(a, '/api/movies/movie-550/site-play', { site: 'lk21' })
      expect(again.json).toMatchObject({ ok: true, site: 'lk21', site_url: 'https://lk21.example/film-550' })
      expect(siteRuns).toEqual([['lk21', ['--play-url', 'https://lk21.example/film-550', '--no-report']]])
      // Another site knows nothing of that page.
      siteRuns = []
      await post(a, '/api/movies/movie-550/site-play', { site: 'idlix' })
      expect(siteRuns[0]).toEqual(['idlix', ['--play', 'Film 550', '2026']])
    })

    it('an episode goes with its numbers, and a site that does not start it says why', async () => {
      await streams().ensureTitle({ ...SERIES, season: 1, episode: 1 })
      const a = app()
      expect((await post(a, '/api/movies/tv-247718/site-play', { site: 'idlix' })).status).toBe(400)
      await post(a, '/api/movies/tv-247718/site-play', { site: 'idlix', season: 1, episode: 2 })
      expect(siteRuns[0]?.[1].slice(-4)).toEqual(['--episode', '2', '--season', '1'])
      siteAnswer = () => ({ play: { playing: false, skipped_play: 'several_matches' } })
      expect((await post(a, '/api/movies/tv-247718/site-play', { site: 'idlix', season: 1, episode: 2 })).json.error).toBe('several_matches')
      siteAnswer = () => ({ play: { playing: false, skipped_play: 'no_match' } })
      expect((await post(a, '/api/movies/tv-247718/site-play', { site: 'idlix', season: 1, episode: 2 })).status).toBe(404)
      expect((await post(a, '/api/movies/tv-247718/site-play', { site: 'netflix', season: 1, episode: 2 })).status).toBe(400)
    })
  })

  describe('GET /api/movies/:id/pahe', () => {
    it("asks the /pahe search for the title's name and year and answers its matches", async () => {
      await streams().ensureTitle(FILM)
      const asked: Array<[string, number | null]> = []
      const a = app({
        pahe: (title, year) => {
          asked.push([title, year])
          return Promise.resolve({ ok: true, search_url: 'https://pahe.ink/?s=film+550', matches: [{ title: 'Film 550 (2026) BluRay', name: 'film 550', year: 2026, release: 'BluRay', url: 'https://pahe.ink/film-550-bluray' }, { url: 'javascript:alert(1)' }] })
        },
      })
      const { json } = await get(a, '/api/movies/movie-550/pahe')
      expect(asked).toEqual([['Film 550', 2026]])
      expect(json).toEqual({ matches: [{ title: 'Film 550 (2026) BluRay', url: 'https://pahe.ink/film-550-bluray', year: 2026, release: 'BluRay' }], search_url: 'https://pahe.ink/?s=film+550' })
      const down = await get(app({ pahe: () => Promise.resolve({ ok: false, error: 'HTTP 503', search_url: 'https://pahe.ink/?s=film+550' }) }), '/api/movies/movie-550/pahe')
      expect([down.status, down.json.error, down.json.search_url]).toEqual([502, 'pahe_error', 'https://pahe.ink/?s=film+550'])
    })
  })
})

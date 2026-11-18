import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { moviePlays, movieTitleChannels } from '../../src/db/schema.js'
import { dbTitleLibrary } from '../../src/directStream/lookup.js'
import { moviesApiRoutes } from '../../src/http/moviesApi.js'
import { SITE_PLAY_HEADER, SITE_PLAY_PATH, SITE_TITLES_PATH, sitePlayRoutes } from '../../src/http/sitePlayApi.js'
import { getTitle, listStreamTitles, listTitles } from '../../src/movies/read.js'
import { MoviesRepo, streamFreshSince } from '../../src/movies/repo.js'
import { MovieEvents, type MoviesService } from '../../src/movies/service.js'
import { MovieStreams, type MovieStreamsSource } from '../../src/movies/streams.js'
import type { TmdbClient } from '../../src/movies/tmdb.js'
import { recordSitePlay } from '../../src/streaming/sitePlays.js'
import { movieMeta, tvMeta } from './helpers/movieMeta.js'
import { fakeTmdb } from './helpers/moviesSeed.js'
import { closeTestDb, openTestDb, truncateAll } from './setup.js'

const HOST = 'host-a'
const OTHER = 'host-b'
const CTX = { host: HOST, imageBase: 'https://image.tmdb.org/t/p' }
const T0 = new Date('2026-11-18T12:00:00.000Z')
const FIGHT_CLUB = { kind: 'movie' as const, tmdbId: 550 }
const MOBLAND = { kind: 'tv' as const, tmdbId: 247718 }
const SITE_URL = 'https://dramacool9.com.ro/mobland-2025'

function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * 60_000)
}

describe('how a title was last streamed (movie_title_channels)', () => {
  let db: Db
  let repo: MoviesRepo
  let clock: Date

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
  })

  function tmdb(): TmdbClient {
    return { ...fakeTmdb(), movieDetails: (id: number) => Promise.resolve(movieMeta(id)), tvDetails: (id: number) => Promise.resolve(tvMeta(id)) }
  }
  function moviesOf(host = HOST): MovieStreamsSource {
    return { repo, tmdb: tmdb(), events: new MovieEvents(), host }
  }
  function streams(host = HOST): MovieStreams {
    return new MovieStreams(moviesOf(host), { now: () => clock, log: () => undefined })
  }

  it("a play's first position report makes its source the title's channel, and the last one to play wins", async () => {
    const s = streams()
    expect(await s.channel(FIGHT_CLUB)).toBeNull()
    await s.recordPosition({ id: 'sess-1', ref: FIGHT_CLUB, source: { provider: 'VidRock' } }, { positionS: 3, durationS: 8340, ended: false })
    expect(await s.channel(FIGHT_CLUB)).toMatchObject({ channel: 'cloud', provider: 'VidRock', infoHash: null, siteUrl: null, season: null, episode: null })
    // A later report of the same session changes nothing: only the report that opens the play counts.
    clock = at(1)
    await s.recordPosition({ id: 'sess-1', ref: FIGHT_CLUB, source: { provider: 'VidRock' } }, { positionS: 60, durationS: 8340, ended: false })
    expect((await s.channel(FIGHT_CLUB))?.playedAt).toEqual(T0)
    clock = at(10)
    await s.recordPosition({ id: 'sess-2', ref: FIGHT_CLUB, source: { provider: 'Torrent' }, torrent: { infoHash: 'ab'.repeat(20) } }, { positionS: 1, durationS: 8340, ended: false })
    expect(await s.channel(FIGHT_CLUB)).toMatchObject({ channel: 'torrent', provider: null, infoHash: 'ab'.repeat(20), playedAt: at(10) })
    // The other machine has its own answer.
    expect(await streams(OTHER).channel(FIGHT_CLUB)).toBeNull()
  })

  it('a session that moves to another provider while it plays takes the play and the channel with it', async () => {
    const s = streams()
    await s.recordPosition({ id: 'sess-1', ref: FIGHT_CLUB, source: { provider: 'HyperLink' } }, { positionS: 3, durationS: 8340, ended: false })
    clock = at(2)
    await s.recordPosition({ id: 'sess-1', ref: FIGHT_CLUB, source: { provider: 'VidRock' } }, { positionS: 90, durationS: 8340, ended: false })
    expect(await s.channel(FIGHT_CLUB)).toMatchObject({ channel: 'cloud', provider: 'VidRock', playedAt: at(2) })
    const plays = await db.select().from(moviePlays).where(eq(moviePlays.titleId, 'movie-550'))
    expect(plays.map((p) => [p.provider, p.positionS])).toEqual([['VidRock', 90]])
  })

  it('a series has one channel for all its episodes, with the episode last played', async () => {
    const s = streams()
    await s.recordPosition({ id: 'sess-1', ref: { ...MOBLAND, season: 1, episode: 2 }, source: { provider: 'VidFast' } }, { positionS: 1, durationS: 3000, ended: false })
    expect(await s.channel({ ...MOBLAND, season: 1, episode: 3 })).toMatchObject({ channel: 'cloud', provider: 'VidFast', season: 1, episode: 2 })
  })

  it('keeps which kinds of stream found nothing, and a play of that kind clears it', async () => {
    const s = streams()
    await s.channelFailed(FIGHT_CLUB, 'cloud')
    clock = at(5)
    await s.channelFailed(FIGHT_CLUB, 'torrent')
    expect(await s.channel(FIGHT_CLUB)).toMatchObject({ channel: null, playedAt: null, cloudFailedAt: T0, torrentFailedAt: at(5) })
    const never = await getTitle(db, 'movie-550', CTX)
    expect(never?.played_through).toBeNull()
    expect(never?.stream_failed).toEqual({ cloud_at: T0.toISOString(), torrent_at: at(5).toISOString() })

    clock = at(9)
    await s.recordPosition({ id: 'sess-1', ref: FIGHT_CLUB, source: { provider: 'Torrent' }, torrent: { infoHash: 'cd'.repeat(20) } }, { positionS: 1, durationS: 8340, ended: false })
    const played = await getTitle(db, 'movie-550', CTX)
    expect(played?.played_through).toEqual({ channel: 'torrent', provider: null, played_at: at(9).toISOString(), season: null, episode: null })
    expect(played?.stream_failed).toEqual({ cloud_at: T0.toISOString(), torrent_at: null })
    // A later failure keeps the channel it last played through.
    await s.channelFailed(FIGHT_CLUB, 'torrent')
    expect((await s.channel(FIGHT_CLUB))?.channel).toBe('torrent')
  })

  it("a streaming site's play is one closed play row with the site as its provider, the title's channel, and puts the title on the Stream side", async () => {
    const s = streams()
    const kept = await s.recordSitePlay({ ...MOBLAND, season: 1, episode: 3 }, 'dramacool', SITE_URL)
    expect(kept?.titleId).toBe('tv-247718')
    const [play] = await db.select().from(moviePlays).where(eq(moviePlays.titleId, 'tv-247718'))
    expect(play).toMatchObject({ source: 'stream', provider: 'dramacool', season: 1, episode: 3, positionS: null, fileId: null, host: HOST })
    expect(play?.endedAt).toEqual(T0)
    expect(play?.streamSession).toMatch(/^site-/)
    expect(await s.channel({ ...MOBLAND, season: 1, episode: 4 })).toMatchObject({ channel: 'site', provider: 'dramacool', siteUrl: SITE_URL, season: 1, episode: 3 })

    const detail = await getTitle(db, 'tv-247718', CTX)
    expect(detail?.played_through).toEqual({ channel: 'site', provider: 'dramacool', played_at: T0.toISOString(), season: 1, episode: 3 })
    // The site's player reports no position: the episode is started, never finished by itself.
    expect(detail?.seasons.flatMap((x) => x.episodes).find((e) => e.season === 1 && e.episode === 3)?.state).toBe('in_progress')
    const since = streamFreshSince(T0, 7)
    expect((await listStreamTitles(db, {}, CTX, since)).map((t) => t.id)).toEqual(['tv-247718'])
    expect(await listStreamTitles(db, {}, { ...CTX, host: OTHER }, since)).toEqual([])
    expect(await listTitles(db, {}, CTX)).toEqual([])

    // A direct stream after it takes the channel over; the title then needs a verified source to stay listed.
    clock = at(30)
    await s.recordPosition({ id: 'sess-9', ref: { ...MOBLAND, season: 1, episode: 4 }, source: { provider: 'VidRock' } }, { positionS: 1, durationS: 3000, ended: false })
    expect(await s.channel(MOBLAND)).toMatchObject({ channel: 'cloud', provider: 'VidRock', siteUrl: null })
    expect(await listStreamTitles(db, {}, CTX, since)).toEqual([])
  })

  it('a file played here after the last stream is what the title was last played through', async () => {
    const s = streams()
    await s.recordPosition({ id: 'sess-1', ref: FIGHT_CLUB, source: { provider: 'VidRock' } }, { positionS: 3, durationS: 8340, ended: false })
    const { file } = await repo.upsertFile({ host: HOST, path: '/m/Fight.Club.1999.mkv', name: 'Fight.Club.1999.mkv', sizeBytes: 1, mtime: T0, durationS: 8340, source: 'scan', classification: { status: 'matched', titleId: 'movie-550', season: null, episode: null } } as never)
    await repo.startPlay({ fileId: file.id, host: HOST, source: 'live', startedAt: at(20), positionS: 5, durationS: 8340 } as never)
    expect((await getTitle(db, 'movie-550', CTX))?.played_through).toMatchObject({ channel: 'vlc', provider: null, played_at: at(20).toISOString() })
    // On the other machine nothing was played.
    expect((await getTitle(db, 'movie-550', { ...CTX, host: OTHER }))?.played_through).toBeNull()
  })

  it('the table refuses a row that does not say what it should', async () => {
    await streams().ensureTitle(FIGHT_CLUB)
    const insert = (values: Partial<typeof movieTitleChannels.$inferInsert>) => db.insert(movieTitleChannels).values({ titleId: 'movie-550', host: HOST, ...values })
    await expect(insert({ channel: 'site', provider: 'dramacool', playedAt: T0 })).rejects.toThrow()
    await expect(insert({ channel: 'cloud', playedAt: T0 })).rejects.toThrow()
    await expect(insert({ channel: 'torrent', provider: 'VidRock', playedAt: T0 })).rejects.toThrow()
    await expect(insert({ channel: 'cloud', provider: 'VidRock' })).rejects.toThrow()
    await expect(insert({ channel: 'vlc' as never, provider: 'x', playedAt: T0 })).rejects.toThrow()
  })

  describe('POST /api/movies/site-play', () => {
    function app(): Hono {
      const movies = { ...moviesOf(), tmdb: { ...tmdb(), searchTv: async () => [{ kind: 'tv', tmdbId: 247718, title: 'MobLand', originalTitle: 'MobLand', year: 2025, popularity: 9, posterPath: null, overview: '' }], searchMovie: async () => [] } } as unknown as MoviesService
      const a = new Hono()
      a.route('/', sitePlayRoutes({ db, movies }))
      return a
    }
    const REPORT = { site: 'dramacool', url: SITE_URL, name: 'MobLand', original_name: null, year: 2025, kind: 'series', season: 1, episode: 3 }
    const post = (a: Hono, body: unknown, headers: Record<string, string> = { [SITE_PLAY_HEADER]: '1' }) =>
      a.request(`http://127.0.0.1${SITE_PLAY_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

    it('keeps the play under the title TMDB lists, storing the title when it is new', async () => {
      const res = await post(app(), REPORT)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ recorded: true, title_id: 'tv-247718', season: 1, episode: 3 })
      expect((await getTitle(db, 'tv-247718', CTX))?.played_through).toMatchObject({ channel: 'site', provider: 'dramacool', season: 1, episode: 3 })
    })

    it('answers only the streaming command on this machine, and only a whole report', async () => {
      expect((await post(app(), REPORT, {})).status).toBe(403)
      expect((await app().request(`http://example.com${SITE_PLAY_PATH}`, { method: 'POST', headers: { [SITE_PLAY_HEADER]: '1' }, body: JSON.stringify(REPORT) })).status).toBe(403)
      expect((await post(app(), { ...REPORT, site: 'elsewhere' })).status).toBe(400)
      expect((await post(app(), { ...REPORT, extra: 1 })).status).toBe(400)
      const off = new Hono()
      off.route('/', sitePlayRoutes({ db, movies: null }))
      expect((await post(off, REPORT)).status).toBe(503)
    })
  })

  it('recordSitePlay finds a stored title by its name before it asks TMDB', async () => {
    await streams().ensureTitle(FIGHT_CLUB)
    const kept = await recordSitePlay(
      { site: 'lk21', url: 'https://tv12.lk21official.cc/film-550-2026', name: 'Film 550', year: 2026, kind: 'movie' },
      { lookup: { library: dbTitleLibrary(db), tmdb: null }, streams: streams(), log: () => undefined },
    )
    expect(kept).toEqual({ recorded: true, title_id: 'movie-550', season: null, episode: null })
  })

  it('a title streamed before any channel was kept answers by its last stream play, a site play left aside', async () => {
    const s = streams()
    await s.ensureTitle(FIGHT_CLUB)
    const play = (provider: string, session: string, startedAt: Date) =>
      db.insert(moviePlays).values({ titleId: 'movie-550', provider, streamSession: session, host: HOST, source: 'stream', startedAt, endedAt: startedAt, positionS: 10, durationS: 8340, updatedAt: startedAt })
    await play('VidLink', 'old-1', at(-600))
    await play('Torrent', 'old-2', at(-300))
    await play('lk21', 'site-old', at(-100))
    expect(await s.channel(FIGHT_CLUB)).toMatchObject({ channel: 'torrent', provider: null, playedAt: at(-300) })
    // The title's page reads its plays as they are: the site play is the last one.
    expect((await getTitle(db, 'movie-550', CTX))?.played_through).toMatchObject({ channel: 'site', provider: 'lk21' })
  })

  describe('a title TMDB does not list', () => {
    const DRAMA_URL = 'https://dramacool9.com.ro/hidden-summer-2026'
    const REPORT = { site: 'dramacool', url: DRAMA_URL, name: 'Hidden Summer', original_name: null, year: 2026, kind: 'series', season: 1, episode: 3 }
    const DETAILS = { poster_url: 'https://dramacool9.com.ro/wp-content/uploads/p.jpg', overview: 'A girl and her summer.', country: 'South Korea', status: 'Ongoing', year: 2026, genres: ['Drama'], also_known: 'Sumgyeojin Yeoreum' }
    const ORIGIN = { origin: 'http://127.0.0.1' }

    function setup(site: (args: string[]) => unknown = () => ({ ok: true, play: { playing: true, fullscreen: true } })) {
      const runs: string[][] = []
      const movies = { ...moviesOf(), tmdb: { ...tmdb(), searchTv: async () => [], searchMovie: async () => [] } } as unknown as MoviesService
      const streaming = async (_site: string, args: string[]) => {
        runs.push(args)
        return args[0] === '--details' ? { ok: true, details: DETAILS } : site(args)
      }
      const a = new Hono()
      a.route('/', sitePlayRoutes({ db, movies, streaming }))
      a.route('/', moviesApiRoutes({ db, movies, config: { movies: { tmdb: { imageBase: CTX.imageBase } }, directStream: { enabled: true, freshDays: 7 } }, service: null, directStream: {} } as never))
      const report = () => a.request(`http://127.0.0.1${SITE_PLAY_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', [SITE_PLAY_HEADER]: '1' }, body: JSON.stringify(REPORT) })
      const listed = async () => ((await (await a.request('http://127.0.0.1/api/movies/stream')).json()) as { site_titles: Array<Record<string, unknown>> }).site_titles
      return { a, runs, report, listed }
    }

    it("is kept with what the site's page says of it, and listed on the Stream side", async () => {
      const t = setup()
      const kept = (await (await t.report()).json()) as { site_title_id: number }
      expect(kept).toMatchObject({ recorded: true, title_id: null, season: 1, episode: 3 })
      expect(t.runs).toEqual([['--details', DRAMA_URL]])
      expect(await t.listed()).toEqual([
        { id: kept.site_title_id, site: 'dramacool', site_url: DRAMA_URL, kind: 'series', name: 'Hidden Summer', year: 2026, poster_url: DETAILS.poster_url, overview: DETAILS.overview, country: 'South Korea', status: 'Ongoing', genres: ['Drama'], also_known: 'Sumgyeojin Yeoreum', season: 1, episode: 3, played_at: expect.any(String) },
      ])
      // The same title played again is the same row, with the new episode.
      const again = (await (await t.a.request(`http://127.0.0.1${SITE_PLAY_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', [SITE_PLAY_HEADER]: '1' }, body: JSON.stringify({ ...REPORT, episode: 4 }) })).json()) as { site_title_id: number }
      expect(again.site_title_id).toBe(kept.site_title_id)
      expect((await t.listed()).map((x) => x.episode)).toEqual([4])
      // No title row was made for it.
      expect(await listStreamTitles(db, {}, CTX, streamFreshSince(T0, 7))).toEqual([])
    })

    it('plays the episode after the last one on its site again, or the one named, and keeps which', async () => {
      const t = setup()
      const { site_title_id: id } = (await (await t.report()).json()) as { site_title_id: number }
      const play = (body?: unknown) => t.a.request(`http://127.0.0.1${SITE_TITLES_PATH}/${id}/play`, { method: 'POST', headers: { 'content-type': 'application/json', ...ORIGIN }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      const next = await play()
      expect(next.status).toBe(200)
      expect(await next.json()).toEqual({ ok: true, site: 'dramacool', site_url: DRAMA_URL, season: 1, episode: 4, site_play: { playing: true, fullscreen: true } })
      expect(t.runs.at(-1)).toEqual(['--play-from', DRAMA_URL, '--episode', '4', '--season', '1', '--no-report'])
      expect((await (await play({ episode: 2 })).json()) as { episode: number }).toMatchObject({ episode: 2 })
      expect((await t.listed()).map((x) => x.episode)).toEqual([2])
      expect((await t.a.request(`http://127.0.0.1${SITE_TITLES_PATH}/${id}/play`, { method: 'POST' })).status).toBe(403)
      expect((await play({ episode: 0 })).status).toBe(400)
      expect((await t.a.request(`http://127.0.0.1${SITE_TITLES_PATH}/999999/play`, { method: 'POST', headers: ORIGIN })).status).toBe(404)
    })

    it('says so when the site has no later episode, or does not start it, and keeps the episode it had', async () => {
      const none = setup(() => ({ ok: false, play: { playing: false, skipped_play: 'no_episode' } }))
      const { site_title_id: id } = (await (await none.report()).json()) as { site_title_id: number }
      const res = await none.a.request(`http://127.0.0.1${SITE_TITLES_PATH}/${id}/play`, { method: 'POST', headers: ORIGIN })
      expect(res.status).toBe(404)
      expect(await res.json()).toMatchObject({ error: 'no_episode', episode: 4 })
      expect((await none.listed()).map((x) => x.episode)).toEqual([3])

      const stuck = setup(() => ({ ok: false, play: { playing: false, stage: 'loading' } }))
      const { site_title_id: other } = (await (await stuck.report()).json()) as { site_title_id: number }
      const failed = await stuck.a.request(`http://127.0.0.1${SITE_TITLES_PATH}/${other}/play`, { method: 'POST', headers: ORIGIN })
      expect(failed.status).toBe(502)
      expect(await failed.json()).toMatchObject({ error: 'not_playing', play: { stage: 'loading' } })
    })

    it('is taken off the list by its button, and another machine keeps its own', async () => {
      const t = setup()
      const { site_title_id: id } = (await (await t.report()).json()) as { site_title_id: number }
      await repo.keepSiteTitle({ host: OTHER, site: 'dramacool', siteUrl: DRAMA_URL, kind: 'series', name: 'Hidden Summer', year: 2026, season: 1, episode: 1, at: T0 })
      const [theirs] = await repo.siteTitles(OTHER)
      expect((await t.a.request(`http://127.0.0.1${SITE_TITLES_PATH}/${theirs!.id}`, { method: 'DELETE', headers: ORIGIN })).status).toBe(404)
      expect((await t.a.request(`http://127.0.0.1${SITE_TITLES_PATH}/${id}`, { method: 'DELETE' })).status).toBe(403)
      expect((await t.a.request(`http://127.0.0.1${SITE_TITLES_PATH}/${id}`, { method: 'DELETE', headers: ORIGIN })).status).toBe(200)
      expect(await t.listed()).toEqual([])
      expect(await repo.siteTitles(OTHER)).toHaveLength(1)
    })
  })
})

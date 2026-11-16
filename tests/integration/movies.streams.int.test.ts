import { asc, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { moviePlays, movieTitles } from '../../src/db/schema.js'
import { streamPositionRoutes } from '../../src/http/directStreamApi.js'
import { moviesPlayRoutes } from '../../src/http/moviesPlayApi.js'
import { getTitle, history, listStreamTitles, listTitles } from '../../src/movies/read.js'
import { MoviesRepo, isFreshStreamSource, streamFreshSince } from '../../src/movies/repo.js'
import { MovieEvents, type MovieChangeEvent } from '../../src/movies/service.js'
import { STREAM_LIVE_TTL_MS, StreamLive, type StreamLiveSnapshot } from '../../src/movies/streamLive.js'
import { MovieStreams, type MovieStreamsSource, type ResolveRecord, type StreamSessionRef } from '../../src/movies/streams.js'
import type { TmdbClient } from '../../src/movies/tmdb.js'
import type { NewMovieFile } from '../../src/movies/types.js'
import { movieMeta, tvMeta } from './helpers/movieMeta.js'
import { fakeTmdb } from './helpers/moviesSeed.js'
import { closeTestDb, openTestDb, truncateAll } from './setup.js'

const HOST = 'host-a'
const OTHER = 'host-b'
const CTX = { host: HOST, imageBase: 'https://image.tmdb.org/t/p' }
const SAME_ORIGIN = { origin: 'http://localhost' }
const T0 = new Date('2026-11-15T12:00:00.000Z')
const FIGHT_CLUB = { kind: 'movie' as const, tmdbId: 550 }
const MOBLAND_S1E2 = { kind: 'tv' as const, tmdbId: 247718, season: 1, episode: 2 }
const RESOLVED: ResolveRecord = { ok: true, source: { provider: 'VidFast', manifest_kind: 'hls', best_height: 2160, subtitles: [{ lang: 'en' }] } }
const NO_SOURCE: ResolveRecord = { ok: false, error: 'no_source' }

function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * 60_000)
}

/** The Postgres error code and constraint name behind a failed statement (drizzle wraps it in `cause`). */
async function pgFailure(statement: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await statement
  } catch (err) {
    let cur: unknown = err
    while (cur && typeof cur === 'object') {
      const e = cur as { code?: unknown; constraint?: unknown; cause?: unknown }
      if (typeof e.code === 'string') return { code: e.code, constraint: typeof e.constraint === 'string' ? e.constraint : undefined }
      cur = e.cause
    }
    return {}
  }
  throw new Error('expected the statement to fail')
}

describe('direct streaming in the movies store', () => {
  let db: Db
  let repo: MoviesRepo
  let events: MovieEvents
  let seen: MovieChangeEvent[]
  let clock: Date
  let tmdbCalls: number
  const sessions = new Map<string, StreamSessionRef>()

  beforeAll(() => {
    db = openTestDb()
    repo = new MoviesRepo(db)
  })
  afterAll(async () => {
    await closeTestDb(db)
  })
  beforeEach(async () => {
    await truncateAll(db)
    events = new MovieEvents()
    seen = []
    events.on((e) => seen.push(e))
    clock = T0
    tmdbCalls = 0
    sessions.clear()
  })

  function tmdb(): TmdbClient {
    return {
      ...fakeTmdb(),
      movieDetails: (id: number) => {
        tmdbCalls += 1
        return Promise.resolve(movieMeta(id))
      },
      tvDetails: (id: number) => {
        tmdbCalls += 1
        return Promise.resolve(tvMeta(id))
      },
    }
  }

  function moviesOf(host = HOST, client: TmdbClient | null = tmdb()): MovieStreamsSource {
    return { repo, tmdb: client, events, host }
  }

  function streams(host = HOST): MovieStreams {
    return new MovieStreams(moviesOf(host), { now: () => clock, log: () => undefined })
  }

  function app(movies: MovieStreamsSource | null = moviesOf(), withService = true, live: StreamLive | null = null): Hono {
    const a = new Hono()
    const directStream = withService ? { session: (id: string) => sessions.get(id) ?? null } : null
    a.route('/', streamPositionRoutes({ movies, directStream, live }, { now: () => clock }))
    a.route('/', moviesPlayRoutes({ db, moviesPlayer: null, streamLive: live }))
    return a
  }

  function report(a: Hono, sessionId: string, body: unknown, headers: Record<string, string> = SAME_ORIGIN): Promise<Response> {
    return Promise.resolve(
      a.request(`/api/stream/sessions/${sessionId}/position`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
    )
  }

  function streamRows() {
    return db.select().from(moviePlays).where(eq(moviePlays.source, 'stream')).orderBy(asc(moviePlays.id))
  }

  function newFile(titleId: string, path: string, durationS: number): NewMovieFile {
    return {
      host: HOST,
      path,
      name: path.split('/').pop() ?? path,
      size: 1_000_000,
      mtime: T0,
      durationS,
      season: null,
      episode: null,
      absoluteEpisode: null,
      parsed: null,
      source: 'scan',
      classification: { status: 'matched', titleId },
      seenAt: T0,
    }
  }

  describe('stream plays from the player page (R2.4)', () => {
    it('R2.4 writes every report of one play on one movie_plays row, and the title state derives from it as from a VLC play', async () => {
      sessions.set('sess-1', { id: 'sess-1', ref: FIGHT_CLUB, source: { provider: 'VidFast' } })
      const a = app()
      for (const [i, position] of [5, 10, 600].entries()) {
        clock = at(i)
        const res = await report(a, 'sess-1', { position_s: position, duration_s: 8340, ended: false })
        expect(res.status).toBe(200)
      }
      const rows = await streamRows()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        source: 'stream', fileId: null, titleId: 'movie-550', season: null, episode: null, provider: 'VidFast',
        streamSession: 'sess-1', host: HOST, startPositionS: 5, positionS: 600, durationS: 8340, startedAt: at(0), endedAt: null,
      })
      expect(tmdbCalls).toBe(1)

      const streamed = await getTitle(db, 'movie-550', CTX)
      expect(streamed).toMatchObject({ state: 'in_progress', last_played_at: at(0).toISOString(), progress: { kind: 'movie', position_s: 600, duration_s: 8340 } })
      expect(streamed?.plays[0]).toMatchObject({ source: 'stream', provider: 'VidFast', file_id: null, file_name: null, file_deleted: false, title_id: 'movie-550', title: 'Film 550', position_s: 600 })

      // The same reading on a VLC play of another film gives the same state.
      const other = await repo.upsertTitle(movieMeta(551))
      const { file } = await repo.upsertFile(newFile(other, '/lib/film.551.mkv', 8340))
      const vlc = await repo.startPlay({ fileId: file.id, host: HOST, source: 'live', startedAt: at(0), startPositionS: 5, durationS: 8340 })
      await repo.updatePlay(vlc.id, { positionS: 600, durationS: 8340 }, at(2))
      expect((await getTitle(db, other, CTX))?.state).toBe(streamed?.state)

      clock = at(60)
      expect((await report(a, 'sess-1', { position_s: 7600, duration_s: 8340, ended: true })).status).toBe(200)
      expect(await streamRows()).toMatchObject([{ positionS: 7600, endedAt: at(60) }])
      expect((await getTitle(db, 'movie-550', CTX))?.state).toBe('finished')
      // A report after the end writes nothing new.
      expect((await report(a, 'sess-1', { position_s: 7600, duration_s: 8340, ended: true })).status).toBe(200)
      expect(await streamRows()).toHaveLength(1)
      // 'play' when the row opened and when it closed, never per report.
      expect(seen.filter((e) => e.reason === 'play').map((e) => e.title_ids)).toEqual([['movie-550'], ['movie-550']])
      // History's SQL "finished" agrees with streamState.
      const finished = await repo.titlesFinishedBetween({ from: at(-1), to: at(120) })
      expect(finished.map((f) => f.id)).toContain('movie-550')
    })

    it('a new session starts a second row, closes the first at its last report, and resumes from it', async () => {
      sessions.set('sess-1', { id: 'sess-1', ref: FIGHT_CLUB, source: { provider: 'VidFast' } })
      sessions.set('sess-2', { id: 'sess-2', ref: FIGHT_CLUB, source: { provider: 'VidLink' } })
      const a = app()
      await report(a, 'sess-1', { position_s: 1200, duration_s: 8340 })
      expect(await streams().resumeS(FIGHT_CLUB)).toBe(1200)
      clock = at(30)
      await report(a, 'sess-2', { position_s: 1205, duration_s: 8340 })
      const rows = await streamRows()
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({ streamSession: 'sess-1', endedAt: T0, positionS: 1200 })
      expect(rows[1]).toMatchObject({ streamSession: 'sess-2', endedAt: null, provider: 'VidLink' })
      clock = at(200)
      await report(a, 'sess-2', { position_s: 8000, duration_s: 8340, ended: true })
      expect(await streams().resumeS(FIGHT_CLUB)).toBe(0)
    })

    it('an episode play names its season and episode, moves the episode and the series, and shows in history', async () => {
      sessions.set('sess-tv', { id: 'sess-tv', ref: MOBLAND_S1E2, source: { provider: 'VidLink' } })
      expect((await report(app(), 'sess-tv', { position_s: 300, duration_s: 3300 })).status).toBe(200)
      const detail = await getTitle(db, 'tv-247718', CTX)
      const ep2 = detail?.seasons[0]?.episodes.find((e) => e.episode === 2)
      expect(ep2).toMatchObject({ state: 'in_progress', has_file: false, present_here: false, file_id: null, progress: { position_s: 300, duration_s: 3300 } })
      expect(ep2?.movie_id).toMatch(/^M-[0-9A-Z]{4}$/)
      expect(detail?.state).toBe('in_progress')
      const [h] = await history(db, { titleId: 'tv-247718' })
      expect(h).toMatchObject({ source: 'stream', provider: 'VidLink', season: 1, episode: 2, episode_name: 'Alpha Male', movie_id: ep2?.movie_id, file_id: null, kind: 'tv' })
    })

    it('answers 400, 403, 404 and 503 and writes nothing', async () => {
      const a = app()
      expect(await (await report(a, 'nope', { position_s: 1 })).json()).toMatchObject({ error: 'unknown_session' })
      sessions.set('sess-1', { id: 'sess-1', ref: FIGHT_CLUB, source: { provider: 'VidFast' } })
      expect((await report(a, 'sess-1', { position_s: -1 })).status).toBe(400)
      expect((await report(a, 'sess-1', { duration_s: 10 })).status).toBe(400)
      expect((await report(a, 'sess-1', { position_s: 1 }, { origin: 'http://evil.example' })).status).toBe(403)
      expect((await report(app(moviesOf(), false), 'sess-1', { position_s: 1 })).status).toBe(503)
      expect((await report(app(null), 'sess-1', { position_s: 1 })).status).toBe(503)
      const noTmdb = await report(app(moviesOf(HOST, null)), 'sess-1', { position_s: 1 })
      expect(noTmdb.status).toBe(404)
      expect(await noTmdb.json()).toMatchObject({ error: 'unknown_title' })
      expect(await streamRows()).toHaveLength(0)
    })

    it('a title TMDB does not have records nothing and never throws, so a play still answers', async () => {
      const missing: TmdbClient = {
        ...fakeTmdb(),
        movieDetails: async () => {
          throw new Error('TMDB 404: movie 550')
        },
      }
      const store = new MovieStreams(moviesOf(HOST, missing), { log: () => {} })
      await expect(store.recordResolve(FIGHT_CLUB, { ok: true, source: { provider: 'VidFast', manifest_kind: 'hls', best_height: 1080, subtitles: [] } })).resolves.toBeUndefined()
      await expect(store.recordResolve(FIGHT_CLUB, { ok: false, source: null, error: 'no_source' })).resolves.toBeUndefined()
      expect(await repo.streamSourcesOfTitle('movie-550', HOST)).toEqual([])
      sessions.set('sess-1', { id: 'sess-1', ref: FIGHT_CLUB, source: { provider: 'VidFast' } })
      const res = await report(app(moviesOf(HOST, missing)), 'sess-1', { position_s: 30 })
      expect(res.status).toBe(404)
      expect(await res.json()).toMatchObject({ error: 'unknown_title' })
      expect(await streamRows()).toHaveLength(0)
    })

    it('a daemon start closes the stream plays this host left open, and only those', async () => {
      sessions.set('sess-1', { id: 'sess-1', ref: FIGHT_CLUB, source: { provider: 'VidFast' } })
      sessions.set('sess-b', { id: 'sess-b', ref: MOBLAND_S1E2, source: { provider: 'VidFast' } })
      await report(app(), 'sess-1', { position_s: 900, duration_s: 8340 })
      await report(app(moviesOf(OTHER)), 'sess-b', { position_s: 100, duration_s: 3300 })
      expect(await streams().closeLeftOpen()).toBe(1)
      const rows = await streamRows()
      expect(rows.find((r) => r.host === HOST)?.endedAt).toEqual(T0)
      expect(rows.find((r) => r.host === OTHER)?.endedAt).toBeNull()
    })
  })

  describe('the stream on screen (GET /api/movies/player)', () => {
    const onScreen = async (a: Hono) => ((await (await a.request('/api/movies/player')).json()) as { stream: StreamLiveSnapshot | null }).stream

    it('says playing or paused with the position while the page reports, for a film and for an episode', async () => {
      const live = new StreamLive(() => clock)
      const a = app(moviesOf(), true, live)
      sessions.set('sess-1', { id: 'sess-1', ref: FIGHT_CLUB, source: { provider: 'VidFast' } })
      expect(await onScreen(a)).toBeNull()
      await report(a, 'sess-1', { position_s: 120, duration_s: 8340, paused: false })
      expect(await onScreen(a)).toEqual({
        session_id: 'sess-1', title_id: 'movie-550', season: null, episode: null, provider: 'VidFast', state: 'playing', position: 120, duration: 8340, last_report_at: T0.toISOString(),
      })
      clock = at(1)
      await report(a, 'sess-1', { position_s: 180, duration_s: 8340, paused: true })
      expect(await onScreen(a)).toMatchObject({ state: 'paused', position: 180 })

      // Another page starts an episode: the stream on screen is the one that reported last.
      sessions.set('sess-2', { id: 'sess-2', ref: MOBLAND_S1E2, source: { provider: 'HyperLink' } })
      await report(a, 'sess-2', { position_s: 5, duration_s: 3000 })
      expect(await onScreen(a)).toMatchObject({ session_id: 'sess-2', title_id: 'tv-247718', season: 1, episode: 2, provider: 'HyperLink', state: 'playing' })
    })

    it("a paused page's beat keeps it on screen and writes nothing", async () => {
      const live = new StreamLive(() => clock)
      const a = app(moviesOf(), true, live)
      sessions.set('sess-1', { id: 'sess-1', ref: FIGHT_CLUB, source: { provider: 'VidFast' } })
      await report(a, 'sess-1', { position_s: 300, duration_s: 8340, paused: true })
      const [row] = await streamRows()
      for (let i = 1; i <= 6; i += 1) {
        clock = new Date(T0.getTime() + i * 5_000)
        const res = await report(a, 'sess-1', { position_s: 300, duration_s: 8340, paused: true, beat: true })
        expect(await res.json()).toEqual({ ok: true, play_id: null, ended: false })
      }
      // Thirty seconds on, past the 20 s a silent page is kept: still paused, and the row untouched.
      expect(await onScreen(a)).toMatchObject({ state: 'paused', position: 300 })
      expect(await streamRows()).toEqual([row])
      // A beat for a session that is not on screen is a normal report: it is written and shown.
      sessions.set('sess-2', { id: 'sess-2', ref: MOBLAND_S1E2, source: { provider: 'HyperLink' } })
      await report(a, 'sess-2', { position_s: 40, duration_s: 3000, paused: true, beat: true })
      expect(await streamRows()).toHaveLength(2)
      expect(await onScreen(a)).toMatchObject({ session_id: 'sess-2', state: 'paused' })
    })

    it('leaves the screen when the film ends, the page closes, or it falls silent for 20 s', async () => {
      const live = new StreamLive(() => clock)
      const a = app(moviesOf(), true, live)
      sessions.set('sess-1', { id: 'sess-1', ref: FIGHT_CLUB, source: { provider: 'VidFast' } })
      await report(a, 'sess-1', { position_s: 100, duration_s: 8340 })
      await report(a, 'sess-1', { position_s: 130, duration_s: 8340, paused: true, closed: true })
      expect(await onScreen(a)).toBeNull()
      // The closing word still stores the position.
      expect(await streamRows()).toMatchObject([{ positionS: 130, endedAt: null }])

      await report(a, 'sess-1', { position_s: 140, duration_s: 8340 })
      expect(await onScreen(a)).toMatchObject({ position: 140 })
      clock = new Date(T0.getTime() + STREAM_LIVE_TTL_MS + 1)
      expect(await onScreen(a)).toBeNull()

      await report(a, 'sess-1', { position_s: 8340, duration_s: 8340, ended: true })
      expect(await onScreen(a)).toBeNull()
    })

    it('answers no stream without the live state, and a report is still stored', async () => {
      const a = app()
      sessions.set('sess-1', { id: 'sess-1', ref: FIGHT_CLUB, source: { provider: 'VidFast' } })
      expect((await report(a, 'sess-1', { position_s: 100, duration_s: 8340, paused: true, beat: true })).status).toBe(200)
      expect(await streamRows()).toHaveLength(1)
      expect(await onScreen(a)).toBeNull()
    })
  })

  describe('the name the player page shows', () => {
    it('names a film with its year and an episode as the series with S01E02; null for a title that is not stored', async () => {
      expect(await streams().titleLabel(FIGHT_CLUB)).toBeNull()
      await streams().ensureTitle(FIGHT_CLUB)
      await streams().ensureTitle(MOBLAND_S1E2)
      const film = await repo.titleById('movie-550')
      const series = await repo.titleById('tv-247718')
      expect(await streams().titleLabel(FIGHT_CLUB)).toBe(`${film?.title} (${film?.year})`)
      expect(await streams().titleLabel(MOBLAND_S1E2)).toBe(`${series?.title} S01E02`)
      expect(await streams().titleLabel({ kind: 'tv', tmdbId: 247718, season: 12, episode: 104 })).toBe(`${series?.title} S12E104`)
    })
  })

  describe('the original language', () => {
    it("reads a stored title's language from TMDB once, stores it, and answers it for an episode of the series", async () => {
      await streams().ensureTitle(MOBLAND_S1E2)
      await db.execute(sql`update movie_titles set original_language = null where id = 'tv-247718'`)
      let asked = 0
      const client = { ...tmdb(), originalLanguage: async () => { asked += 1; return 'ko' } }
      const s = new MovieStreams(moviesOf(HOST, client), { now: () => clock, log: () => undefined })
      expect(await s.originalLanguage(MOBLAND_S1E2)).toBe('ko')
      expect(await s.originalLanguage(MOBLAND_S1E2)).toBe('ko')
      expect(asked).toBe(1)
      expect((await repo.titleById('tv-247718'))?.originalLanguage).toBe('ko')
    })

    it('asks TMDB for a title that is not stored, and answers null when nothing says', async () => {
      const client = { ...tmdb(), originalLanguage: async () => 'ja' }
      expect(await new MovieStreams(moviesOf(HOST, client), { log: () => undefined }).originalLanguage(FIGHT_CLUB)).toBe('ja')
      expect(await repo.titleById('movie-550')).toBeNull()
      expect(await new MovieStreams(moviesOf(HOST, null), { log: () => undefined }).originalLanguage(FIGHT_CLUB)).toBeNull()
      expect(await streams().originalLanguage(FIGHT_CLUB)).toBeNull()
    })

    it('keeps a dialogue per film or episode, replaces it on a new read, and drops it with its title', async () => {
      await streams().ensureTitle(MOBLAND_S1E2)
      const row = { titleId: 'tv-247718', season: 1, episode: 2, lang: 'en', provider: 'VidNest Anime', cues: 2, lastCueS: 723, body: '00:17\tFight\n12:03\tThe gas', fetchedAt: T0 }
      expect(await repo.dialogue('tv-247718', 1, 2)).toBeNull()
      await repo.saveDialogue(row)
      expect(await repo.dialogue('tv-247718', 1, 2)).toEqual(row)
      expect(await repo.dialogue('tv-247718', 1, 3)).toBeNull()
      await repo.saveDialogue({ ...row, provider: 'Other', cues: 1, body: '00:01\tHello.' })
      expect(await repo.dialogue('tv-247718', 1, 2)).toMatchObject({ provider: 'Other', cues: 1, body: '00:01\tHello.' })
      await db.execute(sql`delete from movie_titles where id = 'tv-247718'`)
      expect(await repo.dialogue('tv-247718', 1, 2)).toBeNull()
    })

    it('names the episodes before and after one, without specials, and no next episode that has not aired', async () => {
      await streams().ensureTitle(MOBLAND_S1E2)
      const list = ((await repo.loadTitleMetadata('tv-247718'))?.episodes ?? []).filter((e) => e.season >= 1).sort((a, b) => a.season - b.season || a.episode - b.episode)
      const [first, second, third] = list
      expect(await streams().neighbors(MOBLAND_S1E2)).toEqual({ prev: { season: first!.season, episode: first!.episode }, next: third === undefined ? null : { season: third.season, episode: third.episode } })
      expect((await streams().neighbors({ kind: 'tv', tmdbId: 247718, season: first!.season, episode: first!.episode }))?.prev).toBeNull()
      expect(second).toBeDefined()
      // The episode after this one airs tomorrow: there is no next yet.
      if (third !== undefined) {
        await db.execute(sql`update movie_episodes set air_date = '2999-01-01' where title_id = 'tv-247718' and season = ${third.season} and episode = ${third.episode}`)
        expect((await streams().neighbors(MOBLAND_S1E2))?.next).toBeNull()
      }
      expect(await streams().neighbors(FIGHT_CLUB)).toBeNull()
      expect(await streams().neighbors({ kind: 'tv', tmdbId: 247718, season: 9, episode: 9 })).toBeNull()
      expect(await streams().neighbors({ kind: 'tv', tmdbId: 999999, season: 1, episode: 1 })).toBeNull()
    })

    it('looks only a Japanese title up as an anime, by the air date of the episode, and stores the title to read it', async () => {
      const asked: unknown[] = []
      const mapper = { lookup: async (q: unknown) => { asked.push(q); return { id: 21, episode: 730 } } }
      // MobLand is stored as English: not asked about at all.
      await streams().ensureTitle(MOBLAND_S1E2)
      expect(await streams().animeRef(MOBLAND_S1E2, mapper)).toBeNull()
      expect(asked).toEqual([])
      await db.execute(sql`update movie_titles set original_language = 'ja' where id = 'tv-247718'`)
      const episode = (await repo.loadTitleMetadata('tv-247718'))?.episodes.find((e) => e.season === 1 && e.episode === 2)
      expect(await streams().animeRef(MOBLAND_S1E2, mapper)).toEqual({ id: 21, episode: 730 })
      expect(asked).toEqual([{ kind: 'tv', tmdbId: 247718, airDate: episode?.airDate }])
      // An episode the list does not hold has no air date to go by.
      expect(await streams().animeRef({ kind: 'tv', tmdbId: 247718, season: 9, episode: 9 }, mapper)).toBeNull()
      // A mapper that throws is "not an anime", never a failed resolve.
      expect(await streams().animeRef(MOBLAND_S1E2, { lookup: async () => Promise.reject(new Error('index down')) })).toBeNull()
    })

    it('keeps the stored language when new TMDB metadata does not carry one', async () => {
      await repo.upsertTitle({ ...movieMeta(550), originalLanguage: 'en' }, T0)
      await repo.upsertTitle(movieMeta(550), at(1))
      expect((await repo.titleById('movie-550'))?.originalLanguage).toBe('en')
    })
  })

  describe('verified and stale sources (R5.4, store half)', () => {
    it('R5.4 a resolve that finds no source marks the row stale and the title leaves the fresh list', async () => {
      const store = streams()
      await store.recordResolve(FIGHT_CLUB, RESOLVED)
      const since = streamFreshSince(clock, 7)
      expect(await repo.streamSourcesOfTitle('movie-550', HOST)).toMatchObject([
        { season: 0, episode: 0, provider: 'VidFast', manifestKind: 'hls', bestHeight: 2160, enSubtitle: true, verifiedAt: T0, staleAt: null, failure: null },
      ])
      expect(await repo.freshStreamTitleIds(HOST, since)).toEqual(['movie-550'])
      expect((await listStreamTitles(db, {}, CTX, since)).map((t) => t.id)).toEqual(['movie-550'])

      clock = at(60)
      await store.recordResolve(FIGHT_CLUB, NO_SOURCE)
      const [row] = await repo.streamSourcesOfTitle('movie-550', HOST)
      expect(row).toMatchObject({ provider: 'VidFast', verifiedAt: T0, staleAt: at(60), failure: 'no_source' })
      expect(row !== undefined && isFreshStreamSource(row, HOST, since)).toBe(false)
      expect(await repo.freshStreamTitleIds(HOST, since)).toEqual([])
      expect(await listStreamTitles(db, {}, CTX, since)).toEqual([])

      clock = at(120)
      await store.recordResolve(FIGHT_CLUB, RESOLVED)
      expect(await repo.freshStreamTitleIds(HOST, since)).toEqual(['movie-550'])
      expect(seen.filter((e) => e.reason === 'stream')).toHaveLength(3)
      expect(tmdbCalls).toBe(1)
    })

    it("a failure of the streaming Chrome is not the source's: nothing is recorded", async () => {
      await streams().recordResolve(FIGHT_CLUB, { ok: false, error: 'chrome_not_reachable' })
      expect(await repo.streamSourcesOfTitle('movie-550', HOST)).toEqual([])
      expect(await repo.titleById('movie-550')).toBeNull()
      expect(tmdbCalls).toBe(0)
    })

    it('a first failed resolve stores the title and a stale-only episode row', async () => {
      await streams().recordResolve(MOBLAND_S1E2, NO_SOURCE)
      expect(await repo.titleById('tv-247718')).not.toBeNull()
      expect(await repo.streamSourcesOfTitle('tv-247718', HOST)).toMatchObject([
        { season: 1, episode: 2, provider: null, manifestKind: null, verifiedAt: null, staleAt: T0, failure: 'no_source', enSubtitle: false },
      ])
    })

    it('freshness is per host and inside the window, in SQL and in JS alike', async () => {
      await streams(OTHER).recordResolve(FIGHT_CLUB, RESOLVED)
      const since = streamFreshSince(clock, 7)
      expect(await repo.freshStreamTitleIds(HOST, since)).toEqual([])
      expect(await repo.freshStreamTitleIds(OTHER, since)).toEqual(['movie-550'])
      await streams().recordResolve(FIGHT_CLUB, RESOLVED)
      const eightDaysOn = streamFreshSince(at(8 * 24 * 60), 7)
      expect(await repo.freshStreamTitleIds(HOST, eightDaysOn)).toEqual([])
      const [row] = await repo.streamSourcesOfTitle('movie-550', HOST)
      expect(row !== undefined && isFreshStreamSource(row, HOST, since)).toBe(true)
      expect(row !== undefined && isFreshStreamSource(row, HOST, eightDaysOn)).toBe(false)
    })

    it('getTitle carries this host\'s verified sources only', async () => {
      const store = streams()
      await store.recordResolve(FIGHT_CLUB, { ok: true, source: { provider: 'VidFast', manifest_kind: 'hls', best_height: 2160, subtitles: [{ lang: 'en' }] } })
      await streams(OTHER).recordResolve(FIGHT_CLUB, { ok: true, source: { provider: 'VidLink', manifest_kind: 'dash', best_height: 1080, subtitles: [] } })
      const detail = await getTitle(db, 'movie-550', CTX)
      expect(detail?.stream_sources).toEqual([
        expect.objectContaining({ host: HOST, season: 0, episode: 0, provider: 'VidFast', manifest_kind: 'hls', best_height: 2160, en_subtitle: true, stale_at: null }),
      ])
    })

    it('records no English subtitle when the source has none', async () => {
      await streams().recordResolve(FIGHT_CLUB, { ok: true, source: { provider: 'VidLink', manifest_kind: 'dash', best_height: 480, subtitles: [{ lang: 'fr' }] } })
      expect(await repo.streamSourcesOfTitle('movie-550', HOST)).toMatchObject([{ enSubtitle: false, manifestKind: 'dash' }])
    })
  })

  describe('the Library grid (invariant 10)', () => {
    it('a title known only from streams is absent from listTitles but opens by id', async () => {
      await streams().recordResolve(FIGHT_CLUB, RESOLVED)
      expect((await listTitles(db, {}, CTX)).map((t) => t.id)).not.toContain('movie-550')
      expect((await listTitles(db, { scope: 'all' }, CTX)).map((t) => t.id)).toContain('movie-550')
      expect(await getTitle(db, 'movie-550', CTX)).not.toBeNull()

      sessions.set('sess-tv', { id: 'sess-tv', ref: MOBLAND_S1E2, source: { provider: 'VidLink' } })
      await report(app(), 'sess-tv', { position_s: 300, duration_s: 3300 })
      expect((await listTitles(db, {}, CTX)).map((t) => t.id)).not.toContain('tv-247718')

      // A file makes it a Library title; a title stored before streams (no file, never streamed) stays listed.
      await repo.upsertFile(newFile('movie-550', '/lib/fight.club.1999.mkv', 8340))
      await repo.upsertTitle(movieMeta(700))
      expect((await listTitles(db, {}, CTX)).map((t) => t.id).sort()).toEqual(['movie-550', 'movie-700'])
    })
  })

  describe('migration 0021', () => {
    it('keeps a stream play on a title and a file play on a file, one open row per session', async () => {
      await db.insert(movieTitles).values({ id: 'movie-550', kind: 'movie', tmdbId: 550, title: 'Fight Club', originalTitle: 'Fight Club' })
      const base = { host: HOST, startedAt: T0 }
      const noTitle = await pgFailure(db.insert(moviePlays).values({ ...base, source: 'stream', provider: 'VidFast', streamSession: 's' }))
      const noFile = await pgFailure(db.insert(moviePlays).values({ ...base, source: 'live', titleId: 'movie-550' }))
      const halfEpisode = await pgFailure(db.insert(moviePlays).values({ ...base, source: 'stream', titleId: 'movie-550', season: 1, provider: 'VidFast', streamSession: 's' }))
      for (const failure of [noTitle, noFile, halfEpisode]) expect(failure).toEqual({ code: '23514', constraint: 'movie_plays_target_check' })
      await db.insert(moviePlays).values({ ...base, source: 'stream', titleId: 'movie-550', provider: 'VidFast', streamSession: 's' })
      expect(await pgFailure(db.insert(moviePlays).values({ ...base, source: 'stream', titleId: 'movie-550', provider: 'VidFast', streamSession: 's' }))).toEqual({
        code: '23505',
        constraint: 'movie_plays_open_session_uniq',
      })
    })

    it('a stream source row is verified with a provider, or stale-only with a failure', async () => {
      await db.insert(movieTitles).values({ id: 'movie-550', kind: 'movie', tmdbId: 550, title: 'Fight Club', originalTitle: 'Fight Club' })
      const bad = [
        sql`insert into movie_stream_sources (title_id, season, episode, host) values ('movie-550', 0, 0, 'h')`,
        sql`insert into movie_stream_sources (title_id, season, episode, host, verified_at) values ('movie-550', 0, 0, 'h', now())`,
        sql`insert into movie_stream_sources (title_id, season, episode, host, stale_at) values ('movie-550', 0, 0, 'h', now())`,
        sql`insert into movie_stream_sources (title_id, season, episode, host, stale_at, failure) values ('movie-550', 1, 0, 'h', now(), 'no_source')`,
      ]
      const failures = await Promise.all(bad.map((s) => pgFailure(db.execute(s))))
      expect(failures.map((f) => f.constraint)).toEqual([
        'movie_stream_sources_outcome_check',
        'movie_stream_sources_outcome_check',
        'movie_stream_sources_failure_check',
        'movie_stream_sources_slot_check',
      ])
    })
  })
})

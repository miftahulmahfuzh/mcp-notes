import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { notes } from '../../src/db/schema.js'
import { MoviesRepo } from '../../src/movies/repo.js'
import { fileState } from '../../src/movies/state.js'
import type { CompanyMeta, CreditMeta, CreditRole, FileClassification, NewMovieFile, TitleMetadata } from '../../src/movies/types.js'
import { closeTestDb, openTestDb, truncateAll } from './setup.js'

const HOST = 'host-a'
const T0 = new Date('2026-01-01T00:00:00.000Z')

function day(n: number): Date {
  return new Date(T0.getTime() + n * 86_400_000)
}

const BLUMHOUSE: CompanyMeta = { id: 3172, name: 'Blumhouse Productions', logoPath: '/blumhouse.png', originCountry: 'US' }
const A24: CompanyMeta = { id: 41077, name: 'A24', logoPath: null, originCountry: 'US' }
const QUALLEY = { personId: 1392137, name: 'Margaret Qualley', profilePath: '/qualley.jpg' }
const DIRECTOR = { personId: 5655, name: 'John Patton Ford', profilePath: null }

function credit(person: { personId: number; name: string; profilePath: string | null }, role: CreditRole, character: string | null, job: string | null = null): CreditMeta {
  return { ...person, role, character, job }
}

function movie(tmdbId: number, over: Partial<TitleMetadata> = {}): TitleMetadata {
  return {
    kind: 'movie',
    tmdbId,
    title: `Film ${tmdbId}`,
    originalTitle: `Film ${tmdbId}`,
    year: 2026,
    releaseDate: '2026-02-20',
    overview: `Synopsis of film ${tmdbId}.`,
    posterPath: `/poster-${tmdbId}.jpg`,
    backdropPath: null,
    runtimeMin: 100,
    genres: ['Thriller'],
    seasonCount: null,
    episodeCount: null,
    companies: [],
    credits: [],
    episodes: [],
    ...over,
  }
}

function series(tmdbId: number, over: Partial<TitleMetadata> = {}): TitleMetadata {
  return movie(tmdbId, {
    kind: 'tv',
    title: `Series ${tmdbId}`,
    originalTitle: `Series ${tmdbId}`,
    runtimeMin: null,
    seasonCount: 1,
    episodeCount: 2,
    episodes: [
      { season: 1, episode: 1, name: 'Stick or Twist', airDate: '2025-03-30', runtimeMin: 56, overview: 'One.', stillPath: '/s1e1.jpg' },
      { season: 1, episode: 2, name: 'Hearts and Minds', airDate: '2025-04-06', runtimeMin: 52, overview: null, stillPath: null },
    ],
    ...over,
  })
}

function newFile(path: string, classification: FileClassification, over: Partial<NewMovieFile> = {}): NewMovieFile {
  return {
    host: HOST,
    path,
    name: path.split('/').pop() ?? path,
    size: 1_000_000,
    mtime: T0,
    durationS: 6000,
    season: null,
    episode: null,
    absoluteEpisode: null,
    parsed: null,
    source: 'scan',
    classification,
    seenAt: T0,
    ...over,
  }
}

describe('MoviesRepo', () => {
  let db: Db
  let repo: MoviesRepo

  beforeAll(() => {
    db = openTestDb()
    repo = new MoviesRepo(db)
  })
  afterAll(async () => {
    await closeTestDb(db)
  })
  beforeEach(async () => {
    await truncateAll(db)
  })

  async function addFile(titleId: string, path: string, over: Partial<NewMovieFile> = {}): Promise<number> {
    return (await repo.upsertFile(newFile(path, { status: 'matched', titleId }, over))).file.id
  }

  /** A file of `titleId` with one closed live play that ended at `positionS` on `at`. */
  async function playTo(titleId: string, path: string, positionS: number | null, at: Date): Promise<number> {
    const fileId = await addFile(titleId, path)
    const play = await repo.startPlay({ fileId, host: HOST, source: 'live', startedAt: at, startPositionS: null, durationS: 6000 })
    await repo.endPlay(play.id, { positionS }, at)
    return fileId
  }

  describe('titles', () => {
    it('round-trips a movie with companies and credits, and a series with episodes', async () => {
      const meta = movie(467905, {
        title: 'How to Make a Killing',
        companies: [BLUMHOUSE, A24],
        credits: [credit(QUALLEY, 'cast', 'Julia'), credit(DIRECTOR, 'director', null, 'Director'), credit(DIRECTOR, 'writer', null, 'Screenplay')],
      })
      const id = await repo.upsertTitle(meta)
      expect(id).toBe('movie-467905')
      expect(await repo.loadTitleMetadata(id)).toEqual(meta)

      const show = series(247718, { title: 'MobLand', companies: [BLUMHOUSE], credits: [credit(QUALLEY, 'cast', 'Bella')] })
      expect(await repo.loadTitleMetadata(await repo.upsertTitle(show))).toEqual(show)
      expect(await repo.loadTitleMetadata('movie-1')).toBeNull()
    })

    it('a refetch replaces companies, credits and episodes and keeps the owner state', async () => {
      const id = await repo.upsertTitle(series(5, { companies: [BLUMHOUSE], credits: [credit(QUALLEY, 'cast', 'Bella')] }))
      await repo.setTitleUser(id, { watched: true, rating: 4 }, day(3))
      const refetched = series(5, { title: 'Renamed', companies: [A24], credits: [], episodes: [] })
      await repo.upsertTitle(refetched, day(4))
      expect(await repo.loadTitleMetadata(id)).toEqual(refetched)
      expect(await repo.titleById(id)).toMatchObject({ title: 'Renamed', watchedAt: day(3), rating: 4, metadataFetchedAt: day(4) })
    })

    it('stores the watched flag, rating and review link on the title', async () => {
      await db.insert(notes).values({ id: 'R-V01', body: 'loved it #movie' })
      const id = await repo.upsertTitle(movie(1))
      expect(await repo.setTitleUser(id, { watched: true, rating: 5, reviewNoteId: 'R-V01' }, day(1))).toMatchObject({
        watchedAt: day(1),
        rating: 5,
        reviewNoteId: 'R-V01',
      })
      expect(await repo.setTitleUser(id, { watched: true }, day(9))).toMatchObject({ watchedAt: day(1) })
      expect(await repo.setTitleUser(id, { watched: false, rating: null })).toMatchObject({ watchedAt: null, rating: null, reviewNoteId: 'R-V01' })
      expect(await repo.setTitleUser('movie-404', { rating: 1 })).toBeNull()
    })
  })

  describe('files', () => {
    it('inserts a new path, refreshes the same live path, and starts a new row after a delete', async () => {
      const id = await repo.upsertTitle(movie(1))
      const first = await repo.upsertFile(newFile('/lib/a.mkv', { status: 'matched', titleId: id }))
      expect(first.created).toBe(true)

      const again = await repo.upsertFile(newFile('/lib/a.mkv', { status: 'unmatched', reason: 'no_match' }, { size: 2_000_000, durationS: null, seenAt: day(1) }))
      expect(again.created).toBe(false)
      expect(again.file).toMatchObject({ id: first.file.id, status: 'matched', titleId: id, size: 2_000_000, durationS: 6000, firstSeenAt: T0, lastSeenAt: day(1) })

      expect(await repo.markDeleted(first.file.id, day(2))).toBe(true)
      expect(await repo.markDeleted(first.file.id, day(3))).toBe(false)
      const reborn = await repo.upsertFile(newFile('/lib/a.mkv', { status: 'pending', reason: null }, { seenAt: day(4) }))
      expect(reborn.created).toBe(true)
      expect(reborn.file.id).not.toBe(first.file.id)
      expect((await repo.fileByPath(HOST, '/lib/a.mkv'))?.id).toBe(reborn.file.id)
      expect((await repo.filesForHost(HOST)).map((f) => f.id)).toEqual([reborn.file.id])
      expect((await repo.filesForHost(HOST, { includeDeleted: true })).map((f) => f.id).sort()).toEqual([first.file.id, reborn.file.id].sort())
      expect(await repo.filesForHost('host-b')).toEqual([])
    })

    it('records a file known only from VLC recents as already deleted', async () => {
      const id = await repo.upsertTitle(movie(1))
      const gone = await repo.upsertFile(newFile('/tg/gone.mkv', { status: 'matched', titleId: id }, { source: 'vlc_recents', deletedAt: day(1) }))
      expect(gone).toMatchObject({ created: true, file: { source: 'vlc_recents', deletedAt: day(1) } })
      expect((await repo.fileByPath(HOST, '/tg/gone.mkv'))?.id).toBe(gone.file.id)
    })

    it('a move into a Done folder is a done signal, and unwatching clears it', async () => {
      const id = await repo.upsertTitle(movie(1))
      const fileId = await addFile(id, '/tg/a.mkv')
      expect(await repo.markSeen([fileId], day(1))).toBe(1)
      const moved = await repo.moveFile(fileId, { path: '/videos/Done/a.mkv', name: 'a.mkv' }, day(5), { done: true })
      expect(moved).toMatchObject({ path: '/videos/Done/a.mkv', movedAt: day(5), doneAt: day(5), deletedAt: null })
      expect(fileState(moved!, await repo.lastPlay(fileId))).toBe('finished')
      expect(await repo.setDone(fileId, day(9))).toMatchObject({ doneAt: day(5) })
      const unwatched = await repo.setFileWatched(fileId, false)
      expect(unwatched).toMatchObject({ watchedAt: null, doneAt: null })
      expect(fileState(unwatched!, null)).toBe('unwatched')
    })

    it('moves a file between unmatched, pending and matched', async () => {
      const id = await repo.upsertTitle(series(7))
      const { file } = await repo.upsertFile(newFile('/lib/s01e02.mkv', { status: 'pending', reason: null }))
      expect(await repo.setUnmatched(file.id, 'tmdb_error')).toMatchObject({ status: 'pending', reason: 'tmdb_error', titleId: null })
      expect(await repo.setUnmatched(file.id, 'no_match')).toMatchObject({ status: 'unmatched', reason: 'no_match', titleId: null })
      expect(await repo.assignFile(file.id, id, { season: 1, episode: 2 })).toMatchObject({ status: 'matched', reason: null, titleId: id, season: 1, episode: 2 })
    })
  })

  describe('plays', () => {
    it('opens, updates and closes a live play, and dedupes VLC recents observations', async () => {
      const id = await repo.upsertTitle(movie(1))
      const fileId = await addFile(id, '/lib/a.mkv')
      const live = await repo.startPlay({ fileId, host: HOST, source: 'live', startedAt: day(1), startPositionS: 600, durationS: 6000 })
      expect(live).toMatchObject({ positionS: 600, startPositionS: 600, endedAt: null })
      expect(await repo.updatePlay(live.id, { positionS: 1200, durationS: 6000 }, day(1))).toBe(true)
      expect(await repo.endPlay(live.id, { positionS: 1500 }, day(1))).toMatchObject({ positionS: 1500, durationS: 6000, endedAt: day(1) })
      expect(await repo.updatePlay(live.id, { positionS: 9, durationS: 6000 }, day(2))).toBe(false)
      expect(await repo.endPlay(live.id, {}, day(2))).toBeNull()

      const unknown = await repo.recordObservation({ fileId, host: HOST, positionS: null, durationS: null, observedAt: day(3) })
      expect(unknown.created).toBe(true)
      expect((await repo.recordObservation({ fileId, host: HOST, positionS: null, durationS: null, observedAt: day(4) })).created).toBe(false)
      const later = await repo.recordObservation({ fileId, host: HOST, positionS: 2400, durationS: null, observedAt: day(5) })
      expect(later.created).toBe(true)
      expect((await repo.recordObservation({ fileId, host: HOST, positionS: 2400.2, durationS: null, observedAt: day(6) })).created).toBe(false)

      expect((await repo.lastPlay(fileId))?.id).toBe(later.play.id)
      expect((await repo.latestPlay())?.play.id).toBe(later.play.id)
      expect((await repo.latestPlay(HOST))?.file.id).toBe(fileId)
      expect(await repo.latestPlay('host-b')).toBeNull()
    })

    it('lastPlay prefers the newest play with a known position', async () => {
      const id = await repo.upsertTitle(movie(1))
      const fileId = await playTo(id, '/lib/a.mkv', 3000, day(1))
      await repo.recordObservation({ fileId, host: HOST, positionS: null, durationS: null, observedAt: day(2) })
      expect((await repo.lastPlay(fileId))?.positionS).toBe(3000)
      await repo.markDeleted(fileId, day(3))
      expect(fileState((await repo.fileById(fileId))!, await repo.lastPlay(fileId))).toBe('dropped')
    })
  })

  describe('titlesFinishedBetween (R3.8)', () => {
    it('lists the titles of a company or a person finished in a date range', async () => {
      const year = { from: T0, to: day(365) }
      const killing = await repo.upsertTitle(movie(1, { title: 'Finished Blumhouse film', companies: [BLUMHOUSE], credits: [credit(QUALLEY, 'cast', 'Julia')] }))
      const dropped = await repo.upsertTitle(movie(2, { title: 'Dropped Blumhouse film', companies: [BLUMHOUSE] }))
      const nextYear = await repo.upsertTitle(movie(3, { title: 'Blumhouse film finished next year', companies: [BLUMHOUSE] }))
      const a24 = await repo.upsertTitle(movie(4, { title: 'A24 film', companies: [A24], credits: [credit(QUALLEY, 'cast', 'Ruth')] }))
      const show = await repo.upsertTitle(series(5, { title: 'Blumhouse series', companies: [BLUMHOUSE] }))

      await playTo(killing, '/lib/1.mkv', 5700, day(40))
      await playTo(dropped, '/lib/2.mkv', 3000, day(50))
      await playTo(nextYear, '/lib/3.mkv', 6000, day(400))
      await repo.setDone(await addFile(a24, '/videos/Done/4.mkv'), day(60))
      await repo.setFileWatched(await addFile(show, '/lib/show/S01E01.mkv', { season: 1, episode: 1 }), true, day(70))

      const blumhouse = await repo.titlesFinishedBetween({ ...year, company: 'blumhouse' })
      expect(blumhouse.map((t) => [t.id, t.finishedAt.toISOString()])).toEqual([
        [show, day(70).toISOString()],
        [killing, day(40).toISOString()],
      ])
      expect(blumhouse[1]).toMatchObject({ kind: 'movie', title: 'Finished Blumhouse film', year: 2026 })
      expect((await repo.titlesFinishedBetween({ ...year, person: 'margaret qualley', role: 'cast' })).map((t) => t.id)).toEqual([a24, killing])
      expect(await repo.titlesFinishedBetween({ ...year, person: 'Qualley', role: 'director' })).toEqual([])
      expect((await repo.titlesFinishedBetween({ from: T0, to: day(500), company: 'Blumhouse' })).map((t) => t.id)).toEqual([nextYear, show, killing])
      expect(await repo.titlesFinishedBetween({ ...year, company: '%' })).toEqual([])
    })

    it('agrees with fileState on which files are finished (R3.4)', async () => {
      const cases: Array<{ name: string; position: number | null | 'none'; deleted?: boolean; done?: boolean; watched?: boolean }> = [
        { name: 'play-95', position: 5700 },
        { name: 'play-90', position: 5400 },
        { name: 'play-89', position: 5399 },
        { name: 'play-50', position: 3000 },
        { name: 'never', position: 'none' },
        { name: 'unknown', position: null },
        { name: 'zero', position: 0 },
        { name: 'deleted-95', position: 5700, deleted: true },
        { name: 'deleted-50', position: 3000, deleted: true },
        { name: 'deleted-never', position: 'none', deleted: true },
        { name: 'deleted-unknown', position: null, deleted: true },
        { name: 'done', position: 'none', done: true },
        { name: 'watched', position: 3000, watched: true },
      ]
      const finishedByState: string[] = []
      for (const [i, c] of cases.entries()) {
        const id = await repo.upsertTitle(movie(100 + i, { title: c.name }))
        const fileId = c.position === 'none' ? await addFile(id, `/lib/${c.name}.mkv`) : await playTo(id, `/lib/${c.name}.mkv`, c.position, day(10))
        if (c.done === true) await repo.setDone(fileId, day(10))
        if (c.watched === true) await repo.setFileWatched(fileId, true, day(10))
        if (c.deleted === true) await repo.markDeleted(fileId, day(11))
        if (fileState((await repo.fileById(fileId))!, await repo.lastPlay(fileId)) === 'finished') finishedByState.push(id)
      }
      const finishedBySql = (await repo.titlesFinishedBetween({ from: T0, to: day(365) })).map((t) => t.id)
      expect([...finishedBySql].sort()).toEqual([...finishedByState].sort())
      expect(finishedByState).toHaveLength(5)
    })
  })
})

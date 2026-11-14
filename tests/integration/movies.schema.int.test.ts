import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { movieFiles, movieTitles, notes } from '../../src/db/schema.js'
import { closeTestDb, openTestDb, truncateAll } from './setup.js'

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

function title(id: string, kind: 'movie' | 'tv', tmdbId: number) {
  return { id, kind, tmdbId, title: `Title ${tmdbId}`, originalTitle: `Title ${tmdbId}`, overview: 'A killing in the family.' }
}

function fileRow(path: string, over: Partial<typeof movieFiles.$inferInsert> = {}): typeof movieFiles.$inferInsert {
  return { host: 'host-a', path, name: path.split('/').pop() ?? path, status: 'unmatched', reason: 'no_match', ...over }
}

describe('migration 0017 (movies)', () => {
  let db: Db

  beforeAll(() => {
    db = openTestDb()
  })
  afterAll(async () => {
    await closeTestDb(db)
  })
  beforeEach(async () => {
    await truncateAll(db)
  })

  it('creates the movie tables and every index the plan set relies on', async () => {
    const res = await db.execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where schemaname = 'public' and tablename like 'movie_%' order by indexname`,
    )
    expect(res.rows.map((r) => r.indexname)).toEqual(
      expect.arrayContaining([
        'movie_titles_pkey',
        'movie_titles_kind_tmdb_uniq',
        'movie_titles_search_gin',
        'movie_companies_pkey',
        'movie_title_companies_title_id_company_id_pk',
        'movie_title_companies_company_idx',
        'movie_people_pkey',
        'movie_credits_pkey',
        'movie_credits_person_idx',
        'movie_credits_title_role_idx',
        'movie_episodes_title_id_season_episode_pk',
        'movie_files_pkey',
        'movie_files_live_path_uniq',
        'movie_files_title_idx',
        'movie_files_name_size_idx',
        'movie_plays_pkey',
        'movie_plays_file_started_idx',
        'movie_plays_started_idx',
      ]),
    )
  })

  it('accepts only an id made from kind and TMDB id', async () => {
    await db.insert(movieTitles).values(title('movie-467905', 'movie', 467905))
    expect(await pgFailure(db.insert(movieTitles).values(title('movie-1', 'tv', 1)))).toEqual({
      code: '23514',
      constraint: 'movie_titles_id_check',
    })
    expect(await pgFailure(db.insert(movieTitles).values(title('show-2', 'tv', 2)))).toMatchObject({ code: '23514' })
  })

  it('keeps a rating within 0..5', async () => {
    await db.insert(movieTitles).values({ ...title('movie-1', 'movie', 1), rating: 5 })
    expect(await pgFailure(db.update(movieTitles).set({ rating: 6 }).where(eq(movieTitles.id, 'movie-1')))).toEqual({
      code: '23514',
      constraint: 'movie_titles_rating_check',
    })
  })

  it('ties a file status to its title and reason', async () => {
    await db.insert(movieTitles).values(title('movie-1', 'movie', 1))
    await db.insert(movieFiles).values(fileRow('/lib/ok.mkv', { status: 'matched', titleId: 'movie-1', reason: null }))
    const matchedWithoutTitle = await pgFailure(db.insert(movieFiles).values(fileRow('/lib/a.mkv', { status: 'matched', reason: null })))
    const unmatchedWithTitle = await pgFailure(db.insert(movieFiles).values(fileRow('/lib/b.mkv', { titleId: 'movie-1' })))
    const matchedWithReason = await pgFailure(
      db.insert(movieFiles).values(fileRow('/lib/c.mkv', { status: 'matched', titleId: 'movie-1', reason: 'no_match' })),
    )
    for (const failure of [matchedWithoutTitle, unmatchedWithTitle, matchedWithReason]) {
      expect(failure).toEqual({ code: '23514', constraint: 'movie_files_match_check' })
    }
  })

  it('allows one live row per host and path and any number of deleted ones', async () => {
    await db.insert(movieFiles).values(fileRow('/lib/a.mkv', { deletedAt: new Date('2026-01-01T00:00:00Z') }))
    await db.insert(movieFiles).values(fileRow('/lib/a.mkv', { deletedAt: new Date('2026-02-01T00:00:00Z') }))
    await db.insert(movieFiles).values(fileRow('/lib/a.mkv'))
    await db.insert(movieFiles).values(fileRow('/lib/a.mkv', { host: 'host-b' }))
    expect(await pgFailure(db.insert(movieFiles).values(fileRow('/lib/a.mkv')))).toEqual({
      code: '23505',
      constraint: 'movie_files_live_path_uniq',
    })
  })

  it('refuses to delete a title that still has files, deleted ones included', async () => {
    await db.insert(movieTitles).values(title('movie-1', 'movie', 1))
    await db
      .insert(movieFiles)
      .values(fileRow('/lib/a.mkv', { status: 'matched', titleId: 'movie-1', reason: null, deletedAt: new Date('2026-01-01T00:00:00Z') }))
    expect(await pgFailure(db.delete(movieTitles).where(eq(movieTitles.id, 'movie-1')))).toMatchObject({ code: '23503' })
  })

  it('clears the review link when its note is purged', async () => {
    await db.insert(notes).values({ id: 'R-V01', body: 'loved it #movie' })
    await db.insert(movieTitles).values({ ...title('movie-1', 'movie', 1), reviewNoteId: 'R-V01' })
    await db.delete(notes).where(eq(notes.id, 'R-V01'))
    const [row] = await db.select({ reviewNoteId: movieTitles.reviewNoteId }).from(movieTitles)
    expect(row?.reviewNoteId).toBeNull()
  })

  it('indexes title, original title and synopsis for full text', async () => {
    await db.insert(movieTitles).values({ ...title('movie-1', 'movie', 1), originalTitle: 'Ne Zha' })
    await db.insert(movieTitles).values(title('movie-2', 'movie', 2))
    const hit = await db.execute<{ id: string }>(sql`select id from movie_titles where search_tsv @@ plainto_tsquery('simple', 'zha') order by id`)
    expect(hit.rows.map((r) => r.id)).toEqual(['movie-1'])
    const synopsis = await db.execute<{ id: string }>(sql`select id from movie_titles where search_tsv @@ plainto_tsquery('simple', 'killing') order by id`)
    expect(synopsis.rows.map((r) => r.id)).toEqual(['movie-1', 'movie-2'])
  })
})

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { closeDb, createDb, type Db } from '../../src/db/client.js'
import { importMoviesFromShared, MOVIES_IMPORT_KEY } from '../../src/movies/sharedImport.js'
import { MIGRATIONS_DIR, closeTestDb, openTestDb, testDatabaseUrl, truncateAll } from './setup.js'

const LOCAL_DB = 'mcp_notes_movies_local_test'

async function rows<T>(db: Db, text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.$client.query(text, params)).rows as T[]
}

async function title(db: Db, id: string, extra = ''): Promise<void> {
  const [kind, tmdb] = id.split('-')
  await db.$client.query(
    `insert into movie_titles (id, kind, tmdb_id, title, original_title) values ($1, $2, $3, $1, $1)`,
    [id, kind, Number(tmdb)],
  )
  if (extra !== '') await db.$client.query(`update movie_titles set ${extra} where id = $1`, [id])
}

async function file(db: Db, path: string, titleId: string | null): Promise<number> {
  const [row] = await rows<{ id: string }>(
    db,
    `insert into movie_files (title_id, host, path, name, status, reason)
     values ($1, 'host-a', $2, $2, $3, $4) returning id`,
    [titleId, path, titleId === null ? 'unmatched' : 'matched', titleId === null ? 'no_match' : null],
  )
  return Number(row!.id)
}

async function filePlay(db: Db, fileId: number, at: string): Promise<void> {
  await db.$client.query(
    `insert into movie_plays (file_id, host, source, started_at, ended_at, position_s) values ($1, 'host-a', 'live', $2, $2, 60)`,
    [fileId, at],
  )
}

describe('importMoviesFromShared', () => {
  let shared: Db
  let local: Db

  beforeAll(async () => {
    shared = openTestDb()
    const exists = await rows(shared, 'select 1 from pg_database where datname = $1', [LOCAL_DB])
    if (exists.length === 0) await shared.$client.query(`create database ${LOCAL_DB}`)
    const url = new URL(testDatabaseUrl())
    url.pathname = `/${LOCAL_DB}`
    local = createDb(url.toString())
    await migrate(local, { migrationsFolder: MIGRATIONS_DIR })
  })

  afterAll(async () => {
    await closeDb(local)
    await closeTestDb(shared)
  })

  beforeEach(async () => {
    for (const db of [shared, local]) {
      await truncateAll(db)
      await db.execute(sql`alter sequence movie_id_seq restart`)
    }
  })

  it('merges the shared tables into a machine that already ran on its own database', async () => {
    await title(shared, 'movie-1', `watched_at = '2026-01-02T00:00:00Z', rating = 4, aliases = '{one}'`)
    await title(shared, 'tv-2')
    await shared.$client.query(`insert into movie_episodes (title_id, season, episode, name) values ('tv-2', 1, 1, 'Pilot')`)
    const sharedFile = await file(shared, '/lib/a.mkv', 'movie-1')
    await filePlay(shared, sharedFile, '2026-01-02T10:00:00Z')
    const goneFile = await file(shared, '/lib/gone.mkv', null)
    await filePlay(shared, goneFile, '2026-01-03T10:00:00Z')
    await shared.$client.query(
      `insert into movie_plays (title_id, season, episode, provider, stream_session, host, source, started_at, ended_at)
       values ('tv-2', 1, 1, 'VidFast', 's-1', 'host-a', 'stream', '2026-01-04T10:00:00Z', '2026-01-04T11:00:00Z')`,
    )
    const sharedIds = await rows<{ id: string; title_id: string; season: number | null }>(shared, 'select id, title_id, season from movie_ids')

    // This machine met another title first, so its first movie id is the one the shared side gave movie-1.
    await title(local, 'movie-9')
    await title(local, 'movie-1', `aliases = '{uno}'`)
    const localFile = await file(local, '/lib/a.mkv', null)
    await filePlay(local, localFile, '2026-02-01T10:00:00Z')
    const [before] = await rows<{ id: string }>(local, `select id from movie_ids where title_id = 'movie-9'`)
    expect(sharedIds.map((r) => r.id)).toContain(before!.id)

    const result = await importMoviesFromShared(shared, local)
    expect(result.state).toBe('done')

    const [one] = await rows<{ rating: number; watched_at: Date | null; aliases: string[] }>(
      local,
      `select rating, watched_at, aliases from movie_titles where id = 'movie-1'`,
    )
    expect(one).toMatchObject({ rating: 4, aliases: ['one', 'uno'] })
    expect(one!.watched_at).not.toBeNull()
    expect(await rows(local, `select 1 from movie_episodes where title_id = 'tv-2'`)).toHaveLength(1)

    const localIds = await rows<{ id: string; title_id: string; season: number | null }>(local, 'select id, title_id, season from movie_ids')
    for (const s of sharedIds) expect(localIds).toContainEqual(s)
    const nine = localIds.filter((r) => r.title_id === 'movie-9')
    expect(nine).toHaveLength(1)
    expect(sharedIds.map((r) => r.id)).not.toContain(nine[0]!.id)
    expect(new Set(localIds.map((r) => r.id)).size).toBe(localIds.length)

    const files = await rows<{ id: string; path: string; status: string; title_id: string | null }>(local, 'select id, path, status, title_id from movie_files order by path')
    expect(files.map((f) => f.path)).toEqual(['/lib/a.mkv', '/lib/gone.mkv'])
    expect(files[0]).toMatchObject({ id: String(localFile), status: 'matched', title_id: 'movie-1' })
    const plays = await rows<{ file_id: string | null; source: string }>(local, 'select file_id, source from movie_plays order by started_at')
    expect(plays).toEqual([
      { file_id: String(localFile), source: 'live' },
      { file_id: files[1]!.id, source: 'live' },
      { file_id: null, source: 'stream' },
      { file_id: String(localFile), source: 'live' },
    ])

    // A title met after the copy gets an id nobody holds.
    await title(local, 'movie-10')
    expect(await rows(local, `select 1 from movie_ids where title_id = 'movie-10'`)).toHaveLength(1)

    expect(await rows(local, 'select 1 from app_settings where key = $1', [MOVIES_IMPORT_KEY])).toHaveLength(1)
    expect(await importMoviesFromShared(shared, local)).toEqual({ state: 'already' })
  })

  it('changes nothing while the shared database cannot be read', async () => {
    const broken = createDb('postgres://nobody:nothing@127.0.0.1:1/none')
    try {
      await title(local, 'movie-9')
      expect((await importMoviesFromShared(broken, local)).state).toBe('unavailable')
      expect(await rows(local, 'select 1 from app_settings where key = $1', [MOVIES_IMPORT_KEY])).toHaveLength(0)
    } finally {
      await closeDb(broken)
    }
  })
})

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { closeDb, createDb, type Db } from '../../src/db/client.js'
import { SHARED_IMPORT_KEY, STAGE_SCHEMA, mergeStagedImport, sharedImportState, stageSharedImport } from '../../src/db/sharedImport.js'
import { MIGRATIONS_DIR, closeTestDb, openTestDb, testDatabaseUrl, truncateAll } from './setup.js'

const LOCAL_DB = 'mcp_notes_local_import_test'
const VECTOR = `('[' || array_to_string(array_fill(0.25::float4, array[1536]), ',') || ']')::vector`

async function rows<T>(db: Db, text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.$client.query(text, params)).rows as T[]
}
const run = (db: Db, text: string, params: unknown[] = []): Promise<unknown> => db.$client.query(text, params)

async function title(db: Db, id: string, extra = ''): Promise<void> {
  const [kind, tmdb] = id.split('-')
  await run(db, `insert into movie_titles (id, kind, tmdb_id, title, original_title) values ($1, $2, $3, $1, $1)`, [id, kind, Number(tmdb)])
  if (extra !== '') await run(db, `update movie_titles set ${extra} where id = $1`, [id])
}

async function file(db: Db, path: string, titleId: string | null): Promise<number> {
  const [row] = await rows<{ id: string }>(
    db,
    `insert into movie_files (title_id, host, path, name, status, reason) values ($1, 'host-a', $2, $2, $3, $4) returning id`,
    [titleId, path, titleId === null ? 'unmatched' : 'matched', titleId === null ? 'no_match' : null],
  )
  return Number(row!.id)
}

const filePlay = (db: Db, fileId: number, at: string): Promise<unknown> =>
  run(db, `insert into movie_plays (file_id, host, source, started_at, ended_at, position_s) values ($1, 'host-a', 'live', $2, $2, 60)`, [fileId, at])

async function session(db: Db, id: string, nodeId: string, offset: number, reply: string): Promise<void> {
  await run(db, `insert into cc_sessions (session_id, node_id, host, transcript_offset) values ($1, $2, 'host-a', $3)`, [id, nodeId, offset])
  await run(db, `insert into cc_session_prompts (session_id, seq, text) values ($1, 1, 'prompt')`, [id])
  await run(db, `insert into cc_session_replies (session_id, seq, text) values ($1, 1, $2)`, [id, reply])
}

describe('the copy of the old shared database', () => {
  let shared: Db
  let local: Db

  beforeAll(async () => {
    shared = openTestDb()
    if ((await rows(shared, 'select 1 from pg_database where datname = $1', [LOCAL_DB])).length === 0) await run(shared, `create database ${LOCAL_DB}`)
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
    await run(local, `drop schema if exists ${STAGE_SCHEMA} cascade`)
    for (const db of [shared, local]) {
      await truncateAll(db)
      await db.execute(sql`truncate table movie_stream_sources, stream_trending, cc_pending_spawns`)
      await db.execute(sql`alter sequence movie_id_seq restart`)
    }
  })

  it('is pending until every table is staged, staged until merged, and done after', async () => {
    expect(await sharedImportState(local)).toBe('pending')
    await expect(mergeStagedImport(local)).rejects.toThrow(/not staged/)
    await stageSharedImport(shared, local)
    expect(await sharedImportState(local)).toBe('staged')
    await mergeStagedImport(local)
    expect(await sharedImportState(local)).toBe('done')
    expect(await rows(local, 'select 1 from information_schema.schemata where schema_name = $1', [STAGE_SCHEMA])).toHaveLength(0)
    expect(await rows(local, 'select 1 from app_settings where key = $1', [SHARED_IMPORT_KEY])).toHaveLength(1)
  })

  it('carries on after an interruption without reading a staged table again', async () => {
    await run(shared, `insert into notes (id, body) values ('A-001', 'old')`)
    await stageSharedImport(shared, local)
    await run(local, `delete from ${STAGE_SCHEMA}._progress where table_name in ('#complete', 'note_images')`)
    expect(await sharedImportState(local)).toBe('pending')
    // A note written to the shared side after `notes` was staged is not picked up: that table is done.
    await run(shared, `insert into notes (id, body) values ('A-002', 'late')`)
    await stageSharedImport(shared, local)
    expect(await rows(local, `select id from ${STAGE_SCHEMA}.notes`)).toEqual([{ id: 'A-001' }])
    expect(await sharedImportState(local)).toBe('staged')
  })

  it('pages through a table', async () => {
    await run(shared, `insert into notes (id, body) select 'A-' || lpad(g::text, 3, '0'), 'n' || g from generate_series(1, 25) g`)
    const staged = await stageSharedImport(shared, local, { page: 10 })
    expect(staged.notes).toBe(25)
    await mergeStagedImport(local)
    expect((await rows<{ n: string }>(local, 'select count(*) as n from notes'))[0]!.n).toBe('25')
  })

  it('merges notes, chat and sessions into a machine that already wrote its own', async () => {
    // Shared: a note with a revision, a vector and a session link; a chat thread; two sessions.
    await run(shared, `insert into notes (id, body, created_at) values ('A-001', 'the old note', '2026-01-01T00:00:00.123456Z')`)
    await run(shared, `insert into note_revisions (note_id, body) values ('A-001', 'the older text')`)
    await run(shared, `insert into note_embeddings (note_id, body_sha256, model, embedding) values ('A-001', 'sha', 'm', ${VECTOR})`)
    await session(shared, 's-old', 'AA-01', 500, 'old reply')
    await session(shared, 's-other', 'BB-02', 900, 'other reply')
    await run(shared, `insert into note_session_links (note_id, session_id) values ('A-001', 's-old')`)
    await run(shared, `insert into chat_threads (id, source, external_key) values ('t-shared', 'claude_code', 'key-1'), ('t-only', 'wall', null)`)
    await run(shared, `insert into chat_messages (id, thread_id, role, text, source) values ('m-1', 't-shared', 'user', 'first', 'claude_code'), ('m-2', 't-only', 'user', 'second', 'wall')`)
    await run(shared, `insert into chat_message_revisions (message_id, text) values ('m-1', 'was')`)
    await run(shared, `insert into app_settings (key, value) values ('shared-marker', '1'::jsonb), ('both', '"shared"'::jsonb)`)

    // Local, written while the shared side could not be read: a note on the same id, a session the
    // shared side also has (read further), a new session on a node id the shared side uses.
    await run(local, `insert into notes (id, body) values ('A-001', 'the new note'), ('B-002', 'another new note')`)
    await run(local, `insert into note_revisions (note_id, body) values ('A-001', 'new, before')`)
    await title(local, 'movie-7', `review_note_id = 'A-001'`)
    await session(local, 's-old', 'ZZ-99', 800, 'reply as re-read here')
    await session(local, 's-new', 'BB-02', 100, 'new reply')
    await run(local, `insert into note_session_links (note_id, session_id) values ('A-001', 's-new')`)
    await run(local, `insert into chat_threads (id, source, external_key) values ('t-local', 'claude_code', 'key-1')`)
    await run(local, `insert into chat_messages (id, thread_id, role, text, source) values ('m-9', 't-local', 'user', 'third', 'claude_code')`)
    await run(local, `insert into app_settings (key, value) values ('both', '"local"'::jsonb)`)

    await stageSharedImport(shared, local)
    await mergeStagedImport(local)

    // The shared note keeps its id and its microseconds; the local one moved, with what pointed at it.
    const notes = await rows<{ id: string; body: string; at: string }>(local, `select id, body, created_at::text as at from notes order by body`)
    expect(notes.map((n) => n.body)).toEqual(['another new note', 'the new note', 'the old note'])
    expect(notes[2]).toMatchObject({ id: 'A-001' })
    expect(notes[2]!.at).toContain('.123456')
    const moved = notes[1]!.id
    expect(moved).not.toBe('A-001')
    expect(moved).toMatch(/^[0-9A-Z]-[0-9A-Z]{3}$/)
    expect(await rows(local, `select note_id, body from note_revisions order by body`)).toEqual([
      { note_id: moved, body: 'new, before' },
      { note_id: 'A-001', body: 'the older text' },
    ])
    expect(await rows(local, `select review_note_id from movie_titles where id = 'movie-7'`)).toEqual([{ review_note_id: moved }])
    expect(await rows(local, `select note_id, vector_dims(embedding) as dims from note_embeddings`)).toEqual([{ note_id: 'A-001', dims: 1536 }])
    expect(await rows(local, `select note_id, session_id from note_session_links order by session_id`)).toEqual([
      { note_id: moved, session_id: 's-new' },
      { note_id: 'A-001', session_id: 's-old' },
    ])

    // The session both sides know is the shared one; the local one keeps its row on a free node id.
    const sessions = await rows<{ session_id: string; node_id: string; transcript_offset: string }>(
      local,
      'select session_id, node_id, transcript_offset from cc_sessions order by session_id',
    )
    expect(sessions[0]).toMatchObject({ session_id: 's-new', transcript_offset: '100' })
    expect(sessions[0]!.node_id).not.toBe('BB-02')
    expect(sessions[1]).toEqual({ session_id: 's-old', node_id: 'AA-01', transcript_offset: '500' })
    expect(sessions[2]).toEqual({ session_id: 's-other', node_id: 'BB-02', transcript_offset: '900' })
    expect(await rows(local, 'select session_id, text from cc_session_replies order by session_id')).toEqual([
      { session_id: 's-new', text: 'new reply' },
      { session_id: 's-old', text: 'old reply' },
      { session_id: 's-other', text: 'other reply' },
    ])

    // One thread per external key; messages in order, the shared ones first.
    expect((await rows<{ id: string }>(local, 'select id from chat_threads order by id')).map((t) => t.id)).toEqual(['t-local', 't-only'])
    expect(await rows(local, 'select id, thread_id from chat_messages order by seq')).toEqual([
      { id: 'm-1', thread_id: 't-local' },
      { id: 'm-2', thread_id: 't-only' },
      { id: 'm-9', thread_id: 't-local' },
    ])
    expect(await rows(local, 'select message_id, text from chat_message_revisions')).toEqual([{ message_id: 'm-1', text: 'was' }])
    await run(local, `insert into chat_messages (id, thread_id, role, text, source) values ('m-10', 't-only', 'user', 'after', 'wall')`)
    expect((await rows<{ id: string }>(local, 'select id from chat_messages order by seq desc limit 1'))[0]!.id).toBe('m-10')

    expect(await rows(local, `select key, value from app_settings where key in ('both', 'shared-marker') order by key`)).toEqual([
      { key: 'both', value: 'local' },
      { key: 'shared-marker', value: 1 },
    ])
  })

  it('merges the movie tables: marks and plays arrive, a file scanned here keeps its row, the shared movie ids win', async () => {
    await title(shared, 'movie-1', `watched_at = '2026-01-02T00:00:00Z', rating = 4, aliases = '{one}'`)
    await title(shared, 'tv-2')
    await run(shared, `insert into movie_episodes (title_id, season, episode, name) values ('tv-2', 1, 1, 'Pilot')`)
    const sharedFile = await file(shared, '/lib/a.mkv', 'movie-1')
    await filePlay(shared, sharedFile, '2026-01-02T10:00:00Z')
    const goneFile = await file(shared, '/lib/gone.mkv', null)
    await filePlay(shared, goneFile, '2026-01-03T10:00:00Z')
    await run(
      shared,
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

    await stageSharedImport(shared, local)
    await mergeStagedImport(local)

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
    expect(await rows(local, 'select file_id, source from movie_plays order by started_at')).toEqual([
      { file_id: String(localFile), source: 'live' },
      { file_id: files[1]!.id, source: 'live' },
      { file_id: null, source: 'stream' },
      { file_id: String(localFile), source: 'live' },
    ])

    // A title met after the copy gets an id nobody holds.
    await title(local, 'movie-10')
    expect(await rows(local, `select 1 from movie_ids where title_id = 'movie-10'`)).toHaveLength(1)
  })

  it('throws and stages nothing more while the old database cannot be read', async () => {
    const broken = createDb('postgres://nobody:nothing@127.0.0.1:1/none')
    try {
      await expect(stageSharedImport(broken, local)).rejects.toThrow()
      expect(await sharedImportState(local)).toBe('pending')
    } finally {
      await closeDb(broken)
    }
  })
})

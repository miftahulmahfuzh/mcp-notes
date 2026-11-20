import type pg from 'pg'

import { generateId } from '../notes/ids.js'
import { generateNodeId } from '../sessions/ids.js'
import { closeDb, createDb, type Db } from './client.js'

/**
 * The one-time copy of the old shared database (IMPORT_DATABASE_URL) into this machine's own.
 *
 * It runs in two steps, because the shared database may be unreadable for weeks while this machine
 * already works on its own:
 *
 * 1. Staging (`stageSharedImport`, behind the running daemon): each table is read page by page
 *    into the `import_stage` schema of the local database. A table that is done is never read
 *    again, so an interrupted run carries on where it stopped.
 * 2. Merging (`mergeStagedImport`, at the daemon's start, before anything else uses the database):
 *    one transaction of local SQL moves the staged rows into the real tables, then the stage is
 *    dropped and a marker row in `app_settings` makes it final.
 *
 * What the merge does with rows this machine wrote meanwhile:
 * - A note, a chat thread or a session written here stays. A local note or session whose random id
 *   the shared side also uses gets a new id: the shared ids are the ones notes and people quote.
 * - A session both sides know is taken from the shared side with its prompts and replies (its
 *   summary and node id are there); the ingester reads on from the offset that row holds.
 * - Chat messages keep their order: the local ones are numbered after the shared ones.
 * - The movie tables merge as before: the owner's marks and plays arrive, a file already scanned
 *   here keeps its row, the shared movie ids win.
 * - Vectors of sessions and replies are not copied (the workers make them again), and neither are
 *   pending spawns.
 */
export const SHARED_IMPORT_KEY = 'shared_import'
export const SHARED_IMPORT_RETRY_MS = 60 * 60_000
export const SHARED_IMPORT_PAGE = 500
export const STAGE_SCHEMA = 'import_stage'
const COMPLETE = '#complete'
const MOVIE_ID_SEQ = '#movie_id_seq'

const NOTE_TABLES = ['notes', 'note_images', 'note_files', 'note_revisions', 'note_embeddings', 'note_image_embeddings'] as const
const CHAT_TABLES = ['chat_images', 'chat_threads', 'chat_messages', 'chat_message_revisions', 'chat_message_attachments'] as const
const SESSION_TABLES = ['cc_sessions', 'cc_subagent_transcripts', 'cc_session_prompts', 'cc_session_prompt_images', 'cc_session_replies', 'note_session_links'] as const
const OTHER_TABLES = ['app_settings', 'adversary_reviews'] as const
/** Movie tables that are added where absent. */
const MOVIE_FILL_TABLES = [
  'movie_companies',
  'movie_people',
  'movie_title_companies',
  'movie_episodes',
  'movie_episode_marks',
  'movie_dialogues',
  'movie_stream_sources',
  'stream_providers',
  'stream_provider_health',
  'stream_trending',
  'stream_torrents',
  'stream_caches',
] as const
const MOVIE_STAGED_TABLES = ['movie_titles', 'movie_credits', 'movie_files', 'movie_plays', 'movie_ids'] as const
export const SHARED_IMPORT_TABLES: readonly string[] = [
  ...NOTE_TABLES,
  ...CHAT_TABLES,
  ...SESSION_TABLES,
  ...OTHER_TABLES,
  ...MOVIE_FILL_TABLES,
  ...MOVIE_STAGED_TABLES,
]
/** Rows of a shared session that the shared side replaces, children first. */
const SESSION_CHILD_TABLES = ['cc_session_prompt_images', 'cc_session_prompts', 'cc_session_reply_embeddings', 'cc_session_replies', 'cc_session_embeddings'] as const
const TITLE_OWNER_COLUMNS = ['watched_at', 'not_interested_at', 'rating', 'review_note_id'] as const

export type SharedImportState = 'done' | 'staged' | 'pending'

type Queryable = Pick<pg.PoolClient, 'query'>

const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`
const list = (cols: readonly string[], prefix = ''): string => cols.map((c) => `${prefix}${ident(c)}`).join(', ')
const stage = (table: string): string => `${ident(STAGE_SCHEMA)}.${ident(table)}`

async function plainColumns(q: Queryable, table: string): Promise<string[]> {
  const res = await q.query(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = $1 and is_generated = 'NEVER' order by ordinal_position`,
    [table],
  )
  return res.rows.map((r: { column_name: string }) => r.column_name)
}

async function stageExists(q: Queryable): Promise<boolean> {
  const res = await q.query(`select 1 from information_schema.tables where table_schema = $1 and table_name = '_progress'`, [STAGE_SCHEMA])
  return (res.rowCount ?? 0) > 0
}

/** Where the copy stands in `local`. */
export async function sharedImportState(local: Db): Promise<SharedImportState> {
  const done = await local.$client.query('select 1 from app_settings where key = $1', [SHARED_IMPORT_KEY])
  if ((done.rowCount ?? 0) > 0) return 'done'
  if (!(await stageExists(local.$client))) return 'pending'
  const complete = await local.$client.query(`select 1 from ${stage('_progress')} where table_name = $1`, [COMPLETE])
  return (complete.rowCount ?? 0) > 0 ? 'staged' : 'pending'
}

export interface StageOptions {
  page?: number
}

/**
 * Reads every table of `shared` that is not staged yet into the stage schema of `local`. Throws
 * when `shared` cannot be read; what was staged so far stays. Answers the rows staged per table.
 */
export async function stageSharedImport(shared: Db, local: Db, options: StageOptions = {}): Promise<Record<string, number>> {
  const page = options.page ?? SHARED_IMPORT_PAGE
  const l = local.$client
  const s = shared.$client
  await l.query(`create schema if not exists ${ident(STAGE_SCHEMA)}`)
  await l.query(
    `create table if not exists ${stage('_progress')} (table_name text primary key, rows bigint not null, columns text[] not null default '{}')`,
  )
  const staged = new Map<string, number>(
    (await l.query(`select table_name, rows from ${stage('_progress')}`)).rows.map((r: { table_name: string; rows: string }) => [r.table_name, Number(r.rows)]),
  )
  for (const table of SHARED_IMPORT_TABLES) {
    if (staged.has(table)) continue
    const mine = await plainColumns(l, table)
    const theirs = new Set(await plainColumns(s, table))
    // A column or table a later migration added here is not on the shared side: it keeps its default.
    const cols = mine.filter((c) => theirs.has(c))
    await l.query(`drop table if exists ${stage(table)}`)
    await l.query(`create unlogged table ${stage(table)} (like ${ident(table)})`)
    let rows = 0
    if (cols.length > 0) {
      let after = '(0,0)'
      for (;;) {
        const res = await s.query(
          `select t.ctid::text as c, (select to_jsonb(r) from (select ${list(cols, 't.')}) r)::text as j
           from ${ident(table)} t where t.ctid > $1::tid order by t.ctid limit ${page}`,
          [after],
        )
        const got = res.rows as { c: string; j: string }[]
        if (got.length === 0) break
        await l.query(
          `insert into ${stage(table)} (${list(cols)}) select ${list(cols)} from jsonb_populate_recordset(null::${stage(table)}, $1::jsonb)`,
          [`[${got.map((r) => r.j).join(',')}]`],
        )
        rows += got.length
        after = got[got.length - 1]!.c
        if (got.length < page) break
      }
    }
    await l.query(`insert into ${stage('_progress')} (table_name, rows, columns) values ($1, $2, $3)`, [table, rows, cols])
    staged.set(table, rows)
  }
  if (!staged.has(MOVIE_ID_SEQ)) {
    const seq = (await s.query('select last_value::text as v, is_called from movie_id_seq')).rows[0] as { v: string; is_called: boolean }
    const value = seq.is_called ? Number(seq.v) : -1
    await l.query(`insert into ${stage('_progress')} (table_name, rows) values ($1, $2)`, [MOVIE_ID_SEQ, value])
    staged.set(MOVIE_ID_SEQ, value)
  }
  await l.query(`insert into ${stage('_progress')} (table_name, rows) values ($1, 0) on conflict do nothing`, [COMPLETE])
  staged.delete(MOVIE_ID_SEQ)
  return Object.fromEntries(staged)
}

interface Staged {
  rows: number
  columns: string[]
}

interface FillOptions {
  /** Columns left out, so the local default (a sequence) fills them. */
  omit?: readonly string[]
  /** SQL for a column, in place of `s.<column>`. */
  map?: Record<string, string>
  /** Extra `from` items after the staged table `s`. */
  join?: string
  where?: string
  order?: string
  /** Default `on conflict do nothing`. */
  tail?: string
}

async function freshId(q: Queryable, generate: () => string, taken: string): Promise<string> {
  for (let i = 0; i < 1000; i += 1) {
    const id = generate()
    const res = await q.query(taken, [id])
    if ((res.rowCount ?? 0) === 0) return id
  }
  throw new Error('no free id found')
}

export interface MergeOptions {
  now?: () => Date
}

/**
 * Moves the staged rows into the real tables in one transaction and marks the copy done. Call it
 * only while nothing else writes to `local` (the daemon's start). Answers the rows written per
 * table; throws, with nothing changed, when the stage is not complete or a statement fails.
 */
export async function mergeStagedImport(local: Db, options: MergeOptions = {}): Promise<Record<string, number>> {
  if ((await sharedImportState(local)) !== 'staged') throw new Error('the shared import is not staged')
  const progress = new Map<string, Staged>(
    (await local.$client.query(`select table_name, rows, columns from ${stage('_progress')}`)).rows.map(
      (r: { table_name: string; rows: string; columns: string[] }) => [r.table_name, { rows: Number(r.rows), columns: r.columns }],
    ),
  )
  const has = (table: string): boolean => (progress.get(table)?.columns.length ?? 0) > 0
  const colsOf = (table: string): string[] => progress.get(table)?.columns ?? []
  const written: Record<string, number> = {}
  const client = await local.$client.connect()
  const fill = async (table: string, o: FillOptions = {}): Promise<number> => {
    if (!has(table)) return 0
    const cols = colsOf(table).filter((c) => !(o.omit ?? []).includes(c))
    const select = cols.map((c) => o.map?.[c] ?? `s.${ident(c)}`).join(', ')
    const res = await client.query(
      `insert into ${ident(table)} (${list(cols)}) select ${select} from ${stage(table)} s ${o.join ?? ''}
       ${o.where ? `where ${o.where}` : ''} ${o.order ? `order by ${o.order}` : ''} ${o.tail ?? 'on conflict do nothing'}`,
    )
    written[table] = res.rowCount ?? 0
    return written[table]
  }
  const exists = (table: string, on: string): string => `exists (select 1 from ${ident(table)} p where ${on})`
  try {
    await client.query('begin')
    // No trigger hands out a new movie id for a copied row, and no foreign key is checked row by row.
    await client.query(`set local session_replication_role = replica`)

    // Notes. A local note whose id the shared side uses moves to a new id, with everything that points at it.
    if (has('notes')) {
      const refs = (
        await client.query(
          `select c.conrelid::regclass::text as tbl, a.attname as col from pg_constraint c
           join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
           where c.contype = 'f' and c.confrelid = 'public.notes'::regclass and array_length(c.conkey, 1) = 1`,
        )
      ).rows as { tbl: string; col: string }[]
      refs.push({ tbl: 'movie_titles', col: 'review_note_id' })
      const clashes = (await client.query(`select l.id from notes l join ${stage('notes')} s on s.id = l.id`)).rows as { id: string }[]
      for (const { id } of clashes) {
        const next = await freshId(client, generateId, `select 1 from notes where id = $1 union all select 1 from ${stage('notes')} where id = $1`)
        await client.query('update notes set id = $2 where id = $1', [id, next])
        for (const r of refs) await client.query(`update ${r.tbl} set ${ident(r.col)} = $2 where ${ident(r.col)} = $1`, [id, next])
      }
    }
    await fill('notes')
    const noteThere = exists('notes', 'p.id = s.note_id')
    await fill('note_images', { where: noteThere })
    await fill('note_files', { where: noteThere })
    await fill('note_revisions', { omit: ['id'], where: noteThere, order: 's.id' })
    await fill('note_embeddings', { where: noteThere })
    await fill('note_image_embeddings', { where: exists('note_images', 'p.id = s.image_id') })

    // Chat. A thread both sides opened under one external key is one thread; local messages are numbered after the shared ones.
    await fill('chat_images')
    if (has('chat_threads')) {
      const keyed = colsOf('chat_threads').includes('external_key')
      await client.query(
        `create temp table _thread_map on commit drop as
         select s.id as old_id, coalesce(l.id, s.id) as new_id, l.id is not null as existed
         from ${stage('chat_threads')} s
         left join chat_threads l on ${keyed ? 'l.external_key is not null and l.external_key = s.external_key' : 'false'}`,
      )
      await fill('chat_threads', { where: `not exists (select 1 from _thread_map m where m.old_id = s.id and m.existed)` })
      if (has('chat_messages')) {
        const top = (
          await client.query(`select (select max(seq) from ${stage('chat_messages')}) as theirs, (select max(seq) from chat_messages) as mine`)
        ).rows[0] as { theirs: string | null; mine: string | null }
        if (top.theirs !== null && top.mine !== null) {
          await client.query('update chat_messages set seq = seq + $1', [Math.max(Number(top.theirs), Number(top.mine))])
        }
        await fill('chat_messages', { map: { thread_id: 'm.new_id' }, join: 'join _thread_map m on m.old_id = s.thread_id', order: 's.seq' })
        await client.query(
          `select setval(pg_get_serial_sequence('chat_messages', 'seq'), greatest((select max(seq) from chat_messages), 1), (select count(*) > 0 from chat_messages))`,
        )
      }
      const messageThere = exists('chat_messages', 'p.id = s.message_id')
      await fill('chat_message_revisions', { omit: ['id'], where: messageThere, order: 's.id' })
      await fill('chat_message_attachments', { where: messageThere })
    }

    // Sessions. A session both sides know comes from the shared side; a local one keeps its row, on a free node id.
    if (has('cc_sessions')) {
      const shared = `(select session_id from ${stage('cc_sessions')})`
      for (const table of SESSION_CHILD_TABLES) await client.query(`delete from ${ident(table)} where session_id in ${shared}`)
      await client.query(`delete from cc_sessions where session_id in ${shared}`)
      if (has('cc_subagent_transcripts')) {
        await client.query(`delete from cc_subagent_transcripts where transcript_path in (select transcript_path from ${stage('cc_subagent_transcripts')})`)
      }
      const clashes = (await client.query(`select l.session_id from cc_sessions l join ${stage('cc_sessions')} s on s.node_id = l.node_id`)).rows as {
        session_id: string
      }[]
      for (const { session_id } of clashes) {
        const next = await freshId(
          client,
          () => generateNodeId(),
          `select 1 from cc_sessions where node_id = $1 union all select 1 from ${stage('cc_sessions')} where node_id = $1`,
        )
        await client.query('update cc_sessions set node_id = $2 where session_id = $1', [session_id, next])
      }
      await fill('cc_sessions')
      await fill('cc_subagent_transcripts')
      const sessionThere = exists('cc_sessions', 'p.session_id = s.session_id')
      await fill('cc_session_prompts', { where: sessionThere })
      await fill('cc_session_prompt_images', {
        where: `${exists('cc_session_prompts', 'p.session_id = s.session_id and p.seq = s.prompt_seq')} and ${exists('chat_images', 'p.id = s.image_id')}`,
      })
      await fill('cc_session_replies', { where: sessionThere })
    }
    await fill('note_session_links', { where: `${exists('notes', 'p.id = s.note_id')} and ${exists('cc_sessions', 'p.session_id = s.session_id')}` })

    await fill('app_settings', { where: `s.key <> '${SHARED_IMPORT_KEY}'` })
    if (has('adversary_reviews')) {
      const top = (
        await client.query(`select (select max(id) from ${stage('adversary_reviews')}) as theirs, (select max(id) from adversary_reviews) as mine`)
      ).rows[0] as { theirs: string | null; mine: string | null }
      if (top.theirs !== null && top.mine !== null) {
        const shift = Math.max(Number(top.theirs), Number(top.mine))
        const reused = colsOf('adversary_reviews').includes('reused_from') ? ', reused_from = reused_from + $1' : ''
        await client.query(`update adversary_reviews set id = id + $1${reused}`, [shift])
      }
      await fill('adversary_reviews')
      await client.query(
        `select setval(pg_get_serial_sequence('adversary_reviews', 'id'), greatest((select max(id) from adversary_reviews), 1), (select count(*) > 0 from adversary_reviews))`,
      )
    }

    // Movies.
    for (const table of MOVIE_FILL_TABLES) await fill(table)
    if (has('movie_titles')) {
      const owner = TITLE_OWNER_COLUMNS.filter((c) => colsOf('movie_titles').includes(c))
      const keep = [
        ...owner.map((c) => `${ident(c)} = coalesce(movie_titles.${ident(c)}, excluded.${ident(c)})`),
        ...(colsOf('movie_titles').includes('aliases')
          ? ['aliases = array(select distinct a from unnest(movie_titles.aliases || excluded.aliases) a order by a)']
          : []),
      ]
      await fill('movie_titles', { tail: keep.length > 0 ? `on conflict (id) do update set ${keep.join(', ')}` : 'on conflict do nothing' })
    }
    if (has('movie_credits')) {
      await client.query('create temp table _credit_titles on commit drop as select distinct title_id from movie_credits')
      await fill('movie_credits', { omit: ['id'], where: 's.title_id not in (select title_id from _credit_titles)', order: 's.id' })
    }
    if (has('movie_files')) {
      await client.query(
        `create temp table _file_map on commit drop as
         select s.id as old_id, coalesce(f.id, nextval(pg_get_serial_sequence('movie_files', 'id'))) as new_id, f.id is not null as existed
         from ${stage('movie_files')} s
         left join movie_files f on s.deleted_at is null and f.deleted_at is null and f.host = s.host and f.path = s.path`,
      )
      await fill('movie_files', { map: { id: 'm.new_id' }, join: 'join _file_map m on m.old_id = s.id', where: 'not m.existed', tail: '' })
      await client.query(
        `update movie_files f set done_at = coalesce(f.done_at, s.done_at), watched_at = coalesce(f.watched_at, s.watched_at)
         from ${stage('movie_files')} s join _file_map m on m.old_id = s.id where m.existed and f.id = m.new_id`,
      )
      // The owner's manual match on the shared side beats a file this machine could not match by itself.
      await client.query(
        `update movie_files f set title_id = s.title_id, status = s.status, reason = s.reason, season = s.season,
                episode = s.episode, absolute_episode = s.absolute_episode
         from ${stage('movie_files')} s join _file_map m on m.old_id = s.id
         where m.existed and f.id = m.new_id and f.status <> 'matched' and s.status = 'matched'`,
      )
      await fill('movie_plays', {
        omit: ['id'],
        map: { file_id: 'm.new_id' },
        join: 'left join _file_map m on m.old_id = s.file_id',
        where: 's.file_id is null or m.new_id is not null',
        order: 's.id',
      })
    }
    if (has('movie_ids')) {
      const same = `s.title_id = l.title_id and s.season is not distinct from l.season and s.episode is not distinct from l.episode`
      await client.query(
        `create temp table _displaced on commit drop as
         select l.title_id, l.season, l.episode from movie_ids l
         where exists (select 1 from ${stage('movie_ids')} s where s.id = l.id) and not exists (select 1 from ${stage('movie_ids')} s where ${same})`,
      )
      await client.query(`delete from movie_ids l using ${stage('movie_ids')} s where s.id = l.id or (${same})`)
      await fill('movie_ids', { tail: '' })
      const seq = progress.get(MOVIE_ID_SEQ)?.rows ?? -1
      if (seq >= 0) {
        await client.query(
          `select setval('movie_id_seq', greatest($1::bigint, (select case when is_called then last_value else 0 end from movie_id_seq)), true)`,
          [seq],
        )
      }
      await client.query('insert into movie_ids (title_id, season, episode) select title_id, season, episode from _displaced')
    }

    await client.query(`insert into app_settings (key, value) values ($1, $2::jsonb)`, [
      SHARED_IMPORT_KEY,
      JSON.stringify({ at: (options.now?.() ?? new Date()).toISOString(), rows: written }),
    ])
    await client.query('commit')
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }
  await local.$client.query(`drop schema if exists ${ident(STAGE_SCHEMA)} cascade`)
  return written
}

export interface SharedImportJobOptions extends StageOptions {
  retryMs?: number
  log?: (line: string) => void
  /** Called once every table is staged: the merge runs at the daemon's next start. */
  onStaged?: () => void
  /** Default `createDb`. */
  open?: (url: string) => Db
}

/** Stages the shared database now and then every `retryMs` until it is all staged; answers how to stop trying. */
export function startSharedImport(importUrl: string, local: Db, options: SharedImportJobOptions = {}): () => void {
  const log = options.log ?? ((line: string) => console.log(line))
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const attempt = async (): Promise<void> => {
    if (stopped) return
    const shared = (options.open ?? createDb)(importUrl)
    try {
      const rows = await stageSharedImport(shared, local, options)
      const total = Object.values(rows).reduce((a, n) => a + n, 0)
      log(`[notesd] shared import: ${total} rows of ${Object.keys(rows).length} tables staged; they are merged at the next start`)
      options.onStaged?.()
      return
    } catch (err) {
      log(`[notesd] shared import: the old database cannot be read yet (${(err instanceof Error ? err.message : String(err)).slice(0, 120)}); trying again later`)
    } finally {
      await closeDb(shared).catch(() => {})
    }
    if (!stopped) {
      timer = setTimeout(() => void attempt(), options.retryMs ?? SHARED_IMPORT_RETRY_MS)
      timer.unref()
    }
  }
  void attempt()
  return () => {
    stopped = true
    if (timer !== null) clearTimeout(timer)
  }
}

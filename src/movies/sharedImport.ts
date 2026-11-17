import type pg from 'pg'

import type { Db } from '../db/client.js'

/**
 * The one-time copy of the movie_* and stream_* tables from the shared (Neon) database into this
 * machine's movies database. It merges: the machine may have run on its own database for a while
 * before the shared one could be read.
 *
 * - Rows with a natural key are added where this machine has none (its own row is newer).
 * - A title keeps this machine's row and takes the owner's marks (watched, not interested, rating,
 *   review, aliases) it lacks.
 * - Files and plays get new ids here; a file this machine already scanned (same host and path) is
 *   the same file, so its shared plays move onto it.
 * - Movie ids (`M-23T4`) are the shared ones: notes and the owner quote them. A local id that
 *   collides with one is issued again from the sequence.
 *
 * The marker row in the movies database's `app_settings` makes it run once.
 */
export const MOVIES_IMPORT_KEY = 'movies_import_from_shared'
export const MOVIES_IMPORT_RETRY_MS = 60 * 60_000
export const MOVIES_IMPORT_PAGE = 2_000
const INSERT_CHUNK = 500

/** Added where absent, in an order that never matters (foreign keys are not checked during the copy). */
const FILL_TABLES = [
  'movie_companies',
  'movie_people',
  'movie_title_companies',
  'movie_episodes',
  'movie_episode_marks',
  'movie_dialogues',
  'movie_stream_sources',
  'stream_providers',
  'stream_provider_health',
  'stream_probe_titles',
  'stream_trending',
  'stream_torrents',
  'stream_caches',
] as const
const STAGED_TABLES = ['movie_titles', 'movie_credits', 'movie_files', 'movie_plays', 'movie_ids'] as const
const ALL_TABLES = [...FILL_TABLES, ...STAGED_TABLES]
const TITLE_OWNER_COLUMNS = ['watched_at', 'not_interested_at', 'rating', 'review_note_id'] as const

export type MoviesImportResult =
  | { state: 'already' }
  | { state: 'unavailable'; reason: string }
  | { state: 'done'; rows: Record<string, number> }

type Queryable = Pick<pg.PoolClient, 'query'>

const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`
const list = (cols: readonly string[], prefix = ''): string => cols.map((c) => `${prefix}${ident(c)}`).join(', ')

async function plainColumns(q: Queryable, table: string): Promise<string[]> {
  const res = await q.query(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = $1 and is_generated = 'NEVER' order by ordinal_position`,
    [table],
  )
  return res.rows.map((r: { column_name: string }) => r.column_name)
}

async function readTable(shared: Queryable, table: string, cols: readonly string[], page: number): Promise<string[]> {
  const out: string[] = []
  for (let offset = 0; ; offset += page) {
    const res = await shared.query(
      `select to_jsonb(x)::text as j from (select ${list(cols)} from ${ident(table)} order by ctid limit ${page} offset ${offset}) x`,
    )
    for (const r of res.rows as { j: string }[]) out.push(r.j)
    if (res.rows.length < page) return out
  }
}

/** `insert into <target> (<cols>) select <cols> from <the rows> <tail>`, in chunks; answers the rows written. */
async function insertRows(q: Queryable, target: string, rowType: string, cols: readonly string[], rows: readonly string[], tail: string): Promise<number> {
  let written = 0
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const res = await q.query(
      `insert into ${target} (${list(cols)}) select ${list(cols)} from jsonb_populate_recordset(null::${ident(rowType)}, $1::jsonb) ${tail}`,
      [`[${rows.slice(i, i + INSERT_CHUNK).join(',')}]`],
    )
    written += res.rowCount ?? 0
  }
  return written
}

async function stage(q: Queryable, table: string, cols: readonly string[], rows: readonly string[]): Promise<string> {
  const temp = `_shared_${table}`
  await q.query(`create temp table ${ident(temp)} (like ${ident(table)}) on commit drop`)
  await insertRows(q, ident(temp), table, cols, rows, '')
  return ident(temp)
}

export interface MoviesImportOptions {
  page?: number
  now?: () => Date
}

/** Runs the copy once; `unavailable` when the shared database cannot be read (nothing is changed). */
export async function importMoviesFromShared(shared: Db, local: Db, options: MoviesImportOptions = {}): Promise<MoviesImportResult> {
  const marker = await local.$client.query('select 1 from app_settings where key = $1', [MOVIES_IMPORT_KEY])
  if ((marker.rowCount ?? 0) > 0) return { state: 'already' }

  const page = options.page ?? MOVIES_IMPORT_PAGE
  const columns = new Map<string, string[]>()
  const data = new Map<string, string[]>()
  let sharedSeq: { last_value: string; is_called: boolean }
  try {
    for (const table of ALL_TABLES) {
      const cols = await plainColumns(local.$client, table)
      columns.set(table, cols)
      data.set(table, await readTable(shared.$client, table, cols, page))
    }
    sharedSeq = (await shared.$client.query('select last_value::text, is_called from movie_id_seq')).rows[0]
  } catch (err) {
    return { state: 'unavailable', reason: err instanceof Error ? err.message : String(err) }
  }

  const rows: Record<string, number> = {}
  const client = await local.$client.connect()
  try {
    await client.query('begin')
    // No trigger hands out a new movie id for a copied row, and no foreign key is checked row by row.
    await client.query(`set local session_replication_role = replica`)
    await client.query(`lock table ${STAGED_TABLES.map(ident).join(', ')} in share row exclusive mode`)
    const again = await client.query('select 1 from app_settings where key = $1', [MOVIES_IMPORT_KEY])
    if ((again.rowCount ?? 0) > 0) {
      await client.query('rollback')
      return { state: 'already' }
    }

    for (const table of FILL_TABLES) {
      rows[table] = await insertRows(client, ident(table), table, columns.get(table)!, data.get(table)!, 'on conflict do nothing')
    }

    const titleCols = columns.get('movie_titles')!
    const keep = TITLE_OWNER_COLUMNS.map((c) => `${ident(c)} = coalesce(movie_titles.${ident(c)}, excluded.${ident(c)})`).join(', ')
    rows.movie_titles = await insertRows(
      client,
      'movie_titles',
      'movie_titles',
      titleCols,
      data.get('movie_titles')!,
      `on conflict (id) do update set ${keep},
         aliases = array(select distinct a from unnest(movie_titles.aliases || excluded.aliases) a order by a)`,
    )

    const creditCols = columns.get('movie_credits')!.filter((c) => c !== 'id')
    const credits = await stage(client, 'movie_credits', columns.get('movie_credits')!, data.get('movie_credits')!)
    rows.movie_credits =
      (
        await client.query(
          `insert into movie_credits (${list(creditCols)})
           select ${list(creditCols, 's.')} from ${credits} s
           where s.title_id not in (select distinct title_id from movie_credits)
           order by s.id`,
        )
      ).rowCount ?? 0

    const fileCols = columns.get('movie_files')!
    const fileRest = fileCols.filter((c) => c !== 'id')
    const files = await stage(client, 'movie_files', fileCols, data.get('movie_files')!)
    await client.query(
      `create temp table _file_map on commit drop as
       select s.id as old_id, coalesce(f.id, nextval(pg_get_serial_sequence('movie_files', 'id'))) as new_id, f.id is not null as existed
       from ${files} s
       left join movie_files f on s.deleted_at is null and f.deleted_at is null and f.host = s.host and f.path = s.path`,
    )
    rows.movie_files =
      (
        await client.query(
          `insert into movie_files (id, ${list(fileRest)})
           select m.new_id, ${list(fileRest, 's.')} from ${files} s join _file_map m on m.old_id = s.id where not m.existed`,
        )
      ).rowCount ?? 0
    await client.query(
      `update movie_files f set done_at = coalesce(f.done_at, s.done_at), watched_at = coalesce(f.watched_at, s.watched_at)
       from ${files} s join _file_map m on m.old_id = s.id where m.existed and f.id = m.new_id`,
    )
    // The owner's manual match on the shared side beats a file this machine could not match by itself.
    await client.query(
      `update movie_files f set title_id = s.title_id, status = s.status, reason = s.reason, season = s.season,
              episode = s.episode, absolute_episode = s.absolute_episode
       from ${files} s join _file_map m on m.old_id = s.id
       where m.existed and f.id = m.new_id and f.status <> 'matched' and s.status = 'matched'`,
    )

    const playRest = columns.get('movie_plays')!.filter((c) => c !== 'id' && c !== 'file_id')
    const plays = await stage(client, 'movie_plays', columns.get('movie_plays')!, data.get('movie_plays')!)
    rows.movie_plays =
      (
        await client.query(
          `insert into movie_plays (file_id, ${list(playRest)})
           select m.new_id, ${list(playRest, 's.')} from ${plays} s left join _file_map m on m.old_id = s.file_id
           where s.file_id is null or m.new_id is not null
           order by s.id
           on conflict do nothing`,
        )
      ).rowCount ?? 0

    const ids = await stage(client, 'movie_ids', columns.get('movie_ids')!, data.get('movie_ids')!)
    const sameTarget = `s.title_id = l.title_id and s.season is not distinct from l.season and s.episode is not distinct from l.episode`
    await client.query(
      `create temp table _displaced on commit drop as
       select l.title_id, l.season, l.episode from movie_ids l
       where exists (select 1 from ${ids} s where s.id = l.id) and not exists (select 1 from ${ids} s where ${sameTarget})`,
    )
    await client.query(`delete from movie_ids l using ${ids} s where s.id = l.id or (${sameTarget})`)
    rows.movie_ids = (await client.query(`insert into movie_ids select * from ${ids}`)).rowCount ?? 0
    if (sharedSeq.is_called) {
      await client.query(
        `select setval('movie_id_seq', greatest($1::bigint, (select case when is_called then last_value else 0 end from movie_id_seq)), true)`,
        [sharedSeq.last_value],
      )
    }
    await client.query(`insert into movie_ids (title_id, season, episode) select title_id, season, episode from _displaced`)

    await client.query(
      `insert into app_settings (key, value) values ($1, $2::jsonb)`,
      [MOVIES_IMPORT_KEY, JSON.stringify({ at: (options.now?.() ?? new Date()).toISOString(), rows })],
    )
    await client.query('commit')
    return { state: 'done', rows }
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export interface MoviesImportJobOptions extends MoviesImportOptions {
  retryMs?: number
  log?: (line: string) => void
  /** Called once the copy has run, so the library shows what arrived. */
  onDone?: () => void
}

/** Tries the copy now and then every `retryMs` until it has run; answers how to stop trying. */
export function startMoviesImport(shared: Db, local: Db, options: MoviesImportJobOptions = {}): () => void {
  const log = options.log ?? ((line: string) => console.log(line))
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const attempt = async (): Promise<void> => {
    if (stopped) return
    let again = true
    try {
      const result = await importMoviesFromShared(shared, local, options)
      if (result.state === 'unavailable') {
        log(`[notesd] movies import: the shared database cannot be read yet (${result.reason.slice(0, 120)}); trying again later`)
      } else {
        again = false
        if (result.state === 'done') {
          log(`[notesd] movies import: copied from the shared database: ${Object.entries(result.rows).map(([t, n]) => `${t} ${n}`).join(', ')}`)
          options.onDone?.()
        }
      }
    } catch (err) {
      log(`[notesd] movies import: failed, nothing was changed: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (again && !stopped) {
      timer = setTimeout(() => void attempt(), options.retryMs ?? MOVIES_IMPORT_RETRY_MS)
      timer.unref()
    }
  }
  void attempt()
  return () => {
    stopped = true
    if (timer !== null) clearTimeout(timer)
  }
}

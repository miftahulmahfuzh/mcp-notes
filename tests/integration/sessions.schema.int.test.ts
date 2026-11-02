import { readFileSync } from 'node:fs'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { MIGRATIONS_DIR, closeTestDb, openTestDb, truncateAll } from './setup.js'

function pgErrorCode(err: unknown): string | undefined {
  let cur: unknown = err
  while (cur && typeof cur === 'object') {
    const code = (cur as { code?: unknown }).code
    if (typeof code === 'string') return code
    cur = (cur as { cause?: unknown }).cause
  }
  return undefined
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p
    return undefined
  } catch (err) {
    return pgErrorCode(err)
  }
}

describe('migration 0007 (cc_sessions)', () => {
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

  it('is journal entry 7', () => {
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>
    }
    expect(journal.entries.find((e) => e.idx === 7)?.tag).toBe('0007_cc_sessions')
  })

  it('creates the tables and indexes', async () => {
    const res = await db.execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where schemaname = 'public' order by indexname`,
    )
    expect(res.rows.map((r) => r.indexname)).toEqual(
      expect.arrayContaining([
        'cc_sessions_pkey',
        'cc_sessions_node_id_uniq',
        'cc_sessions_repo_started_idx',
        'cc_sessions_parent_idx',
        'cc_sessions_host_idx',
        'cc_sessions_name_idx',
        'cc_sessions_last_active_idx',
        'cc_sessions_search_gin',
        'cc_session_embeddings_pkey',
        'cc_session_embeddings_embedding_hnsw_idx',
        'cc_session_embeddings_next_attempt_idx',
        'cc_pending_spawns_pkey',
        'cc_pending_spawns_open_idx',
        'cc_pending_spawns_created_idx',
        'app_settings_pkey',
        'chat_threads_project_updated_idx',
      ]),
    )
  })

  it('adds a nullable chat_threads.project', async () => {
    const res = await db.execute<{ is_nullable: string; data_type: string }>(sql`
      select is_nullable, data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'chat_threads' and column_name = 'project'
    `)
    expect(res.rows).toEqual([{ is_nullable: 'YES', data_type: 'text' }])
  })

  it('applies defaults and fills the generated search column', async () => {
    await db.execute(sql`insert into cc_sessions (session_id, node_id, host, name, summary, prompts)
      values ('s-1', 'A0-3G', 'h', 'orch-wall-editing', 'fixed the photo delete', '[{"text":"why does resume break","at":null}]'::jsonb)`)
    const row = await db.execute<{ input_tokens: string; models: unknown; files_edited: unknown; transcript_offset: string }>(
      sql`select input_tokens, models, files_edited, transcript_offset from cc_sessions where session_id = 's-1'`,
    )
    expect(row.rows[0]).toEqual({ input_tokens: '0', models: {}, files_edited: [], transcript_offset: '0' })
    for (const q of ['photo delete', 'resume', 'orch', 'wall']) {
      const hit = await db.execute<{ n: number }>(
        sql`select count(*)::int as n from cc_sessions where search_tsv @@ plainto_tsquery('simple', ${q})`,
      )
      expect(hit.rows[0]?.n, q).toBe(1)
    }
  })

  it('rejects malformed node ids, unknown link sources and half links', async () => {
    expect(await codeOf(db.execute(sql`insert into cc_sessions (session_id, node_id, host) values ('s-1', 'a0-3g', 'h')`))).toBe('23514')
    expect(
      await codeOf(
        db.execute(sql`insert into cc_sessions (session_id, node_id, host, parent_session_id, parent_link_source) values ('s-2', 'A0-3H', 'h', 'p', 'guess')`),
      ),
    ).toBe('23514')
    expect(
      await codeOf(db.execute(sql`insert into cc_sessions (session_id, node_id, host, parent_session_id) values ('s-3', 'A0-3J', 'h', 'p')`)),
    ).toBe('23514')
  })

  it('keeps node ids unique', async () => {
    await db.execute(sql`insert into cc_sessions (session_id, node_id, host) values ('s-1', 'A0-3G', 'h')`)
    expect(await codeOf(db.execute(sql`insert into cc_sessions (session_id, node_id, host) values ('s-2', 'A0-3G', 'h')`))).toBe('23505')
  })

  it('cascades embeddings when a session row is removed', async () => {
    await db.execute(sql`insert into cc_sessions (session_id, node_id, host) values ('s-1', 'A0-3G', 'h')`)
    await db.execute(sql`insert into cc_session_embeddings (session_id, sha, model) values ('s-1', 'x', 'm')`)
    await db.execute(sql`delete from cc_sessions where session_id = 's-1'`)
    const n = await db.execute<{ n: number }>(sql`select count(*)::int as n from cc_session_embeddings`)
    expect(n.rows[0]?.n).toBe(0)
  })
})

import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, createDb, type Db } from '../../src/db/client.js';
import { MIGRATIONS_DIR, testDatabaseUrl } from './setup.js';

/**
 * Migration 0010 on a 0009-shaped database that already holds sessions: it adds
 * `cc_sessions.summary_requested_at`, `cc_sessions.prompts_version` and `cc_session_prompts`,
 * and changes nothing else. Runs in its own database inside the Docker container.
 */

const DB_PREFIX = 'mcp_notes_mig0010_';

type Journal = { entries: Array<{ idx: number; tag: string }> } & Record<string, unknown>;

function urlForDatabase(name: string): string {
  const u = new URL(testDatabaseUrl());
  u.pathname = `/${name}`;
  return u.toString();
}

async function dropStaleDatabases(admin: Db): Promise<void> {
  const res = await admin.execute<{ datname: string }>(sql`select datname from pg_database where starts_with(datname, ${DB_PREFIX})`);
  for (const row of res.rows) await admin.execute(sql.raw(`drop database if exists "${row.datname}" with (force)`));
}

/** A migrations folder holding the journal entries with idx <= maxIdx. */
async function migrationsUpTo(maxIdx: number): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `mcp-notes-mig0010-${maxIdx}-`));
  await mkdir(path.join(dir, 'meta'));
  const journal = JSON.parse(await readFile(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as Journal;
  const kept = journal.entries.filter((e) => e.idx <= maxIdx);
  if (kept.length !== maxIdx + 1) throw new Error(`drizzle/meta/_journal.json lacks entries 0..${maxIdx}`);
  if (maxIdx >= 10 && kept[10]?.tag !== '0010_session_prompts_summary_requests') {
    throw new Error('journal entry 10 is not 0010_session_prompts_summary_requests');
  }
  await writeFile(path.join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: kept }, null, 2));
  for (const e of kept) await copyFile(path.join(MIGRATIONS_DIR, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  return dir;
}

function pgErrorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  while (cur && typeof cur === 'object') {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return pgErrorCode(err);
  }
}

describe('migration 0010 (summary requests, full prompts)', () => {
  const dbName = `${DB_PREFIX}${process.pid}_${randomBytes(4).toString('hex')}`;
  let admin: Db;
  let mig: Db;
  const dirs: string[] = [];
  let before: unknown[];

  beforeAll(async () => {
    admin = createDb(testDatabaseUrl());
    await dropStaleDatabases(admin);
    await admin.execute(sql.raw(`create database "${dbName}"`));
    mig = createDb(urlForDatabase(dbName));

    const upTo9 = await migrationsUpTo(9);
    dirs.push(upTo9);
    await migrate(mig, { migrationsFolder: upTo9 });

    await mig.execute(sql`insert into cc_sessions
      (session_id, node_id, host, repo, first_prompt, last_prompt, input_tokens, prompts, summary, summary_sha, summarized_at)
      values
      ('s-1', 'A0-3G', 'pc', 'mcp-notes', 'why does resume break', 'ship it', 1200,
       '[{"text":"why does resume break","at":"2026-11-01T10:00:00.000Z"},{"text":"ship it","at":null}]'::jsonb,
       'Fixed resume', 'sha-1', '2026-11-01T11:00:00Z'),
      ('s-2', 'B1-4H', 'GPD', 'seer', null, null, 0, '[]'::jsonb, null, null, null)`);
    before = (await mig.execute(sql`select to_jsonb(s) as j from cc_sessions s order by session_id`)).rows;

    const upTo10 = await migrationsUpTo(10);
    dirs.push(upTo10);
    await migrate(mig, { migrationsFolder: upTo10 });
  });

  afterAll(async () => {
    if (mig) await closeDb(mig);
    if (admin) {
      await admin.execute(sql.raw(`drop database if exists "${dbName}" with (force)`));
      await closeDb(admin);
    }
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it('applies exactly one migration on top of 0000-0009', async () => {
    const res = await mig.execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect(res.rows[0]?.n).toBe(11);
  });

  it('leaves every existing session column as it was', async () => {
    const after = await mig.execute(
      sql`select to_jsonb(s) - 'summary_requested_at' - 'prompts_version' as j from cc_sessions s order by session_id`,
    );
    expect(after.rows).toEqual(before);
  });

  it('gives existing sessions no request and the legacy prompts version', async () => {
    const res = await mig.execute<{ session_id: string; summary_requested_at: unknown; prompts_version: number }>(
      sql`select session_id, summary_requested_at, prompts_version from cc_sessions order by session_id`,
    );
    expect(res.rows).toEqual([
      { session_id: 's-1', summary_requested_at: null, prompts_version: 0 },
      { session_id: 's-2', summary_requested_at: null, prompts_version: 0 },
    ]);
  });

  it('adds the two cc_sessions columns with the planned types and defaults', async () => {
    const res = await mig.execute<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(sql`
      select column_name, data_type, is_nullable, column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'cc_sessions' and column_name in ('summary_requested_at', 'prompts_version')
      order by column_name
    `);
    expect(res.rows).toEqual([
      { column_name: 'prompts_version', data_type: 'integer', is_nullable: 'NO', column_default: '0' },
      { column_name: 'summary_requested_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
    ]);
  });

  it('creates cc_session_prompts with the planned columns, defaults and primary key', async () => {
    const cols = await mig.execute<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(sql`
      select column_name, data_type, is_nullable, column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'cc_session_prompts' order by ordinal_position
    `);
    expect(cols.rows).toEqual([
      { column_name: 'session_id', data_type: 'text', is_nullable: 'NO', column_default: null },
      { column_name: 'seq', data_type: 'integer', is_nullable: 'NO', column_default: null },
      { column_name: 'at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
      { column_name: 'text', data_type: 'text', is_nullable: 'NO', column_default: null },
      { column_name: 'truncated', data_type: 'boolean', is_nullable: 'NO', column_default: 'false' },
    ]);
    const idx = await mig.execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where schemaname = 'public' and tablename = 'cc_session_prompts' order by indexname`,
    );
    expect(idx.rows.map((r) => r.indexname)).toEqual(['cc_session_prompts_session_id_seq_pk']);
    const n = await mig.execute<{ n: number }>(sql`select count(*)::int as n from cc_session_prompts`);
    expect(n.rows[0]?.n).toBe(0);
  });

  it('keys prompts by (session, seq), requires text and a known session, and cascades on session delete', async () => {
    await mig.execute(sql`insert into cc_session_prompts (session_id, seq, at, text) values ('s-2', 0, now(), 'first'), ('s-2', 1, null, 'second')`);
    const t = await mig.execute<{ truncated: boolean }>(sql`select truncated from cc_session_prompts where session_id = 's-2' and seq = 0`);
    expect(t.rows[0]?.truncated).toBe(false);
    expect(await codeOf(mig.execute(sql`insert into cc_session_prompts (session_id, seq, text) values ('s-2', 1, 'dup')`))).toBe('23505');
    expect(await codeOf(mig.execute(sql`insert into cc_session_prompts (session_id, seq, text) values ('s-2', 2, null)`))).toBe('23502');
    expect(await codeOf(mig.execute(sql`insert into cc_session_prompts (session_id, seq, text) values ('nope', 0, 'x')`))).toBe('23503');
    await mig.execute(sql`delete from cc_sessions where session_id = 's-2'`);
    const n = await mig.execute<{ n: number }>(sql`select count(*)::int as n from cc_session_prompts`);
    expect(n.rows[0]?.n).toBe(0);
  });
});

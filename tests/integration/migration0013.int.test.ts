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
 * Migration 0013 on a 0012-shaped database that already holds sessions: `cc_sessions.search_tsv`
 * is re-generated with commit subjects (column dropped and re-added, GIN index dropped and
 * recreated) and `cc_session_embeddings.text_version` is added (0 for existing rows). Runs in its
 * own database inside the Docker container.
 */

const DB_PREFIX = 'mcp_notes_mig0013_';

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
  const dir = await mkdtemp(path.join(os.tmpdir(), `mcp-notes-mig0013-${maxIdx}-`));
  await mkdir(path.join(dir, 'meta'));
  const journal = JSON.parse(await readFile(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as Journal;
  const kept = journal.entries.filter((e) => e.idx <= maxIdx);
  if (kept.length !== maxIdx + 1) throw new Error(`drizzle/meta/_journal.json lacks entries 0..${maxIdx}`);
  if (maxIdx >= 13 && kept[13]?.tag !== '0013_session_commit_search') {
    throw new Error('journal entry 13 is not 0013_session_commit_search');
  }
  await writeFile(path.join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: kept }, null, 2));
  for (const e of kept) await copyFile(path.join(MIGRATIONS_DIR, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  return dir;
}

describe('migration 0013 (commit subjects in session search, embed-text version)', () => {
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

    const upTo12 = await migrationsUpTo(12);
    dirs.push(upTo12);
    await migrate(mig, { migrationsFolder: upTo12 });

    await mig.execute(sql`insert into cc_sessions
      (session_id, node_id, host, repo, first_prompt, prompts, commits, summary)
      values
      ('s-1', 'A0-3G', 'pc', 'mcp-notes', 'why does resume break',
       '[{"text":"why does resume break","at":null}]'::jsonb,
       '[{"sha":"0123456789abcdef","subject":"fix(wall): zanzibar spinner stalls","at":null}]'::jsonb,
       'Fixed resume'),
      ('s-2', 'B1-4H', 'GPD', 'seer', null, '[]'::jsonb, '[]'::jsonb, null)`);
    await mig.execute(sql`insert into cc_session_embeddings (session_id, sha, model) values ('s-1', 'sha-old', 'm')`);
    const zero = await mig.execute<{ n: number }>(
      sql`select count(*)::int as n from cc_sessions where search_tsv @@ plainto_tsquery('simple', 'zanzibar')`,
    );
    expect(zero.rows[0]?.n).toBe(0);
    before = (await mig.execute(sql`select to_jsonb(s) - 'search_tsv' as j from cc_sessions s order by session_id`)).rows;

    const upTo13 = await migrationsUpTo(13);
    dirs.push(upTo13);
    await migrate(mig, { migrationsFolder: upTo13 });
  });

  afterAll(async () => {
    if (mig) await closeDb(mig);
    if (admin) {
      await admin.execute(sql.raw(`drop database if exists "${dbName}" with (force)`));
      await closeDb(admin);
    }
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it('applies exactly one migration on top of 0000-0012', async () => {
    const res = await mig.execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect(res.rows[0]?.n).toBe(14);
  });

  it('re-generates search_tsv of existing rows with commit subjects, not shas', async () => {
    const hit = await mig.execute<{ session_id: string }>(
      sql`select session_id from cc_sessions where search_tsv @@ plainto_tsquery('simple', 'zanzibar spinner')`,
    );
    expect(hit.rows.map((r) => r.session_id)).toEqual(['s-1']);
    const old = await mig.execute<{ session_id: string }>(
      sql`select session_id from cc_sessions where search_tsv @@ plainto_tsquery('simple', 'resume')`,
    );
    expect(old.rows.map((r) => r.session_id)).toEqual(['s-1']);
    const sha = await mig.execute<{ n: number }>(
      sql`select count(*)::int as n from cc_sessions where search_tsv @@ plainto_tsquery('simple', '0123456789abcdef')`,
    );
    expect(sha.rows[0]?.n).toBe(0);
  });

  it('keeps the GIN index on search_tsv', async () => {
    const res = await mig.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where schemaname = 'public' and indexname = 'cc_sessions_search_gin'`,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]?.indexdef).toMatch(/USING gin \(search_tsv\)/);
  });

  it('leaves every other session column as it was', async () => {
    const after = await mig.execute(sql`select to_jsonb(s) - 'search_tsv' as j from cc_sessions s order by session_id`);
    expect(after.rows).toEqual(before);
  });

  it('gives existing embedding rows text_version 0, and new rows default 0', async () => {
    const res = await mig.execute<{ session_id: string; text_version: number }>(
      sql`select session_id, text_version from cc_session_embeddings order by session_id`,
    );
    expect(res.rows).toEqual([{ session_id: 's-1', text_version: 0 }]);
    await mig.execute(sql`insert into cc_session_embeddings (session_id, sha, model) values ('s-2', 'x', 'm')`);
    const fresh = await mig.execute<{ text_version: number }>(sql`select text_version from cc_session_embeddings where session_id = 's-2'`);
    expect(fresh.rows[0]?.text_version).toBe(0);
  });

  it('a commit written after the migration is searchable at once', async () => {
    await mig.execute(sql`update cc_sessions set commits = '[{"sha":"abc","subject":"feat: quokka graph","at":null}]'::jsonb where session_id = 's-2'`);
    const res = await mig.execute<{ session_id: string }>(
      sql`select session_id from cc_sessions where search_tsv @@ plainto_tsquery('simple', 'quokka')`,
    );
    expect(res.rows.map((r) => r.session_id)).toEqual(['s-2']);
  });
});

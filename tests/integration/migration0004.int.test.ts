import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, createDb, type Db } from '../../src/db/client.js';
import { noteFiles, notes } from '../../src/db/schema.js';
import { MIGRATIONS_DIR, testDatabaseUrl } from './setup.js';

/**
 * Migration 0004 on a 0003-shaped database: it adds `note_files` and changes nothing else. Runs
 * in its own database inside the Docker container so the shared test DB is not disturbed.
 */

const DB_PREFIX = 'mcp_notes_mig0004_';

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
  const dir = await mkdtemp(path.join(os.tmpdir(), `mcp-notes-mig0004-${maxIdx}-`));
  await mkdir(path.join(dir, 'meta'));
  const journal = JSON.parse(await readFile(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as Journal;
  const kept = journal.entries.filter((e) => e.idx <= maxIdx);
  if (kept.length !== maxIdx + 1) throw new Error(`drizzle/meta/_journal.json lacks entries 0..${maxIdx}`);
  if (maxIdx >= 4 && kept[4]?.tag !== '0004_note_files') throw new Error('journal entry 4 is not 0004_note_files');
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

async function snapshot(db: Db): Promise<unknown[]> {
  const n = await db.execute(sql`select * from notes order by id`);
  const i = await db.execute(sql`select * from note_images order by id`);
  return [n.rows, i.rows];
}

describe('migration 0004 (note_files)', () => {
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

    const upTo3 = await migrationsUpTo(3);
    dirs.push(upTo3);
    await migrate(mig, { migrationsFolder: upTo3 });
    const t = await mig.execute<{ n: number }>(
      sql`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = 'note_files'`,
    );
    expect(t.rows[0]?.n).toBe(0);

    await mig.execute(sql`insert into notes (id, body, tags) values ('A-B32', 'kept #x', '{x}'), ('C-D45', 'photo', '{}')`);
    await mig.execute(
      sql`insert into note_images (id, note_id, path, sha256, mime, width, height, bytes, host, position)
          values ('C-D45', 'C-D45', 'images/2026/10/C-D45.png', 'img-sha', 'image/png', 4, 4, 10, 'h', 0)`,
    );
    before = await snapshot(mig);

    const upTo4 = await migrationsUpTo(4);
    dirs.push(upTo4);
    await migrate(mig, { migrationsFolder: upTo4 });
  });

  afterAll(async () => {
    if (mig) await closeDb(mig);
    if (admin) {
      await admin.execute(sql.raw(`drop database if exists "${dbName}" with (force)`));
      await closeDb(admin);
    }
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it('applies exactly one migration on top of 0000-0003', async () => {
    const res = await mig.execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect(res.rows[0]?.n).toBe(5);
  });

  it('leaves notes and note_images untouched', async () => {
    expect(await snapshot(mig)).toEqual(before);
  });

  it('creates note_files with the planned columns, defaults and indexes', async () => {
    const cols = await mig.execute<{ column_name: string; is_nullable: string; column_default: string | null }>(
      sql`select column_name, is_nullable, column_default from information_schema.columns
          where table_schema = 'public' and table_name = 'note_files' order by ordinal_position`,
    );
    expect(cols.rows.map((c) => c.column_name)).toEqual([
      'id',
      'note_id',
      'path',
      'sha256',
      'mime',
      'bytes',
      'original_name',
      'host',
      'position',
      'extracted_text',
      'extraction_status',
      'created_at',
      'deleted_at',
    ]);
    const status = cols.rows.find((c) => c.column_name === 'extraction_status');
    expect(status?.is_nullable).toBe('NO');
    expect(status?.column_default).toContain("'none'");
    expect(cols.rows.find((c) => c.column_name === 'extracted_text')?.is_nullable).toBe('YES');

    const idx = await mig.execute<{ indexname: string }>(sql`select indexname from pg_indexes where tablename = 'note_files'`);
    expect(idx.rows.map((r) => r.indexname).sort()).toEqual([
      'note_files_note_position_idx',
      'note_files_path_uniq',
      'note_files_pkey',
      'note_files_sha256_live_uniq',
    ]);
  });

  it('defaults extraction to none, refuses unknown statuses, and keeps sha256 unique among live files', async () => {
    const base = { noteId: 'A-B32', mime: 'text/plain', bytes: 1, originalName: 'a.txt', host: 'h' };
    const [row] = await mig.insert(noteFiles).values({ ...base, id: 'F-1L3', path: 'files/A-B32/a.txt', sha256: 's1', position: 0 }).returning();
    expect(row?.extractionStatus).toBe('none');
    expect(row?.extractedText).toBeNull();
    expect(row?.deletedAt).toBeNull();

    const bad = await mig
      .execute(sql`update note_files set extraction_status = 'bogus' where id = 'F-1L3'`)
      .then(() => null, (e: unknown) => e);
    expect(pgErrorCode(bad)).toBe('23514');

    const dupSha = await mig
      .insert(noteFiles)
      .values({ ...base, id: 'G-2M4', path: 'files/A-B32/b.txt', sha256: 's1', position: 1 })
      .then(() => null, (e: unknown) => e);
    expect(pgErrorCode(dupSha)).toBe('23505');

    const dupPath = await mig
      .insert(noteFiles)
      .values({ ...base, id: 'G-2M4', path: 'files/A-B32/a.txt', sha256: 's2', position: 1 })
      .then(() => null, (e: unknown) => e);
    expect(pgErrorCode(dupPath)).toBe('23505');

    await mig.update(noteFiles).set({ deletedAt: new Date() }).where(eq(noteFiles.id, 'F-1L3'));
    await mig.insert(noteFiles).values({ ...base, id: 'G-2M4', path: 'files/A-B32/b.txt', sha256: 's1', position: 1 });
  });

  it('cascades with its note', async () => {
    await mig.delete(notes).where(eq(notes.id, 'A-B32'));
    const left = await mig.execute<{ n: number }>(sql`select count(*)::int as n from note_files where note_id = 'A-B32'`);
    expect(left.rows[0]?.n).toBe(0);
  });
});

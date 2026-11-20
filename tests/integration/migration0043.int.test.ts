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
 * Migration 0043 on a 0042-shaped database that already holds stories on dialogue rows and a torrent: the stories are
 * copied into movie_stories (origin dialogue), the dialogue rows are left as they were, the torrent has no kept mark,
 * and the download queue is empty. Runs in its own database inside the Docker container.
 */

const DB_PREFIX = 'mcp_notes_mig0043_';
const HASH = '0123456789abcdef0123456789abcdef01234567';

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
  const dir = await mkdtemp(path.join(os.tmpdir(), `mcp-notes-mig0043-${maxIdx}-`));
  await mkdir(path.join(dir, 'meta'));
  const journal = JSON.parse(await readFile(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as Journal;
  const kept = journal.entries.filter((e) => e.idx <= maxIdx);
  if (kept.length !== maxIdx + 1) throw new Error(`drizzle/meta/_journal.json lacks entries 0..${maxIdx}`);
  if (maxIdx >= 43 && kept[43]?.tag !== '0043_stream_downloads_stories') throw new Error('journal entry 43 is not 0043_stream_downloads_stories');
  await writeFile(path.join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: kept }, null, 2));
  for (const e of kept) await copyFile(path.join(MIGRATIONS_DIR, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  return dir;
}

describe('migration 0043 (the download queue, the kept mark, the story store)', () => {
  const dbName = `${DB_PREFIX}${process.pid}_${randomBytes(4).toString('hex')}`;
  let admin: Db;
  let mig: Db;
  const dirs: string[] = [];
  let dialoguesBefore: unknown[];

  beforeAll(async () => {
    admin = createDb(testDatabaseUrl());
    await dropStaleDatabases(admin);
    await admin.execute(sql.raw(`create database "${dbName}"`));
    mig = createDb(urlForDatabase(dbName));

    const upTo42 = await migrationsUpTo(42);
    dirs.push(upTo42);
    await migrate(mig, { migrationsFolder: upTo42 });

    await mig.execute(sql`insert into movie_titles (id, kind, tmdb_id, title, original_title) values
      ('tv-247718', 'tv', 247718, 'MobLand', 'MobLand'), ('movie-550', 'movie', 550, 'Fight Club', 'Fight Club')`);
    await mig.execute(sql`insert into movie_dialogues
      (title_id, season, episode, provider, cues, last_cue_s, body, fetched_at, story, story_model, story_at) values
      ('tv-247718', 1, 2, 'VidNest', 2, 70, 'Who are you?', '2026-11-16T05:00:00Z', 'He fixes it.', 'sonnet', '2026-11-16T06:00:00Z'),
      ('tv-247718', 1, 3, 'VidNest', 2, 70, 'Nothing yet.', '2026-11-16T05:00:00Z', null, null, null),
      ('movie-550', 0, 0, 'VidFast', 3, 90, 'First rule.', '2026-11-16T05:00:00Z', 'A film.', null, null)`);
    await mig.execute(sql`insert into stream_torrents (host, info_hash, kind, tmdb_id, name) values ('host-a', ${HASH}, 'movie', 550, 'Fixture')`);
    dialoguesBefore = (await mig.execute(sql`select to_jsonb(d) as j from movie_dialogues d order by title_id, season, episode`)).rows;

    const upTo43 = await migrationsUpTo(43);
    dirs.push(upTo43);
    await migrate(mig, { migrationsFolder: upTo43 });
  });

  afterAll(async () => {
    if (mig) await closeDb(mig);
    if (admin) {
      await admin.execute(sql.raw(`drop database if exists "${dbName}" with (force)`));
      await closeDb(admin);
    }
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it('applies exactly one migration on top of 0000-0042', async () => {
    const res = await mig.execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect(res.rows[0]?.n).toBe(44);
  });

  it('copies every story written on a dialogue row into movie_stories, origin dialogue', async () => {
    const res = await mig.execute<{ title_id: string; season: number; episode: number; text: string; origin: string; model: string | null; written_at: string; sections: unknown; sources: unknown }>(
      sql`select title_id, season, episode, text, origin, model, to_char(written_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as written_at, sections, sources from movie_stories order by title_id, season, episode`,
    );
    expect(res.rows).toEqual([
      { title_id: 'movie-550', season: 0, episode: 0, text: 'A film.', origin: 'dialogue', model: null, written_at: '2026-11-16T05:00:00Z', sections: [], sources: [] },
      { title_id: 'tv-247718', season: 1, episode: 2, text: 'He fixes it.', origin: 'dialogue', model: 'sonnet', written_at: '2026-11-16T06:00:00Z', sections: [], sources: [] },
    ]);
  });

  it('leaves the dialogue rows as they were', async () => {
    const after = await mig.execute(sql`select to_jsonb(d) as j from movie_dialogues d order by title_id, season, episode`);
    expect(after.rows).toEqual(dialoguesBefore);
  });

  it('gives an existing torrent no kept mark', async () => {
    const res = await mig.execute<{ kept_at: Date | null }>(sql`select kept_at from stream_torrents`);
    expect(res.rows).toEqual([{ kept_at: null }]);
  });

  it('starts an empty download queue that holds one open row per slot and host', async () => {
    expect((await mig.execute<{ n: number }>(sql`select count(*)::int as n from stream_downloads`)).rows[0]?.n).toBe(0);
    await mig.execute(sql`insert into stream_downloads (host, kind, tmdb_id) values ('host-a', 'movie', 550)`);
    await expect(mig.execute(sql`insert into stream_downloads (host, kind, tmdb_id) values ('host-a', 'movie', 550)`)).rejects.toThrow();
  });
});

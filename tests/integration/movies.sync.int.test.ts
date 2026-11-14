import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ADVERSARY_CONFIG,
  DEFAULT_CHAT_CONFIG,
  DEFAULT_DWORD_CONFIG,
  DEFAULT_EMBEDDINGS_CONFIG,
  DEFAULT_MOVIES_CONFIG,
  DEFAULT_SESSIONS_CONFIG,
  type Config,
  type MoviesConfig,
} from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import { MoviesRepo } from '../../src/movies/repo.js';
import { ProbeError, type Probe } from '../../src/movies/scan.js';
import { MoviesService, MoviesServiceError, buildMoviesService, type MovieChangeEvent } from '../../src/movies/service.js';
import { createSyncMemory, runSyncPass, type SyncDeps, type SyncMemory, type SyncReport, type TitleResolver } from '../../src/movies/sync.js';
import { TmdbError } from '../../src/movies/tmdb.js';
import type { TitleKind } from '../../src/movies/types.js';
import { movieMeta, tvMeta } from './helpers/movieMeta.js';
import { closeTestDb, openTestDb } from './setup.js';

const HOST = 'test-host';
const KILLING = 'How.to.Make.a.Killing.2026.1080p.WEB-DL.x265.6CH-Pahe.in.mkv';
const RIVALS = 'The_Rivals_of_Amziah_King_2026_1080p_BluRay_x265_DD+5_1_Pahe_in.mkv';
const MOBLAND = 'Mobland S01 WEB-DL 1080p x265 6CH [Pahe.in]';
const E01 = 'MobLand.S01E01.Stick.or.Twist.1080p.WEB-DL.x265.6CH-Pahe.in.mkv';
const E02 = 'MobLand.S01E02.Alpha.Male.1080p.WEB-DL.x265.6CH-Pahe.in.mkv';
const E03 = 'MobLand.S01E03.Sweet.Dreams.1080p.WEB-DL.x265.6CH-Pahe.in.mkv';
const UNKNOWN = 'Totally.Unknown.Picture.2019.1080p.WEB-DL.x265-Pahe.in.mkv';
const CLIP = 'VID-20250101-WA0001.mp4';
const BAD_APPLES = 'Bad.Apples.2025.1080p.WEB-DL.x265.6CH-Pahe.in.mkv';

const CATALOG: Record<string, { kind: TitleKind; id: number }> = {
  'how to make a killing': { kind: 'movie', id: 467905 },
  oldboy: { kind: 'movie', id: 670 },
  'the rivals of amziah king': { kind: 'movie', id: 1100001 },
  mobland: { kind: 'tv', id: 247718 },
  'bad apples': { kind: 'movie', id: 1200002 },
};

function normalize(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

interface FakeResolver extends TitleResolver {
  down: boolean;
  detailCalls: string[];
}

function fakeResolver(): FakeResolver {
  const r: FakeResolver = {
    down: false,
    detailCalls: [],
    async match(parsed) {
      if (r.down) throw new TmdbError('network', 'TMDB unreachable (test)');
      const hit = CATALOG[normalize(parsed.title)];
      return hit === undefined
        ? { kind: 'none', reason: 'no_match' }
        : { kind: 'matched', tmdbKind: hit.kind, tmdbId: hit.id, confidence: 1, source: 'filename', matchedTitle: parsed.title };
    },
    async details(kind, tmdbId) {
      if (r.down) throw new TmdbError('network', 'TMDB unreachable (test)');
      r.detailCalls.push(`${kind}-${tmdbId}`);
      return kind === 'movie' ? movieMeta(tmdbId) : tvMeta(tmdbId);
    },
  };
  return r;
}

type FileRow = {
  id: string;
  name: string;
  path: string;
  host: string;
  title_id: string | null;
  status: string;
  reason: string | null;
  season: number | null;
  episode: number | null;
  duration_s: number | null;
  deleted: boolean;
  moved: boolean;
  done: boolean;
};

let db: Db;
let repo: MoviesRepo;
let lib: string;
let videos: string;
let telegram: string;
let memory: SyncMemory;
const durations = new Map<string, number>();
let probeCalls = 0;

const probe: Probe = async (file) => {
  probeCalls += 1;
  const seconds = durations.get(path.basename(file));
  if (seconds === undefined) throw new ProbeError('failed', `no duration for ${file}`);
  return seconds;
};

async function video(rel: string, seconds: number | null, size = 4096): Promise<string> {
  const file = path.join(lib, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.alloc(size, 1));
  if (seconds === null) durations.delete(path.basename(file));
  else durations.set(path.basename(file), seconds);
  return file;
}

function deps(resolver: TitleResolver | null, extra: Partial<SyncDeps> = {}): SyncDeps {
  return {
    host: HOST,
    roots: [videos, telegram],
    doneDirs: ['Done'],
    minSeconds: 15 * 60,
    repo,
    resolver,
    probe,
    memory,
    log: () => {},
    ...extra,
  };
}

/** New files need two passes: the first records their size, the second sees it unchanged. */
async function settle(resolver: TitleResolver | null, extra: Partial<SyncDeps> = {}): Promise<SyncReport> {
  await runSyncPass(deps(resolver, extra));
  return runSyncPass(deps(resolver, extra));
}

async function files(): Promise<FileRow[]> {
  const res = await db.execute<FileRow>(sql`
    select id::text as id, name, path, host, title_id, status, reason, season, episode, duration_s,
           deleted_at is not null as deleted, moved_at is not null as moved, done_at is not null as done
    from movie_files order by path`);
  return res.rows;
}

async function file(name: string): Promise<FileRow> {
  const row = (await files()).find((f) => f.name === name);
  if (row === undefined) throw new Error(`no movie_files row named ${name}`);
  return row;
}

function config(movies: MoviesConfig): Config {
  return {
    databaseUrl: 'postgres://unused',
    port: 0,
    host: '127.0.0.1',
    dataDir: lib,
    chat: DEFAULT_CHAT_CONFIG,
    embeddings: DEFAULT_EMBEDDINGS_CONFIG,
    sessions: DEFAULT_SESSIONS_CONFIG,
    adversary: DEFAULT_ADVERSARY_CONFIG,
    dword: DEFAULT_DWORD_CONFIG,
    movies,
  };
}

beforeAll(() => {
  db = openTestDb();
  repo = new MoviesRepo(db);
});

afterAll(async () => {
  await closeTestDb(db);
});

beforeEach(async () => {
  await db.execute(
    sql`truncate table movie_plays, movie_files, movie_episodes, movie_credits, movie_people, movie_title_companies, movie_companies, movie_titles restart identity cascade`,
  );
  lib = await mkdtemp(path.join(os.tmpdir(), 'notesd-movies-'));
  videos = path.join(lib, 'Videos');
  telegram = path.join(lib, 'Telegram');
  await mkdir(videos, { recursive: true });
  await mkdir(telegram, { recursive: true });
  memory = createSyncMemory();
  durations.clear();
  probeCalls = 0;
});

afterEach(async () => {
  await rm(lib, { recursive: true, force: true });
});

describe('movies sync pass', () => {
  it('registers a long video that matches TMDB under its title for this host once its size is stable (R1.1)', async () => {
    const r = fakeResolver();
    await video(`Telegram/${KILLING}`, 7200);
    const first = await runSyncPass(deps(r));
    expect(first.waiting).toBe(1);
    expect(await files()).toEqual([]);
    const second = await runSyncPass(deps(r));
    expect(second).toMatchObject({ new: 1, matched: 1, error: null });
    expect(await file(KILLING)).toMatchObject({
      host: HOST,
      status: 'matched',
      reason: null,
      title_id: 'movie-467905',
      season: null,
      episode: null,
      duration_s: 7200,
      deleted: false,
    });
  });

  it('stores a title\'s metadata the first time it is matched and fetches it once (R2.1)', async () => {
    const r = fakeResolver();
    await video(`Telegram/${KILLING}`, 7200);
    await video(`Telegram/${MOBLAND}/${E01}`, 3500);
    await video(`Telegram/${MOBLAND}/${E02}`, 3300);
    await settle(r);
    expect([...r.detailCalls].sort()).toEqual(['movie-467905', 'tv-247718']);

    const title = (
      await db.execute<{ poster_path: string | null; release_date: string | null; overview: string }>(
        sql`select poster_path, release_date::text as release_date, overview from movie_titles where id = 'movie-467905'`,
      )
    ).rows[0];
    expect(title).toEqual({ poster_path: '/poster-467905.jpg', release_date: '2026-02-20', overview: 'Synopsis of film 467905.' });
    const credits = (
      await db.execute<{ role: string; name: string; character: string | null }>(
        sql`select c.role, p.name, c.character from movie_credits c join movie_people p on p.id = c.person_id
            where c.title_id = 'movie-467905' order by c.role, c.ord`,
      )
    ).rows;
    expect(credits).toEqual([
      { role: 'cast', name: 'Glen Powell', character: 'Becket' },
      { role: 'director', name: 'John Patton Ford', character: null },
      { role: 'producer', name: 'Jason Blum', character: null },
      { role: 'writer', name: 'John Patton Ford', character: null },
    ]);
    const companies = (
      await db.execute<{ name: string }>(
        sql`select co.name from movie_title_companies tc join movie_companies co on co.id = tc.company_id where tc.title_id = 'movie-467905'`,
      )
    ).rows;
    expect(companies).toEqual([{ name: 'Blumhouse Productions' }]);
    const episodes = (
      await db.execute<{ season: number; episode: number; name: string }>(
        sql`select season, episode, name from movie_episodes where title_id = 'tv-247718' order by season, episode`,
      )
    ).rows;
    expect(episodes.map((e) => `${e.season}x${e.episode} ${e.name}`)).toEqual(['1x1 Stick or Twist', '1x2 Alpha Male', '1x3 Sweet Dreams']);

    await video(`Telegram/${MOBLAND}/${E03}`, 3400);
    await settle(r);
    expect(r.detailCalls).toHaveLength(2);
  });

  it('keeps every episode of a season folder under one tv title with its own season, episode and deleted flag (R3.5)', async () => {
    const r = fakeResolver();
    await video(`Telegram/${MOBLAND}/${E01}`, 3500);
    const e2 = await video(`Telegram/${MOBLAND}/${E02}`, 3300);
    await settle(r);
    expect(await file(E01)).toMatchObject({ title_id: 'tv-247718', season: 1, episode: 1 });
    expect(await file(E02)).toMatchObject({ title_id: 'tv-247718', season: 1, episode: 2 });
    expect((await db.execute(sql`select id from movie_titles`)).rows).toHaveLength(1);

    await rm(e2);
    await runSyncPass(deps(r));
    expect(await file(E01)).toMatchObject({ deleted: false });
    expect(await file(E02)).toMatchObject({ deleted: true, title_id: 'tv-247718' });
  });

  it('keeps short and unknown videos out of the library as unmatched with the reason (R1.2)', async () => {
    const r = fakeResolver();
    await video(`Videos/Done/docker_es/${CLIP}`, 42);
    await video(`Videos/${UNKNOWN}`, 6000);
    const report = await settle(r);
    expect(report.unmatched).toBe(2);
    expect(await file(CLIP)).toMatchObject({ status: 'unmatched', reason: 'too_short', title_id: null });
    expect(await file(UNKNOWN)).toMatchObject({ status: 'unmatched', reason: 'no_match', title_id: null });
    expect((await db.execute(sql`select id from movie_titles`)).rows).toHaveLength(0);
  });

  it('scans exactly the configured roots, recursively, and nothing else (R1.4)', async () => {
    const r = fakeResolver();
    await video('Videos/Pak Bernard/Oldboy (2003)/Oldboy.mkv', 7200);
    await video('Outside/Oldboy.2003.1080p.mkv', 7200);
    await writeFile(path.join(videos, 'notes.txt'), 'not a video');
    await settle(r);
    expect((await files()).map((f) => path.relative(lib, f.path))).toEqual(['Videos/Pak Bernard/Oldboy (2003)/Oldboy.mkv']);
  });

  it('marks a vanished file deleted and keeps its title and plays (R3.1)', async () => {
    const r = fakeResolver();
    const killing = await video(`Telegram/${KILLING}`, 7200);
    await settle(r);
    const row = await file(KILLING);
    await db.execute(
      sql`insert into movie_plays (file_id, host, source, started_at, position_s, duration_s, updated_at)
          values (${Number(row.id)}, ${HOST}, 'live', now(), 600, 7200, now())`,
    );
    await rm(killing);
    const report = await runSyncPass(deps(r));
    expect(report).toMatchObject({ deleted: 1, moved: 0 });
    expect(await file(KILLING)).toMatchObject({ id: row.id, deleted: true, title_id: 'movie-467905' });
    expect((await db.execute(sql`select id from movie_titles where id = 'movie-467905'`)).rows).toHaveLength(1);
    expect((await db.execute(sql`select id from movie_plays where file_id = ${Number(row.id)}`)).rows).toHaveLength(1);
  });

  it('follows a file moved elsewhere under the roots by name and size instead of deleting it (R3.2)', async () => {
    const r = fakeResolver();
    const from = await video('Videos/Pak Bernard/Oldboy (2003)/Oldboy.mkv', 7200);
    await settle(r);
    const before = await file('Oldboy.mkv');
    const to = path.join(telegram, 'Oldboy.mkv');
    await rename(from, to);
    const report = await runSyncPass(deps(r));
    expect(report).toMatchObject({ moved: 1, deleted: 0, new: 0 });
    const rows = await files();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: before.id, path: to, moved: true, deleted: false, title_id: 'movie-670' });
  });

  it('records a done signal for a file first found inside, or moved into, a Done folder (R3.3)', async () => {
    const r = fakeResolver();
    await video(`Videos/Done/${RIVALS}`, 7000);
    const killing = await video(`Telegram/${KILLING}`, 7200);
    await settle(r);
    expect(await file(RIVALS)).toMatchObject({ done: true, status: 'matched' });
    const before = await file(KILLING);
    expect(before.done).toBe(false);

    await rename(killing, path.join(videos, 'Done', KILLING));
    const report = await runSyncPass(deps(r));
    expect(report).toMatchObject({ moved: 1, done: 1, deleted: 0 });
    expect(await file(KILLING)).toMatchObject({ id: before.id, done: true, moved: true, deleted: false });
  });

  it('finishes the pass with files pending while TMDB is unreachable and matches them on the next pass (R2.3)', async () => {
    const r = fakeResolver();
    await video(`Telegram/${KILLING}`, 7200);
    await video(`Telegram/${MOBLAND}/${E01}`, 3500);
    await video(`Videos/Done/docker_es/${CLIP}`, 42);
    r.down = true;
    const outage = await settle(r);
    expect(outage).toMatchObject({ error: null, tmdb: 'unreachable', pending: 2, unmatched: 1 });
    expect(outage.finished_at).not.toBe('');
    expect(await file(KILLING)).toMatchObject({ status: 'pending', reason: 'tmdb_error', title_id: null });
    expect(await file(E01)).toMatchObject({ status: 'pending', reason: 'tmdb_error' });

    r.down = false;
    const retry = await runSyncPass(deps(r));
    expect(retry).toMatchObject({ matched: 2, tmdb: 'ok' });
    expect(await file(KILLING)).toMatchObject({ status: 'matched', reason: null, title_id: 'movie-467905' });
    expect(await file(E01)).toMatchObject({ status: 'matched', title_id: 'tv-247718', season: 1, episode: 1 });
  });

  it('registers files as no_tmdb_credentials without a resolver and matches them once one exists (R1.2)', async () => {
    await video(`Telegram/${KILLING}`, 7200);
    const off = await settle(null);
    expect(off.tmdb).toBe('no_credentials');
    expect(await file(KILLING)).toMatchObject({ status: 'unmatched', reason: 'no_tmdb_credentials', title_id: null });
    await runSyncPass(deps(fakeResolver()));
    expect(await file(KILLING)).toMatchObject({ status: 'matched', title_id: 'movie-467905' });
  });

  it('holds a file back while its size keeps changing', async () => {
    const r = fakeResolver();
    const killing = await video(`Telegram/${KILLING}`, 7200, 100);
    expect((await runSyncPass(deps(r))).waiting).toBe(1);
    await appendFile(killing, Buffer.alloc(100, 1));
    expect((await runSyncPass(deps(r))).waiting).toBe(1);
    expect(probeCalls).toBe(0);
    expect(await files()).toEqual([]);
    expect((await runSyncPass(deps(r))).new).toBe(1);
  });

  it('stores probe_failed and probes again only after the file changes', async () => {
    const r = fakeResolver();
    const oldboy = await video('Videos/Pak Bernard/Oldboy (2003)/Oldboy.mkv', null);
    await settle(r);
    expect(await file('Oldboy.mkv')).toMatchObject({ status: 'unmatched', reason: 'probe_failed' });
    const calls = probeCalls;
    await runSyncPass(deps(r));
    expect(probeCalls).toBe(calls);

    durations.set('Oldboy.mkv', 7200);
    await appendFile(oldboy, Buffer.alloc(10, 1));
    await settle(r);
    expect(probeCalls).toBe(calls + 1);
    expect(await file('Oldboy.mkv')).toMatchObject({ status: 'matched', title_id: 'movie-670', duration_s: 7200 });
  });

  it('never deletes the files of a root it cannot read', async () => {
    const r = fakeResolver();
    await video(`Telegram/${KILLING}`, 7200);
    await settle(r);
    await rename(telegram, `${telegram}.unmounted`);
    const report = await runSyncPass(deps(r));
    expect(report.deleted).toBe(0);
    expect(report.unreadable).toContain(telegram);
    expect(await file(KILLING)).toMatchObject({ deleted: false });
  });

  it('runs hooks after the scan; a throwing hook never fails the pass', async () => {
    const r = fakeResolver();
    await video(`Telegram/${KILLING}`, 7200);
    let present = 0;
    let resolved: unknown = null;
    const report = await settle(r, {
      hooks: [
        { name: 'broken', afterScan: async () => Promise.reject(new Error('ini unreadable')) },
        {
          name: 'recents',
          afterScan: async (ctx) => {
            present = ctx.present.size;
            resolved = await ctx.resolve(BAD_APPLES);
            return 1;
          },
        },
      ],
    });
    expect(report.error).toBeNull();
    expect(report.hook_errors).toEqual(['broken: ini unreadable']);
    expect(report.hook_writes).toBe(1);
    expect(present).toBe(1);
    expect(resolved).toMatchObject({ status: 'matched', titleId: 'movie-1200002' });
    expect((await db.execute(sql`select id from movie_titles where id = 'movie-1200002'`)).rows).toHaveLength(1);
  });
});

describe('MoviesService', () => {
  function service(resolver: TitleResolver | null): MoviesService {
    return new MoviesService({
      config: { ...DEFAULT_MOVIES_CONFIG, enabled: true, roots: [videos, telegram] },
      host: HOST,
      repo,
      tmdb: null,
      resolver,
      probe,
      log: () => {},
    });
  }

  it('assign registers an unmatched file under the chosen title and stores the title', async () => {
    const s = service(fakeResolver());
    await video(`Videos/${UNKNOWN}`, 6000);
    await s.syncNow();
    await s.syncNow();
    const before = await file(UNKNOWN);
    expect(before.status).toBe('unmatched');
    const events: MovieChangeEvent[] = [];
    s.events.on((e) => events.push(e));

    await s.assign(Number(before.id), { kind: 'movie', tmdbId: 670 });

    expect(await file(UNKNOWN)).toMatchObject({ status: 'matched', reason: null, title_id: 'movie-670' });
    expect((await db.execute(sql`select id from movie_titles where id = 'movie-670'`)).rows).toHaveLength(1);
    expect(events).toEqual([{ type: 'changed', reason: 'assign', title_ids: ['movie-670'], file_ids: [Number(before.id)] }]);
    await s.close();
  });

  it('assign answers not_found for an unknown file and no_tmdb_credentials for a new title without TMDB', async () => {
    await expect(service(fakeResolver()).assign(999_999, { kind: 'movie', tmdbId: 670 })).rejects.toMatchObject({ code: 'not_found' });
    const offline = service(null);
    await video(`Videos/${UNKNOWN}`, 6000);
    await offline.syncNow();
    await offline.syncNow();
    const row = await file(UNKNOWN);
    await expect(offline.assign(Number(row.id), { kind: 'movie', tmdbId: 670 })).rejects.toBeInstanceOf(MoviesServiceError);
    await expect(offline.assign(Number(row.id), { kind: 'movie', tmdbId: 670 })).rejects.toMatchObject({ code: 'no_tmdb_credentials' });
    await offline.close();
  });

  it('is not built with NOTESD_MOVIES=off, and scans nothing without roots', async () => {
    expect(buildMoviesService(config(DEFAULT_MOVIES_CONFIG), db)).toBeNull();
    await video(`Telegram/${KILLING}`, 7200);
    const s = buildMoviesService(config({ ...DEFAULT_MOVIES_CONFIG, enabled: true, roots: [] }), db, {
      host: HOST,
      tmdb: null,
      fallback: null,
      resolver: null,
      probe,
      log: () => {},
    });
    expect(s).not.toBeNull();
    s?.start();
    const report = await s?.syncNow();
    expect(report).toMatchObject({ scanned: 0, new: 0, error: null });
    expect(await files()).toEqual([]);
    expect(probeCalls).toBe(0);
    await s?.close();
  });
});

import { sql } from 'drizzle-orm';
import type { Db } from '../../../src/db/client.js';

export const THIS_HOST = 'movies-this-host';
export const OTHER_HOST = 'movies-other-host';

/** Every movie table, children first. Integration files run one at a time, so this is safe. */
export async function clearMovies(db: Db): Promise<void> {
  await db.execute(sql`delete from movie_plays`);
  await db.execute(sql`delete from movie_files`);
  await db.execute(sql`delete from movie_credits`);
  await db.execute(sql`delete from movie_title_companies`);
  await db.execute(sql`delete from movie_episodes`);
  await db.execute(sql`delete from movie_titles`);
  await db.execute(sql`delete from movie_people`);
  await db.execute(sql`delete from movie_companies`);
}

interface SeedTitle {
  id: string;
  kind: 'movie' | 'tv';
  tmdbId: number;
  title: string;
  year: number;
  releaseDate: string;
  watchedAt?: string;
  seasons?: number;
  episodes?: number;
}

async function insertTitle(db: Db, t: SeedTitle): Promise<void> {
  await db.execute(sql`
    insert into movie_titles (id, kind, tmdb_id, title, original_title, year, release_date, overview, genres,
                              season_count, episode_count, watched_at, metadata_fetched_at, created_at, updated_at)
    values (${t.id}, ${t.kind}, ${t.tmdbId}, ${t.title}, ${t.title}, ${t.year}, ${t.releaseDate}, ${`About ${t.title}.`}, '[]'::jsonb,
            ${t.seasons ?? null}, ${t.episodes ?? null}, ${t.watchedAt ?? null}, now(), now(), now())`);
}

interface SeedFile {
  titleId: string;
  host?: string;
  name: string;
  durationS: number;
  season?: number;
  episode?: number;
  firstSeenAt: string;
  deletedAt?: string;
}

async function insertFile(db: Db, f: SeedFile): Promise<number> {
  const res = await db.execute(sql`
    insert into movie_files (title_id, host, path, name, size, duration_s, season, episode, status, source,
                             first_seen_at, last_seen_at, deleted_at, updated_at)
    values (${f.titleId}, ${f.host ?? THIS_HOST}, ${`/library/${f.name}`}, ${f.name}, 1000000, ${f.durationS},
            ${f.season ?? null}, ${f.episode ?? null}, 'matched', 'scan',
            ${f.firstSeenAt}, ${f.deletedAt ?? f.firstSeenAt}, ${f.deletedAt ?? null}, now())
    returning id`);
  return Number((res.rows[0] as { id: string | number }).id);
}

/** One closed play event on `fileId` (source live). */
export async function insertPlay(
  db: Db,
  fileId: number,
  startedAt: string,
  endedAt: string,
  positionS: number,
  durationS: number,
  host: string = THIS_HOST,
): Promise<void> {
  await db.execute(sql`
    insert into movie_plays (file_id, host, source, started_at, ended_at, start_position_s, position_s, duration_s, updated_at)
    values (${fileId}, ${host}, 'live', ${startedAt}, ${endedAt}, 0, ${positionS}, ${durationS}, now())`);
}

export interface SeededLibrary {
  files: {
    killing: number;
    oldBlumhouse: number;
    unfinished: number;
    moblandE1: number;
    moblandE2: number;
    moblandE3: number;
    nextE1: number;
    nextE2: number;
    gapE1: number;
    gapE3: number;
    otherLaptop: number;
  };
}

/**
 * A small library:
 * - movie-467905 How to Make a Killing: Blumhouse, Margaret Qualley in the cast, finished 2026-03-01.
 * - movie-1001 Old Blumhouse Film: Blumhouse, finished 2025-06-01, file deleted.
 * - movie-1002 Unfinished Blumhouse Film: Blumhouse, played to 1200 of 6000 s on 2026-11-01 (in progress).
 * - tv-247718 MobLand: S1E1 finished then deleted, S1E2 played to 1300 of 3100 s on 2026-11-12 then
 *   deleted (the last episode watched), S1E3 present and never played.
 * - tv-1003 Series Next: E1 finished, E2 present and never played.
 * - tv-1004 Series Gap: E1 finished (file deleted), E2 never had a file, E3 present.
 * - movie-1005 Other Laptop Film: one file on OTHER_HOST.
 * The newest play is MobLand S1E2 (2026-11-12T13:00Z).
 */
export async function seedLibrary(db: Db): Promise<SeededLibrary> {
  await db.execute(sql`insert into movie_companies (id, name) values (3172, 'Blumhouse Productions'), (33, 'Universal Pictures')`);
  await db.execute(sql`insert into movie_people (id, name) values (1373737, 'Margaret Qualley'), (500, 'Tom Hardy')`);

  await insertTitle(db, { id: 'movie-467905', kind: 'movie', tmdbId: 467905, title: 'How to Make a Killing', year: 2026, releaseDate: '2026-02-20', watchedAt: '2026-03-01T13:00:00Z' });
  await insertTitle(db, { id: 'movie-1001', kind: 'movie', tmdbId: 1001, title: 'Old Blumhouse Film', year: 2024, releaseDate: '2024-05-01', watchedAt: '2025-06-01T13:00:00Z' });
  await insertTitle(db, { id: 'movie-1002', kind: 'movie', tmdbId: 1002, title: 'Unfinished Blumhouse Film', year: 2025, releaseDate: '2025-05-01' });
  await insertTitle(db, { id: 'tv-247718', kind: 'tv', tmdbId: 247718, title: 'MobLand', year: 2025, releaseDate: '2025-03-30', seasons: 1, episodes: 3 });
  await insertTitle(db, { id: 'tv-1003', kind: 'tv', tmdbId: 1003, title: 'Series Next', year: 2025, releaseDate: '2025-01-01', seasons: 1, episodes: 2 });
  await insertTitle(db, { id: 'tv-1004', kind: 'tv', tmdbId: 1004, title: 'Series Gap', year: 2025, releaseDate: '2025-01-01', seasons: 1, episodes: 3 });
  await insertTitle(db, { id: 'movie-1005', kind: 'movie', tmdbId: 1005, title: 'Other Laptop Film', year: 2023, releaseDate: '2023-01-01' });

  await db.execute(sql`
    insert into movie_title_companies (title_id, company_id, ord)
    values ('movie-467905', 3172, 0), ('movie-1001', 3172, 0), ('movie-1002', 3172, 0), ('tv-247718', 33, 0)`);
  await db.execute(sql`
    insert into movie_credits (title_id, person_id, role, character, job, ord)
    values ('movie-467905', 1373737, 'cast', 'Julia', null, 0), ('tv-247718', 500, 'cast', 'Harry Da Souza', null, 0)`);
  await db.execute(sql`
    insert into movie_episodes (title_id, season, episode, name)
    values ('tv-247718', 1, 1, 'Stick or Twist'), ('tv-247718', 1, 2, 'Alternative Fuel'), ('tv-247718', 1, 3, 'Sweet Home'),
           ('tv-1003', 1, 1, 'Next One'), ('tv-1003', 1, 2, 'Next Two'),
           ('tv-1004', 1, 1, 'Gap One'), ('tv-1004', 1, 2, 'Gap Two'), ('tv-1004', 1, 3, 'Gap Three')`);

  const files = {
    killing: await insertFile(db, { titleId: 'movie-467905', name: 'How.to.Make.a.Killing.2026.mkv', durationS: 6000, firstSeenAt: '2026-02-28T00:00:00Z' }),
    oldBlumhouse: await insertFile(db, { titleId: 'movie-1001', name: 'Old.Blumhouse.Film.2024.mkv', durationS: 6000, firstSeenAt: '2025-05-30T00:00:00Z', deletedAt: '2025-06-02T00:00:00Z' }),
    unfinished: await insertFile(db, { titleId: 'movie-1002', name: 'Unfinished.Blumhouse.Film.2025.mkv', durationS: 6000, firstSeenAt: '2026-10-30T00:00:00Z' }),
    moblandE1: await insertFile(db, { titleId: 'tv-247718', name: 'MobLand.S01E01.mkv', durationS: 3000, season: 1, episode: 1, firstSeenAt: '2026-11-01T00:00:00Z', deletedAt: '2026-11-11T00:00:00Z' }),
    moblandE2: await insertFile(db, { titleId: 'tv-247718', name: 'MobLand.S01E02.mkv', durationS: 3100, season: 1, episode: 2, firstSeenAt: '2026-11-01T00:00:00Z', deletedAt: '2026-11-13T00:00:00Z' }),
    moblandE3: await insertFile(db, { titleId: 'tv-247718', name: 'MobLand.S01E03.mkv', durationS: 3000, season: 1, episode: 3, firstSeenAt: '2026-11-01T00:00:00Z' }),
    nextE1: await insertFile(db, { titleId: 'tv-1003', name: 'Series.Next.S01E01.mkv', durationS: 3000, season: 1, episode: 1, firstSeenAt: '2026-09-25T00:00:00Z' }),
    nextE2: await insertFile(db, { titleId: 'tv-1003', name: 'Series.Next.S01E02.mkv', durationS: 3000, season: 1, episode: 2, firstSeenAt: '2026-09-25T00:00:00Z' }),
    gapE1: await insertFile(db, { titleId: 'tv-1004', name: 'Series.Gap.S01E01.mkv', durationS: 3000, season: 1, episode: 1, firstSeenAt: '2026-08-25T00:00:00Z', deletedAt: '2026-09-02T00:00:00Z' }),
    gapE3: await insertFile(db, { titleId: 'tv-1004', name: 'Series.Gap.S01E03.mkv', durationS: 3000, season: 1, episode: 3, firstSeenAt: '2026-08-25T00:00:00Z' }),
    otherLaptop: await insertFile(db, { titleId: 'movie-1005', host: OTHER_HOST, name: 'Other.Laptop.Film.2023.mkv', durationS: 5400, firstSeenAt: '2026-01-01T00:00:00Z' }),
  };

  await insertPlay(db, files.killing, '2026-03-01T11:00:00Z', '2026-03-01T12:40:00Z', 5900, 6000);
  await insertPlay(db, files.oldBlumhouse, '2025-06-01T11:00:00Z', '2025-06-01T12:40:00Z', 5950, 6000);
  await insertPlay(db, files.unfinished, '2026-11-01T14:00:00Z', '2026-11-01T14:20:00Z', 1200, 6000);
  await insertPlay(db, files.moblandE1, '2026-11-10T13:00:00Z', '2026-11-10T13:50:00Z', 2950, 3000);
  await insertPlay(db, files.moblandE2, '2026-11-12T13:00:00Z', '2026-11-12T13:22:00Z', 1300, 3100);
  await insertPlay(db, files.nextE1, '2026-10-01T13:00:00Z', '2026-10-01T13:50:00Z', 2950, 3000);
  await insertPlay(db, files.gapE1, '2026-09-01T13:00:00Z', '2026-09-01T13:50:00Z', 2950, 3000);

  return { files };
}

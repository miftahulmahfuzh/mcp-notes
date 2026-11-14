import { sql } from 'drizzle-orm';
import { DEFAULT_MOVIES_CONFIG, type MoviesConfig } from '../../../src/config.js';
import type { Db } from '../../../src/db/client.js';
import type { TmdbClient, TmdbSearchHit } from '../../../src/movies/tmdb.js';
import type { TitleMetadata } from '../../../src/movies/types.js';

export const HOST_HERE = 'host-a';
export const HOST_OTHER = 'host-b';
export const IMAGE_BASE = 'https://image.tmdb.org/t/p';

/** Enabled, no roots (nothing is scanned), TMDB images at the real CDN base. */
export const MOVIES_TEST_CONFIG: MoviesConfig = {
  ...DEFAULT_MOVIES_CONFIG,
  enabled: true,
  roots: [],
  tmdb: { ...DEFAULT_MOVIES_CONFIG.tmdb, imageBase: IMAGE_BASE },
};

export async function truncateMovies(db: Db): Promise<void> {
  await db.execute(sql`truncate table movie_plays, movie_files, movie_credits, movie_people, movie_title_companies,
    movie_companies, movie_episodes, movie_titles restart identity cascade`);
}

interface TitleSeed {
  id: string;
  kind: 'movie' | 'tv';
  tmdbId: number;
  title: string;
  year: number;
  releaseDate: string;
  posterPath: string;
  runtimeMin: number | null;
  seasonCount: number | null;
  episodeCount: number | null;
  createdAt: string;
}

async function insertTitle(db: Db, t: TitleSeed): Promise<void> {
  await db.execute(sql`
    insert into movie_titles (id, kind, tmdb_id, title, original_title, year, release_date, overview, poster_path,
      backdrop_path, runtime_min, genres, season_count, episode_count, metadata_fetched_at, created_at, updated_at)
    values (${t.id}, ${t.kind}, ${t.tmdbId}, ${t.title}, ${t.title}, ${t.year}, ${t.releaseDate}::date,
      ${`Overview of ${t.title}`}, ${t.posterPath}, null, ${t.runtimeMin}, '["Drama"]'::jsonb, ${t.seasonCount},
      ${t.episodeCount}, now(), ${t.createdAt}::timestamptz, now())
  `);
}

interface FileSeed {
  titleId: string | null;
  host: string;
  path: string;
  durationS: number;
  season?: number;
  episode?: number;
  status: 'matched' | 'unmatched' | 'pending';
  reason?: string;
  parsed?: Record<string, unknown>;
  deletedAt?: string;
}

async function insertFile(db: Db, f: FileSeed): Promise<number> {
  const name = f.path.slice(f.path.lastIndexOf('/') + 1);
  const res = await db.execute<{ id: string | number }>(sql`
    insert into movie_files (title_id, host, path, name, size, duration_s, season, episode, absolute_episode, status,
      reason, parsed, source, first_seen_at, last_seen_at, deleted_at, updated_at)
    values (${f.titleId}, ${f.host}, ${f.path}, ${name}, 1000000, ${f.durationS}, ${f.season ?? null},
      ${f.episode ?? null}, null, ${f.status}, ${f.reason ?? null},
      ${f.parsed === undefined ? null : JSON.stringify(f.parsed)}::jsonb, 'scan', '2026-11-01T00:00:00Z'::timestamptz,
      now(), ${f.deletedAt ?? null}::timestamptz, now())
    returning id
  `);
  const row = res.rows[0];
  if (row === undefined) throw new Error('insertFile returned no id');
  return Number(row.id);
}

async function insertPlay(db: Db, fileId: number, host: string, startedAt: string, endedAt: string, position: number, duration: number): Promise<void> {
  await db.execute(sql`
    insert into movie_plays (file_id, host, source, started_at, ended_at, start_position_s, position_s, duration_s, updated_at)
    values (${fileId}, ${host}, 'live', ${startedAt}::timestamptz, ${endedAt}::timestamptz, 0, ${position}, ${duration},
      ${endedAt}::timestamptz)
  `);
}

export interface SeededLibrary {
  /** movie-467905 on HOST_HERE, played to 50%. */
  killingHere: number;
  /** movie-467905 on HOST_OTHER, never played. */
  killingOther: number;
  /** tv-247718 S01E01 on HOST_HERE, deleted after a 96.7% play. */
  mobE1: number;
  /** tv-247718 S01E02 on HOST_HERE, played to 20%. */
  mobE2: number;
  /** Unmatched (no_match) on HOST_HERE. */
  nezha2: number;
  /** Pending (tmdb_error) on HOST_OTHER: never in HOST_HERE's unmatched list. */
  pendingOther: number;
}

/**
 * Two titles and two loose files:
 * - movie-467905 "How to Make a Killing" (Blumhouse; director/writer John Patton Ford; cast Glen Powell, Margaret Qualley)
 * - tv-247718 "MobLand", season 1 with episodes 1..3; E3 has no file.
 */
export async function seedLibrary(db: Db): Promise<SeededLibrary> {
  await insertTitle(db, {
    id: 'movie-467905', kind: 'movie', tmdbId: 467905, title: 'How to Make a Killing', year: 2026,
    releaseDate: '2026-02-20', posterPath: '/kill.jpg', runtimeMin: 100, seasonCount: null, episodeCount: null,
    createdAt: '2026-11-01T00:00:00Z',
  });
  await insertTitle(db, {
    id: 'tv-247718', kind: 'tv', tmdbId: 247718, title: 'MobLand', year: 2025,
    releaseDate: '2025-03-30', posterPath: '/mob.jpg', runtimeMin: null, seasonCount: 1, episodeCount: 3,
    createdAt: '2026-11-02T00:00:00Z',
  });
  await db.execute(sql`insert into movie_companies (id, name, logo_path, origin_country) values (3172, 'Blumhouse Productions', '/blum.png', 'US')`);
  await db.execute(sql`insert into movie_title_companies (title_id, company_id, ord) values ('movie-467905', 3172, 0)`);
  await db.execute(sql`insert into movie_people (id, name, profile_path) values
    (1, 'John Patton Ford', null), (2, 'Glen Powell', '/glen.jpg'), (3, 'Margaret Qualley', '/mq.jpg')`);
  await db.execute(sql`insert into movie_credits (title_id, person_id, role, character, job, ord) values
    ('movie-467905', 1, 'director', null, 'Director', 0),
    ('movie-467905', 1, 'writer', null, 'Screenplay', 0),
    ('movie-467905', 2, 'cast', 'Becket', null, 0),
    ('movie-467905', 3, 'cast', 'Julia', null, 1)`);
  await db.execute(sql`insert into movie_episodes (title_id, season, episode, name, air_date, runtime_min, overview, still_path) values
    ('tv-247718', 1, 1, 'Stick or Twist', '2025-03-30', 50, null, '/e1.jpg'),
    ('tv-247718', 1, 2, 'Episode Two', '2025-04-06', 50, null, null),
    ('tv-247718', 1, 3, 'Episode Three', '2025-04-13', 50, null, null)`);

  const killingHere = await insertFile(db, {
    titleId: 'movie-467905', host: HOST_HERE, path: '/lib/How.to.Make.a.Killing.2026.1080p.mkv', durationS: 6000, status: 'matched',
  });
  const killingOther = await insertFile(db, {
    titleId: 'movie-467905', host: HOST_OTHER, path: '/other/How.to.Make.a.Killing.2026.1080p.mkv', durationS: 6000, status: 'matched',
  });
  const mobE1 = await insertFile(db, {
    titleId: 'tv-247718', host: HOST_HERE, path: '/lib/MobLand S01/MobLand.S01E01.mkv', durationS: 3000, season: 1, episode: 1,
    status: 'matched', deletedAt: '2026-11-12T00:00:00Z',
  });
  const mobE2 = await insertFile(db, {
    titleId: 'tv-247718', host: HOST_HERE, path: '/lib/MobLand S01/MobLand.S01E02.mkv', durationS: 3000, season: 1, episode: 2,
    status: 'matched',
  });
  const nezha2 = await insertFile(db, {
    titleId: null, host: HOST_HERE, path: '/lib/Nezha (2019)/Ne.Zha.2.2025.1080p.mkv', durationS: 8400, status: 'unmatched',
    reason: 'no_match',
    parsed: { title: 'Ne Zha 2', year: 2025, season: null, episode: null, absoluteEpisode: null, kindHint: 'movie' },
  });
  const pendingOther = await insertFile(db, {
    titleId: null, host: HOST_OTHER, path: '/other/Some.Film.2024.mkv', durationS: 5400, status: 'pending', reason: 'tmdb_error',
  });

  await insertPlay(db, killingHere, HOST_HERE, '2026-11-10T13:00:00Z', '2026-11-10T13:50:00Z', 3000, 6000);
  await insertPlay(db, mobE1, HOST_HERE, '2026-11-11T13:00:00Z', '2026-11-11T14:00:00Z', 2900, 3000);
  await insertPlay(db, mobE2, HOST_HERE, '2026-11-12T13:00:00Z', '2026-11-12T13:10:00Z', 600, 3000);

  return { killingHere, killingOther, mobE1, mobE2, nezha2, pendingOther };
}

export const NEZHA2_TMDB_ID = 980477;

/** What the fake TMDB knows about Ne Zha 2. Field names follow phase 1's TitleMetadata; adjust here if they differ. */
const NEZHA2: TitleMetadata = {
  kind: 'movie',
  tmdbId: NEZHA2_TMDB_ID,
  title: 'Ne Zha 2',
  originalTitle: 'Ne Zha 2',
  year: 2025,
  releaseDate: '2025-01-29',
  overview: 'Ne Zha and Ao Bing face a new trial.',
  posterPath: '/nezha2.jpg',
  backdropPath: null,
  runtimeMin: 144,
  genres: ['Animation'],
  seasonCount: null,
  episodeCount: null,
  companies: [],
  credits: [],
  episodes: [],
};

export const SEARCH_HITS: TmdbSearchHit[] = [
  { kind: 'movie', tmdbId: NEZHA2_TMDB_ID, title: 'Ne Zha 2', originalTitle: 'Ne Zha 2', releaseDate: '2025-01-29', year: 2025, overview: 'Sequel.', posterPath: '/nezha2.jpg', popularity: 50 },
  { kind: 'movie', tmdbId: 467905, title: 'How to Make a Killing', originalTitle: 'How to Make a Killing', releaseDate: '2026-02-20', year: 2026, overview: 'Heir.', posterPath: '/kill.jpg', popularity: 20 },
];

/** A TMDB that knows one film's details and answers every search with SEARCH_HITS. No network. */
export function fakeTmdb(): TmdbClient {
  const unused = (name: string) => (): Promise<never> => Promise.reject(new Error(`fake TMDB: ${name} is not used by these tests`));
  return {
    searchMovie: () => Promise.resolve(SEARCH_HITS),
    searchTv: () => Promise.resolve([]),
    movieDetails: (id: number) =>
      id === NEZHA2_TMDB_ID ? Promise.resolve(NEZHA2) : Promise.reject(new Error(`fake TMDB: no movie ${id}`)),
    tvDetails: unused('tvDetails'),
    searchPerson: unused('searchPerson'),
    personCredits: unused('personCredits'),
  };
}

import { sql } from 'drizzle-orm';
import type { Db } from '../../../src/db/client.js';
import { movieEpisodes, movieFiles, moviePlays, movieTitles } from '../../../src/db/schema.js';

export async function truncateMovies(db: Db): Promise<void> {
  await db.execute(
    sql`truncate table movie_plays, movie_files, movie_episodes, movie_credits, movie_title_companies, movie_people, movie_companies, movie_titles restart identity cascade`,
  );
}

export async function seedTitle(
  db: Db,
  t: { id: string; kind: 'movie' | 'tv'; tmdbId: number; title: string; year?: number | null; runtimeMin?: number | null; watchedAt?: Date | null },
): Promise<void> {
  const now = new Date();
  await db.insert(movieTitles).values({
    id: t.id,
    kind: t.kind,
    tmdbId: t.tmdbId,
    title: t.title,
    originalTitle: t.title,
    year: t.year ?? null,
    releaseDate: null,
    overview: '',
    posterPath: null,
    backdropPath: null,
    runtimeMin: t.runtimeMin ?? null,
    genres: [],
    seasonCount: null,
    episodeCount: null,
    watchedAt: t.watchedAt ?? null,
    rating: null,
    reviewNoteId: null,
    metadataFetchedAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

export async function seedEpisodes(db: Db, titleId: string, season: number, names: string[]): Promise<void> {
  await db.insert(movieEpisodes).values(
    names.map((name, i) => ({
      titleId,
      season,
      episode: i + 1,
      name,
      airDate: null,
      runtimeMin: null,
      overview: null,
      stillPath: null,
    })),
  );
}

export async function seedFile(
  db: Db,
  f: {
    titleId: string | null;
    host: string;
    path: string;
    durationS?: number | null;
    season?: number | null;
    episode?: number | null;
    deletedAt?: Date | null;
  },
): Promise<number> {
  const now = new Date();
  const [row] = await db
    .insert(movieFiles)
    .values({
      titleId: f.titleId,
      host: f.host,
      path: f.path,
      name: f.path.split('/').pop()!,
      size: 1024,
      mtime: now,
      durationS: f.durationS ?? 7200,
      season: f.season ?? null,
      episode: f.episode ?? null,
      absoluteEpisode: null,
      status: f.titleId === null ? 'unmatched' : 'matched',
      reason: null,
      parsed: null,
      source: 'scan',
      firstSeenAt: now,
      lastSeenAt: now,
      deletedAt: f.deletedAt ?? null,
      movedAt: null,
      doneAt: null,
      watchedAt: null,
      updatedAt: now,
    })
    .returning({ id: movieFiles.id });
  return row!.id;
}

export async function seedPlay(
  db: Db,
  p: { fileId: number; host: string; positionS: number | null; durationS: number | null; startedAt: Date; endedAt?: Date | null; source?: 'live' | 'vlc_recents' },
): Promise<number> {
  const [row] = await db
    .insert(moviePlays)
    .values({
      fileId: p.fileId,
      host: p.host,
      source: p.source ?? 'live',
      startedAt: p.startedAt,
      endedAt: p.endedAt === undefined ? p.startedAt : p.endedAt,
      startPositionS: 0,
      positionS: p.positionS,
      durationS: p.durationS,
      updatedAt: p.startedAt,
    })
    .returning({ id: moviePlays.id });
  return row!.id;
}
